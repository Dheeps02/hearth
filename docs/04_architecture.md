# Architecture & Algorithms

## System Architecture

```
┌──────────────────────────────────────────────────┐
│                 Renderer (Chromium)              │
│  BlockNote ⇄ Y.Doc   │  UI Shell  │  Graph WW    │
│  Y.UndoManager       │  DB Views  │              │
└───────────────────────┬──────────────────────────┘
                        │ Electron IPC (typed)
┌───────────────────────▼──────────────────────────┐
│                  Main Process                    │
│  Update log I/O  │  Projector  │  Asset manager  │
│  SQLite handler  │  GC         │  Exporter       │
└───────────────────────┬──────────────────────────┘
                        │ better-sqlite3
┌───────────────────────▼──────────────────────────┐
│  vault/updates/  (truth)                         │
│  vault.db        (projection)  local.db  assets/ │
└──────────────────────────────────────────────────┘
```

Editing happens against the Y.Doc in the renderer. SQLite is written by the projector in the main process and read for search, views and the tree. **The editor never writes to SQLite.**

---

## The CRDT Layer

### Document layout

One Y.Doc per page:

```ts
pageDoc.getXmlFragment('blocks')   // BlockNote binds here directly
pageDoc.getMap('meta')             // title, icon, cover, createdAt
pageDoc.getMap('props')            // property values, entries only
```

One Y.Doc per vault, holding everything that is not page content:

```ts
vaultDoc.getMap('tree')        // parentId → Y.Array<pageId>   (D011)
vaultDoc.getMap('databases')   // dbId → { typeId, typeSyncedAt }
vaultDoc.getMap('properties')  // propId → definition
vaultDoc.getMap('propOrder')   // dbId → Y.Array<propId>
vaultDoc.getMap('selectOptions')
vaultDoc.getMap('views')       // + filters, sorts, column config
vaultDoc.getMap('types')
vaultDoc.getMap('relations')   // relationId → Y.Array<[sourceId, targetId]>
vaultDoc.getMap('favorites')   // Y.Array<pageId>
vaultDoc.getMap('settings')    // vault-level settings
vaultDoc.getMap('versions')    // pageId → Y.Array<{ id, snapshot, label, createdAt }>
```

**Both docs are constructed with `gc: false`** (D017). Required for time travel; the cost is permanent tombstones, managed by D018.

### Why the tree lives in the vault doc

Page ordering is structural (D011). `tree` maps a parent ID to a `Y.Array` of child IDs. A `Y.Array` is a sequence CRDT — it resolves insertions and moves, not competing values for a field.

`parent_id` on `pages` is **derived from the tree**, not stored in page meta. One source of truth for hierarchy.

If ordering were stored as position strings in shared state, two devices independently rebalancing the same sibling list would each write four position fields, Yjs would resolve each field separately by client ID, and the result would be an order neither user chose. Because positions are local projections, this cannot happen.

### Where relation values live

In `vaultDoc.relations`, keyed by `relation_id` (D016), **not** in the entry's `props` map. A relation is a link between two entries; putting it on one side means the inverse write is a second operation that can diverge. One `Y.Array` per relation, holding pairs, keeps both directions a single op.

`pages.props` therefore has no relation entries. The `relations` table is projected from `vaultDoc.relations`.

---

## Sync (D003)

### Update logs

```
vault/updates/
  device-a1b2c3/       ← this device appends here, and only here
    vault.ybin
    <page-uuid>.ybin
  device-d4e5f6/       ← another device's log, read-only
```

Every device writes only to its own directory. No file has two writers, so iCloud, Dropbox, Syncthing and git all work without conflict handling.

`PROJECTOR_VERSION` is deliberately **not** here — it lives in `local.json` (D020). A synced marker makes upgraded and non-upgraded devices rebuild each other's databases in a loop.

### Three projection paths

They are frequently conflated. They have wildly different costs.

| Path | Trigger | Work | Cost, 5k pages / 200k blocks |
|---|---|---|---|
| **Incremental** | local edit | flatten + diff one page | single-digit ms |
| **Incoming** | another device's update lands | project the affected pages | bounded by what changed |
| **Full rebuild** | version bump, missing or corrupt DB, manual | materialise every doc, reproject everything | ~30–90s |

**A normal launch is none of these.** `vault.db` survives from the previous session and is already the projection. Startup opens it and applies only the update-log entries newer than what is already baked in — typically nothing, or one other device's recent edits.

Full rebuild is the uncommon path. It is also the *only* schema-change mechanism (D020), so it is deliberately kept fast and visible rather than rare and untested. See D020 for the UI contract and the three performance requirements that dominate its runtime.

### Startup

