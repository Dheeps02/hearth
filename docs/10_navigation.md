# Navigation System Design

Tabs, command palette, vault switching, sidebar and trash. Logic and data model; visual implementation is separate.

---

## Tabs

Everything opens as a tab — pages, graph, settings, any future full-page surface. No special casing. Unlimited, no cap.

### Device-local (D021)

Tabs live in `local.db`, not in the ydoc and not in `vault.db`.

Your laptop's open tabs are not your desktop's. Syncing them would mean one device reordering another's session mid-use — the same class of problem as syncing position strings (D011).

Because `local.db` is separate, tabs survive reprojection.

```sql
CREATE TABLE tabs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('page', 'graph', 'settings')),
  page_id      TEXT,
  position     TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_tab_active ON tabs(is_active) WHERE is_active = 1;
```

The partial unique index enforces exactly one active tab in the database rather than in application code. One vault is open at a time (D026), so the scope is the whole file.

`page_id` has no foreign key — `local.db` and `vault.db` are separate files, and SQLite cannot reference across databases. Dangling IDs are expected and handled by the tombstone behaviour below.

Full DDL, plus the device-local `tree_collapse` table, is in `03_schema.md`.

### Behaviours

**Opening a page already open** — focus the existing tab, matched on `page_id`. No duplicates.

**Page deleted** — the tab stays open in a tombstone state: "This page has been deleted." Closeable normally, never force-closed. This also covers a page deleted on **another device** and arriving through sync.

**Page deleted, then undone** (D015) — the tombstone tab reactivates. The page is soft-deleted, so its ID is still valid.

**Last tab closed** — blank splash. No auto-navigation.

**Reordering** — drag, base62 fractional keys (D010). Rebalance is local, which tabs already are.

**Session restore** — on opening the vault, load its tabs by `position`, activate the previously active one. Tabs whose `page_id` no longer resolves open as tombstones.

---

## Command Palette

Keyboard-first global search and action surface, covering the open vault.

### Results

Two sections, not one ranked list (D008):

**Pinned — page titles**

```sql
SELECT id, title, icon FROM pages
WHERE is_deleted = 0 AND title LIKE ? || '%'
ORDER BY length(title)
LIMIT 5;
```

**Below — block content**

```sql
SELECT b.id, b.page_id, p.title, p.icon,
       snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 20)
FROM blocks_fts
JOIN blocks b ON blocks_fts.rowid = b.rowid
JOIN pages  p ON b.page_id = p.id
WHERE blocks_fts MATCH ?
  AND p.is_deleted = 0
ORDER BY bm25(blocks_fts)
LIMIT 50;
```

Titles are a column on `pages`, not an FTS table, so the two cannot share a scoring space. Pinning titles above content is both simpler and better ordering — a title match should outrank a body match unconditionally. Notion and Linear both do this.

`snippet()` returns readable text because the index holds derived plaintext, not JSON (D006).

As-you-type appends `*` to the final term; `prefix='2 3'` makes that a direct lookup.

### Facets

Discord-style, parsed from the query string and applied as ordinary WHERE clauses — not FTS syntax:

| Facet | Resolves to |
|---|---|
| `type:heading` | `b.type = 'heading'` |
| `in:"Project X"` | `b.page_id IN (recursive CTE over the subtree)` |
| `has:image` | `b.type IN ('image','video')` |
| `has:file` | `b.type = 'file'` |
| `has:link` | `b.has_link = 1` |
| `before:2026-08-01` | `b.updated_at < ?` |
| `after:2026-07-01` | `b.updated_at > ?` |

FTS5 matches and hands back rowids; indexed columns do the rest.

`before:` and `after:` read `blocks.updated_at`, which is copied from the ydoc rather than generated during projection (D025). Were it generated, every "Rebuild" would reset these facets to the rebuild date.

Filtering or sorting by Title, Created at or Updated at goes through the property resolver (D009, `06_db_views.md`), not through `props`.

### Actions

Listed below results, filtered by the query:

