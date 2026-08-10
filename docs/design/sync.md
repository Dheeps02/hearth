# Sync

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

## Data Integrity

Layers of defence, in order of importance:

1. **The CRDT is the truth.** Corruption in `vault.db` costs a rebuild
2. **Per-device logs, append-only.** No file ever has two writers
3. **Validation before projection.** A failure blocks the SQL write, never the ydoc
4. **SQLite transactions** — `better-sqlite3` transactions roll back on throw
5. **WAL mode** — crash-safe to the last committed transaction
6. **Backups target `updates/`** (D020), not the database. Copy the log directory on launch, keep N generations
7. **The plain-text mirror** (D014) is the last resort if the format itself fails