```
1. Read PROJECTOR_VERSION from local.json
   → mismatch: delete vault.db, full rebuild
2. Apply vault.ybin from every device directory → vaultDoc
3. Project vaultDoc into SQLite (tree, schema, views, relations)
4. Open the UI — the sidebar and DB views are now queryable
5. Page docs load lazily, on first open
```

Only the vault doc is loaded eagerly. It is small, and everything the shell renders before a page is opened — the tree, favorites, database schema — comes from it.

### Steady state

```
User edits
  → Y.Doc transaction (tagged with an origin — D015)
  → ydoc.on('update', ...) fires with the binary update
  → append to this device's log (batched, ~500 ms)
  → project the change into SQLite
```

The append and the projection are independent. If projection fails, the data is safe — reprojection fixes it.

### Incoming changes

A filesystem watcher on `updates/` detects other devices' appends, applies them, and projects. No merge UI: convergence is automatic.

### Log growth

Logs only grow. Compaction (`Y.mergeUpdates`) collapses many updates into one; policy in D018.

### Page document lifecycle

Page docs are loaded on demand and cached. Loading every page's log at launch would be slow at a few thousand pages and, with `gc: false` (D017), expensive in resident memory — tombstones are never freed, so a heavily edited page is larger in memory than its current content.

```
open page → doc in cache?      → bind editor
          → not cached?        → apply that page's *.ybin from every
                                 device dir → cache → bind editor
```

- **Cache policy:** LRU, bounded by count (start at ~50 docs) rather than bytes. Docs for open tabs are pinned and never evicted
- **Eviction is safe:** the doc's updates are already on disk. Evicting drops the in-memory materialisation, nothing else
- **Full rebuild is the exception.** It walks every page's log in sequence, projects, and releases the doc immediately. Peak memory stays at one page, not the vault

**Consequence for observers:** anything that watches `pageDoc` — the version-history hook (`08`), computed-property invalidation (`07`) — only fires for *loaded* docs. Changes arriving for an unloaded page are applied to the log and projected without materialising a doc. Recompute for those pages runs from SQL against the projection, which is why `_computed` is projection-only (D023). Nothing depends on every page being resident.

### Projecting the vault doc

`project()` above handles page content. The vault doc has its own projector, run on startup and on every `vaultDoc` update:

```ts
function projectVault(doc: Y.Doc) {
  db.transaction(() => {
    projectTree(doc.getMap('tree'))          // → pages.parent_id, pages.position
    projectDatabases(doc.getMap('databases'))
    projectProperties(doc.getMap('properties'), doc.getMap('propOrder'))
    projectSelectOptions(doc.getMap('selectOptions'))
    projectViews(doc.getMap('views'))        // → views, view_filters, view_sorts, view_properties
    projectTypes(doc.getMap('types'))
    projectRelations(doc.getMap('relations'))
    projectFavorites(doc.getMap('favorites'))
    projectVersionIndex(doc.getMap('versions'))
  })()
}
```

Write order matters — foreign keys are enforced (`03_schema.md`). Tree before databases, databases before properties, properties before views and select options.

`projectTree` is where `position` strings are generated (D011): walk each parent's `Y.Array`, assign evenly spaced base62 keys, write them to `pages`. The array is the truth; the strings are a sort key.

---

## The Projector

The projector is the only writer to `vault.db`. One-way, idempotent, and re-runnable from scratch at any time.

```ts
function project(update: Uint8Array, doc: Y.Doc, pageId: string) {
  const flat = flattenFragment(doc.getXmlFragment('blocks'), pageId)
  const { toInsert, toUpdate, toDelete } = diffBlocks(pageId, flat)

  db.transaction(() => {
    deleteBlocks(toDelete)
    insertBlocks(toInsert)
    updateBlocks(toUpdate)
    upsertPageMeta(pageId, doc.getMap('meta'), doc.getMap('props'))
    writeComputed(pageId)          // _computed — projection only, D023
    rebuildPageLinks(pageId, flat)
  })()
}
```

`flatten`, `diff` and `reconstruct` survive from the previous architecture. They changed job title: they were the write path, they are now the projector. Same code, different trigger.

### Flatten (Y.XmlFragment → SQL rows)

```ts
type FlatBlock = {
  id: string
  page_id: string
  parent_block_id: string | null
  type: string
  props: string
  content: string
  plaintext: string      // derived — D006
  has_link: 0 | 1
  position: string       // base62 fractional key — D010
  created_at: number     // copied from block attrs — D025
  updated_at: number     // copied from block attrs — D025
}
```

Recursive DFS over the fragment. Sibling positions are generated as evenly spaced base62 keys, regenerated per parent whenever that parent's children change. Because positions never leave the machine (D011), regenerating them freely is safe.