| Action | Trigger |
|---|---|
| Create new page | "New page" |
| Create new database | "New database" |
| Open graph view | "Graph" |
| Open settings | "Settings" |
| Open another vault | "Open vault" |
| Export vault | "Export" |
| Rebuild index | "Rebuild" |

"Rebuild" reprojects `vault.db` from the update logs (D020). Exposing it is deliberate — it is the recovery path for anything that looks wrong, and being routinely used keeps it working.

It is also not instant: tens of seconds on a large vault. It runs behind a blocking splash with a determinate progress bar and phase labels, and the copy must say the data is safe — a progress bar with no explanation, on a tool whose pitch is data ownership, reads like data loss. Full contract in D020.

### Navigation

A block result opens its page and scrolls to `page#block-id`. A page result opens in the current tab, or a new one with a modifier key.

Search covers the open vault. Searching across vaults is not planned — separate vaults are separate by design (D026).

---

## Vault Switching (D026)

A vault is a directory. Opening a different one is the switch — there is no in-app workspace concept.

**One window per vault.** Opening a second vault opens a second window rather than replacing the current one, so two contexts can sit side by side. Same model as Obsidian.

**What opening a vault does:** read `local.json` for the projector version, open or rebuild `vault.db`, load `vaultDoc`, restore that vault's tabs from its `local.db`. Typically 200–400ms (D020).

**Recent vaults** are listed in `local.json` and surfaced on the splash screen and in the palette.

**No links across vaults.** A relation, mention or embed cannot cross a vault boundary. This is the point of the boundary — soft separation is what the page tree is for.

**Sync is configured per vault**, which is the main thing this buys: a work vault in Dropbox and a personal vault that never leaves the machine.

---

## Sidebar

Three sections, covering the open vault.

```
[Vault name]
─────────────────
⭐ Favorites
─────────────────
📁 Pages (tree)
─────────────────
🗑 Trash
```

No Recents section.

### Favorites

From `favorites` joined to `pages`. Drag to reorder.

Order lives in `vaultDoc.favorites` as a `Y.Array` (D011); `favorites.position` is the local projection.

### Page tree

All non-deleted pages, ordered within each parent level.

- Infinite nesting
- Drag to reorder and to reparent
- Collapsible nodes (collapse state is device-local — `tree_collapse` in `local.db`, not the ydoc)
- Manual order by default; alphabetical configurable per section
- Databases render with a distinct icon

Structure and order both come from `vaultDoc.tree` — a map of parent ID to a `Y.Array` of child IDs. Reparenting moves an ID between arrays, which is a sequence CRDT operation and converges cleanly. `pages.parent_id` and `pages.position` are both projections of that array.

### Trash

Soft-deleted pages, sorted by `deleted_at` descending.

**Restore:** `is_deleted = 0`, `deleted_at` cleared.

- Parent active → restore there
- Parent null or also deleted → restore to root

No prompt, no modal.

**Restoring a database entry** whose parent database was deleted currently lands it at root as an entry carrying property values with no schema. Unresolved — O002. Candidate rules: restore the parent database alongside it, or convert it to a plain page and preserve values in a read-only block.

**Cascade on parent delete:** global setting, default orphan children to root. Alternative: cascade all children into trash. Stored in vault settings, so it syncs.

**Undo (D015)** covers deletion directly — the user should rarely need Trash for a mistake made seconds ago. Trash is for finding something a week later.

---

## Settings Surface

No settings table (`03_schema.md`).

**Vault settings** — `vaultDoc.settings`, synced. Retention window, cascade behaviour, export schedule and destination, alphabetical sort preferences.

**Device settings** — JSON file beside `local.db`. Theme, window bounds, sidebar width, recent vaults, tree collapse state.

The split follows one rule: if two devices would disagree and that disagreement is correct, it is device state.

---

## Post-1.0

- Tab groups and split view
- Pinned tabs
- Custom palette shortcuts and aliases
- Multiple windows onto the same vault