`created_at` and `updated_at` are read from the block's ydoc attributes, never generated here (D025). The editing device stamps them; the projector transports them. Generating them at projection time would restamp the whole vault on every rebuild.

`plaintext` is built by walking inline content, concatenating `text` nodes and mention **labels**, skipping UUIDs and style metadata.

**Complexity:** O(n), one visit per block.

### Reconstruct (SQL rows → Block[])

Two passes: build an id→block map, then attach children to parents and sort by position at each level.

Used for export, version preview and MCP — **not** for loading the editor. BlockNote binds to the fragment directly, so the read path no longer goes through SQLite.

Orphan rescue is retained: a block whose parent is missing is pushed to root rather than dropped. Under the CRDT this should be unreachable; if it fires, the projector has a bug.

**Complexity:** O(n log n).

### Diff

Compares the freshly flattened array against the in-memory cache for that page and emits minimal INSERT/UPDATE/DELETE sets. Unchanged from the previous design except that its input comes from the fragment rather than `onChange`.

Yjs already knows which blocks changed, so the diff is an optimisation rather than a correctness requirement. Keeping it means the projector is safe to run over a whole document at any time — which is what makes full rebuild possible.

### Validation

Runs before every projection write: orphan check, required fields, parseable JSON. A failure means the projector is wrong, so it logs loudly and skips the write. The ydoc is unaffected and the data is not at risk.

---

## Read Path

```
User opens page
  → load page Y.Doc (from cache, or apply its logs)
  → bind BlockNote to ydoc.getXmlFragment('blocks')
  → editor is live
```

No SQLite read. No reconstruct. No cache-miss branch.

**Provider stub.** BlockNote's `collaboration` option expects a provider supplying an awareness instance, even with no peers. There is no network transport here (D003), so it takes a local stub: a bare `Awareness` instance over the doc, no connection. Verify the exact expected shape against the installed BlockNote version before wiring it — the option is validated at editor construction, so a wrong shape fails loudly and early rather than silently.

Awareness becomes real when presence ships (D024). Nothing else changes.

SQLite serves search, DB views, the sidebar tree, backlinks and the graph — everything that is a *query* rather than a *document*.

---

## Search Path

```sql
SELECT b.id, b.page_id, p.title,
       snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 20)
FROM blocks_fts
JOIN blocks b ON blocks_fts.rowid = b.rowid
JOIN pages  p ON b.page_id = p.id
WHERE blocks_fts MATCH ?
  AND p.is_deleted = 0
  AND (? IS NULL OR b.type = ?)          -- type: facet
  AND (? IS NULL OR b.page_id IN (...))  -- in: facet
ORDER BY bm25(blocks_fts)
LIMIT 50;
```

FTS5 matches; ordinary indexed columns handle faceting. As-you-type appends `*` to the final term (D006).

Titles are queried separately and pinned above content results (D008):

```sql
SELECT id, title, icon FROM pages
WHERE is_deleted = 0 AND title LIKE ? || '%'
ORDER BY length(title) LIMIT 5;
```

---

## Undo (D015)

```ts
const undo = new Y.UndoManager(
  [pageDoc.getXmlFragment('blocks'), pageDoc.getMap('meta'), pageDoc.getMap('props')],
  { trackedOrigins: new Set(['editor']) }
)
```

One manager per surface, filtered by transaction origin. Every mutation tags its origin:

```ts
pageDoc.transact(() => { /* … */ }, 'sidebar')
```

Surfaces: `editor`, `sidebar`, `db-view`, `schema`.

Page deletion is soft, so undo restores it in place rather than sending the user to Trash.

Undo does not cross tabs.

---

## Data Integrity

Layers of defence, in order of importance:

1. **The CRDT is the truth.** Corruption in `vault.db` costs a rebuild
2. **Per-device logs, append-only.** No file ever has two writers
3. **Validation before projection.** A failure blocks the SQL write, never the ydoc
4. **SQLite transactions** — `better-sqlite3` transactions roll back on throw
5. **WAL mode** — crash-safe to the last committed transaction
6. **Backups target `updates/`** (D020), not the database. Copy the log directory on launch, keep N generations
7. **The plain-text mirror** (D014) is the last resort if the format itself fails

---

## Fractional Indexing (D010)

Base62 strings, not floats.

```
Append:     a0  a1  a2 … a9  aA … az  b00
Insert:     a0 → a1 becomes a0 → a0V → a1
Again:      a0 → a0V becomes a0 → a0F → a0V
```

One character buys 62 slots; bisecting 62 takes ~6 steps. So keys grow roughly one character per six insertions **into the identical gap**. Appending never grows them.

Floats fail hard at ~50 midpoints. Strings degrade linearly and never fail.

**Rebalance:** local reprojection only, never a synced write. Triggered per parent when `max(len) > 20 AND max(len) > 3 × median(len)` — one long key among 400 short ones does not justify rewriting 400 rows.

Sorting uses default BINARY collation. Never apply `COLLATE NOCASE` — base62 is case-sensitive.

---

## Asset Management

```
vault/assets/
  <sha256-prefix>.png
  <sha256-prefix>.pdf
```

Content-addressed by hash (O005 — confirm before implementing). Two devices adding the same image produce the same filename, so the file sync transport deduplicates for free and there is no rename conflict.

- On insert: hash, copy into `assets/`, store the relative path
- On delete: files are never removed immediately — the same asset may be referenced elsewhere
- GC scans for files unreferenced by any active block or `props` value

---

## Export (D014)

```
1. Walk the page tree from the vault doc
2. Per page: reconstruct Block[] → blocksToMarkdownLossy()
3. Write to MyVault_export/<mirrored path>.md
4. Databases → CSV per view, plus properties.json
5. Copy referenced assets
6. Full JSON dump alongside
```

Runs on a schedule in the main process, and on demand. Full rewrite each time. Writes to a **sibling directory outside the vault**, so GC and the page indexer never see it.

Conversion rules: `@page` mentions become relative links, DB embeds become a link to the database page, synced mirrors render resolved content.

---

## Garbage Collection

Runs on launch and on a timer:

```
1. Hard-delete pages where is_deleted = 1 and deleted_at older than the window
   → removes them from the ydoc; the projection follows
2. Prune auto-snapshots older than the window (labeled versions skipped)
3. Compact update logs with Y.mergeUpdates (D018)
4. Delete assets unreferenced by any active block or props value
5. Rebalance degenerate position keys (local only — D011)
```

Retention window: configurable, default 30 days. Stored in vault settings, so it syncs.

**Take a log backup before step 1 or 3.** They are the only steps that touch the source of truth.

---

## Extensibility Principle

> Every deferred feature leaves behind the architecture to support it. No layer gets reworked just to add a feature that was always on the roadmap.

The previous version of this document claimed collaboration satisfied this. It did not — collaboration was an inversion of what owns truth, not a layer, and that is why D002 moved it to day one. The principle survives; the counterexample was removed by adopting it.

Requirements for any deferred feature:

1. **Schema columns exist from day one.** Since the projection is disposable (D020), this matters less than it did — a rebuild is not a migration
2. **Stubbed interfaces.** The interception point exists as a no-op
3. **Architecture notes.** Each stub below is the implementation spec
4. **No assumptions of absence.** Nothing may assume a deferred feature will never exist

---

### Deferred Feature Stubs

#### Synced blocks

**CRDT:** the natural implementation is a shared `Y.XmlFragment` referenced by multiple pages, rather than copying content. `blocks.synced_source_id` remains for the projection so mirrors are identifiable in queries.

**Read hook:** in `reconstructBlocks()`, `resolveSyncedContent()` substitutes source content. Currently a no-op — `synced_source_id` is always null.

**Write hook:** with a shared fragment, writes go to the source automatically. No redirect layer is needed, which is a simplification over the pre-CRDT plan.

**Delete:** on source delete, prompt "delete everywhere" or "detach copies". Detach materialises the current content into each mirror as an independent fragment.

---

#### Formula properties

**Schema:** `type = 'formula'` is in the enum; `config` holds `{ expression, returnType }`.

**Eval hook:** `computeFormulas(entries, properties)` returns an empty map today. When it ships, it evaluates against same-row values from `props` and writes results into `props._computed`, exactly as Rollup and Lookup already do (D023). Formula therefore inherits SQL filtering and sorting for free.

**Evaluator is open (O004).** mathjs was provisionally chosen; a full CAS is more than this needs.

---

#### Chart view

**Schema:** `'chart'` is in the `views` type enum with config shape defined. Purely a new renderer over the existing view pipeline.

---

#### MCP server

**Interface:** the main process already exposes `getPage`, `writePage`, `queryDatabase`, `getRelations` to the IPC layer. MCP is an additional caller of the same functions.

**Serialisation:** `blocksToMarkdownLossy()` for reads. Writes parse markdown to blocks and apply them **as ydoc operations**, never as a SQL write.

---

#### Collaborative presence

Data convergence is solved (D002). What remains is awareness — cursors, selections, avatars — which needs a transport (`y-webrtc` or a relay) and UI. No schema impact.

`created_by` / `updated_by` ship with it. Under the CRDT, client IDs are already on every update, so authorship is recoverable from the log rather than requiring new columns.
