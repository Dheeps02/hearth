# SQLite Projection Schema

> **This database is derived.** It is a rebuildable projection of the Yjs update logs (D002, D020). Nothing here is unique. Deleting `vault.db` costs a rebuild, not data.

Consequences that shape every decision below:

- **No migration runner.** Schema changes bump `PROJECTOR_VERSION` — stored beside `local.db`, not in the synced update directory (D020) — which triggers a full rebuild on next launch.
- **Foreign keys are enforced.** `PRAGMA foreign_keys = ON`. The projector must write in dependency order: pages → blocks → databases → properties → everything else. A violation means the projector is wrong, which is exactly what enforcement is for.
- **Constraints catch projector bugs, not user error.** The CRDT guarantees referential sanity upstream; SQL constraints verify the projection preserved it.
- **`position` is a local projection** (D011). Never synced.
- **Authored timestamps come from the ydoc** (D025). The projector copies them, never generates them.

The authoritative CRDT layout lives in `04_architecture.md`.

---

## Conventions

- IDs are UUIDs, `TEXT`
- Timestamps are `INTEGER`, Unix epoch milliseconds
- Booleans are `INTEGER` 0/1
- `position` is `TEXT` — base62 fractional index, BINARY collation (D010)
- JSON columns are `TEXT`, accessed with `json_extract`

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
```

---

## pages

Everything is a page — regular pages, databases, and database entries.

```sql
CREATE TABLE pages (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES pages(id),
  type         TEXT NOT NULL,              -- 'page' | 'database'
  title        TEXT NOT NULL DEFAULT '',
  icon         TEXT,                       -- e.g. "lucide:star"
  cover        TEXT,                       -- e.g. "./assets/cover-uuid.png"
  position     TEXT NOT NULL,
  props        TEXT,                       -- JSON value map; null for non-entries
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX ix_pages_parent  ON pages(parent_id) WHERE is_deleted = 0;
CREATE INDEX ix_pages_title   ON pages(title) WHERE is_deleted = 0;
CREATE INDEX ix_pages_deleted ON pages(deleted_at) WHERE is_deleted = 1;
```

### Notes

- `parent_id` is the full hierarchy. Null means root
- Entries are `type = 'page'` with `parent_id` pointing at a database page
- `updated_at` advances only on content-bearing changes (D009) — not projection churn, cursor movement or view config edits
- `ix_pages_title` supports both the pinned title section (D008) and `LIKE 'foo%'` prefix matching
- `created_by` / `updated_by` deferred (D024)

### `props` — the value map (D004, D005)

Keyed by property UUID. Only set values are present; absent key means empty.

```json
{
  "a3f9-status":  { "option_id": "opt-done" },
  "b2c1-priority":{ "number": 3 },
  "c4d5-due":     { "start": 1754006400000, "end": null, "includeTime": false },
  "d6e7-tags":    { "option_ids": ["opt-1", "opt-2"] },
  "e8f9-files":   { "files": [{ "name": "doc.pdf", "path": "./assets/doc-uuid.pdf" }] },
  "_computed":    { "f0a1-rollup": { "number": 42 } },
  "_errors":      { "b2c1-priority": "conversion" }
}
```

Reserved keys:

- `_computed` — materialized Rollup and Lookup values (D023). Makes them filterable and sortable in SQL. **Projection-only** — written by the projector into this column, never present in `ydoc.getMap('props')`, because derived values must not sync (D011)
- `_errors` — per-cell flags, e.g. a failed datatype conversion (`09_types_templates.md`). Synced, since a conversion failure is a fact about the data, not a derivation

Relation values are **not** stored here — see `relations`.

The ydoc's `props` map therefore contains stored values and `_errors` only. `_computed` is added during projection.

### Value shapes by type

```
text | url | email | phone   { "text": "..." }
number                       { "number": 42 }
checkbox                     { "checked": true }
select                       { "option_id": "opt-uuid" }
multiselect                  { "option_ids": ["opt-1", "opt-2"] }
date                         { "start": <ms>, "end": <ms>|null, "includeTime": bool }
file                         { "files": [{ "name": "...", "path": "..." }] }
```

Dates are stored as epoch milliseconds so numeric comparison works in SQL without date parsing.

### Generated columns for hot properties (D004)

Added lazily, per property, when a view filters or sorts on it often:

```sql
ALTER TABLE pages ADD COLUMN gp_a3f9_status TEXT
  GENERATED ALWAYS AS (json_extract(props, '$."a3f9-status".option_id')) VIRTUAL;

CREATE INDEX ix_pages_gp_a3f9_status ON pages(gp_a3f9_status);
```

VIRTUAL costs no storage — the index does the work. Because the schema is disposable, adding and dropping these is free.

---

## blocks

```sql
CREATE TABLE blocks (
  id               TEXT PRIMARY KEY,
  page_id          TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_block_id  TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,
  props            TEXT NOT NULL DEFAULT '{}',
  content          TEXT NOT NULL DEFAULT '[]',
  plaintext        TEXT NOT NULL DEFAULT '',
  has_link         INTEGER NOT NULL DEFAULT 0,
  position         TEXT NOT NULL,
  synced_source_id TEXT REFERENCES blocks(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX ix_blocks_page   ON blocks(page_id, position);
CREATE INDEX ix_blocks_parent ON blocks(parent_block_id);
CREATE INDEX ix_blocks_type   ON blocks(page_id, type);
```

### No CHECK on `type`

Deliberate (D024 adds block types over time). SQLite cannot `ALTER` a CHECK constraint — changing it means rebuilding the table. Block types are validated in application code against the BlockNote schema, which is the real source of truth anyway.

Current values: `paragraph`, `heading`, `bulletListItem`, `numberedListItem`, `checkListItem`, `toggleListItem`, `quote`, `callout`, `code`, `table`, `image`, `video`, `audio`, `file`, `divider`, `math`, `toc`, `breadcrumb`, `embed`, `dbEmbed`, `columnList`, `column`, `synced`.

### Derived columns

Both computed during projection, never synced (D011):

- **`plaintext`** — concatenated text nodes plus mention labels. What FTS5 indexes (D006)
- **`has_link`** — 1 if content contains any link or mention. Powers the `has:link` search facet

### Timestamps are not derived (D025)

`created_at` and `updated_at` are **block attributes in the `Y.XmlFragment`**, copied through by the projector. They are not generated at projection time.

If they were, every full rebuild would restamp the entire vault with the rebuild date — and rebuild is the sync path, not an exceptional recovery step. The `before:` and `after:` search facets in `10_navigation.md` depend on these being real.

### FTS5 index (D006)

```sql
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  plaintext,
  content='blocks',
  content_rowid='rowid',
  prefix='2 3',
  tokenize="porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER blocks_fts_insert AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, plaintext) VALUES (new.rowid, new.plaintext);
END;

CREATE TRIGGER blocks_fts_update AFTER UPDATE OF plaintext ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, plaintext) VALUES ('delete', old.rowid, old.plaintext);
  INSERT INTO blocks_fts(rowid, plaintext) VALUES (new.rowid, new.plaintext);
END;

CREATE TRIGGER blocks_fts_delete AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, plaintext) VALUES ('delete', old.rowid, old.plaintext);
END;
```

`prefix` and `tokenize` are **fixed at create time**. Changing either requires dropping and reindexing.

The update trigger is scoped `AFTER UPDATE OF plaintext`. An unscoped trigger fires on every column change, so reordering a page — which rewrites `position` on every sibling — would reindex the whole page for no reason.

### Props JSON examples

```json
// heading
{ "level": 1, "textColor": "red", "backgroundColor": "default" }
// callout
{ "icon": "lucide:lightbulb", "backgroundColor": "yellow" }
// code
{ "language": "typescript" }
// image
{ "url": "./assets/image-uuid.png", "caption": "My diagram", "width": 800 }
// column  (flex-grow ratio, not pixels — D013)
{ "width": 0.8 }
// dbEmbed
{ "database_id": "db-uuid", "view_id": "view-uuid" }
```

### Content JSON example

```json
[
  { "type": "text", "text": "Hello ", "styles": { "bold": true } },
  { "type": "mention", "attrs": { "type": "page", "id": "page-uuid", "label": "My Page" } }
]
```

Projected `plaintext` for the above: `Hello My Page`.

---

## databases

```sql
CREATE TABLE databases (
  id             TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  type_id        TEXT REFERENCES types(id),
  type_synced_at INTEGER
);
```

- `type_id` is **nullable** (D019). A database need not come from a type
- `type_synced_at` records when the user last applied updates from the type. Availability is computed by diffing on demand, never stored
- Deleting a database soft-deletes its entries

---

## types

```sql
CREATE TABLE types (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('system', 'user')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`derived` is removed (D019) — it existed only to keep every database linked to something.

---

## type_properties

```sql
CREATE TABLE type_properties (
  id       TEXT PRIMARY KEY,
  type_id  TEXT NOT NULL REFERENCES types(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  type     TEXT NOT NULL,
  config   TEXT,
  is_core  INTEGER NOT NULL DEFAULT 0,
  position TEXT NOT NULL
);

CREATE INDEX ix_typeprops_type ON type_properties(type_id, position);
```

`is_core = 1` marks app-defined properties on system types. Locked against rename and delete; user additions to a system type are fully editable.

No data-integrity columns here — required, defaults and uniqueness are database-level concerns.

---

## properties

```sql
CREATE TABLE properties (
  id               TEXT PRIMARY KEY,
  database_id      TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  type_property_id TEXT REFERENCES type_properties(id),
  system_key       TEXT,   -- 'title' | 'created_at' | 'updated_at' | null
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN (
                     'text', 'number', 'checkbox', 'url', 'email', 'phone',
                     'select', 'multiselect', 'date', 'file',
                     'relation', 'rollup', 'lookup', 'formula'
                   )),
  config           TEXT,
  position         TEXT NOT NULL,
  is_required      INTEGER NOT NULL DEFAULT 0,
  default_val      TEXT,
  is_unique        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_props_db ON properties(database_id, position);
CREATE UNIQUE INDEX ux_props_system ON properties(database_id, system_key)
  WHERE system_key IS NOT NULL;
```

### `system_key` replaces `is_system` (D009)

Identifying Title by name breaks when the user renames it. `system_key` is stable and self-documenting, and the partial unique index guarantees exactly one of each per database.

`created_at` and `updated_at` are **not** in the type enum. They are system columns, surfaced through the resolver in `06_db_views.md`.

`formula` remains in the enum though deferred — the column type exists so no rebuild is needed when it ships.

### System properties per database

```
{ system_key: 'title',      name: "Title",      type: 'text',   position: "a0" }
{ system_key: 'created_at', name: "Created at", type: 'date',   position: "a1" }
{ system_key: 'updated_at', name: "Updated at", type: 'date',   position: "a2" }
```

Renameable, not deletable.

### Config JSON by type

```json
// number
{ "format": "integer" | "decimal" | "currency" | "percentage" }

// date
{ "includeTime": true, "isRange": false }

// file
{ "allowedTypes": ["image", "pdf", "any"] }

// relation  (D016)
{ "relation_id": "rel-uuid",
  "target_database_id": "db-uuid",
  "is_two_way": true,
  "inverse_property_id": "prop-uuid",
  "is_directional": false }

// rollup
{ "relation_property_id": "uuid", "target_property_id": "uuid", "function": "sum" }

// lookup
{ "relation_property_id": "uuid", "target_property_id": "uuid" }

// formula (deferred)
{ "expression": "...", "returnType": "text" | "number" | "boolean" | "date" }
```

---

## property_conditions

```sql
CREATE TABLE property_conditions (
  id                    TEXT PRIMARY KEY,
  property_id           TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  condition_property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  operator              TEXT NOT NULL CHECK (operator IN (
                          'equals', 'not_equals', 'contains',
                          'not_contains', 'is_empty', 'is_not_empty'
                        )),
  value                 TEXT
);

CREATE INDEX ix_propcond_prop ON property_conditions(property_id);
```

Pure presentation — visibility only. Never filters the query.

---

## select_options

```sql
CREATE TABLE select_options (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  color            TEXT,
  position         TEXT NOT NULL,
  parent_option_id TEXT REFERENCES select_options(id)
);

CREATE INDEX ix_selopt_prop   ON select_options(property_id, position);
CREATE INDEX ix_selopt_parent ON select_options(parent_option_id);
```

`parent_option_id` drives dependent selects: Type = "Bug" shows Severity options, Type = "Feature" shows Priority options.

`position` orders the option list in pickers. Board **column** order is separate and lives in view config (`06_db_views.md`) — a view-level concern, not a schema-level one.

---

## relations

Keyed by `relation_id`, not `property_id` (D016).

```sql
CREATE TABLE relations (
  id          TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL,
  source_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  position    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_relations   ON relations(relation_id, source_id, target_id);
CREATE INDEX        ix_rel_src     ON relations(relation_id, source_id);
CREATE INDEX        ix_rel_tgt     ON relations(relation_id, target_id);
```

Two indexes because two-way traversal reads both directions.

### Why `relation_id`

A two-way relation is two property rows with different UUIDs — "Project" on Tasks, "Tasks" on Projects. Keying on `property_id` meant the inverse side matched nothing. Both properties carry the same `relation_id` in config; one-way relations have a single property pointing at it.

```sql
-- non-directional: everything linked to entry X
SELECT target_id FROM relations WHERE relation_id = ? AND source_id = ?
UNION
SELECT source_id FROM relations WHERE relation_id = ? AND target_id = ?;

-- directional (sub-items): children only
SELECT target_id FROM relations WHERE relation_id = ? AND source_id = ?;
```

Self-referential relations **must** set `is_directional`, or parents and children come back indistinguishable.

`position` supports link ordering — see O003.

---

## views

```sql
CREATE TABLE views (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'table', 'board', 'gallery', 'timeline', 'calendar', 'chart'
              )),
  config      TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  position    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX ix_views_db ON views(database_id, position);
CREATE UNIQUE INDEX ux_views_default ON views(database_id) WHERE is_default = 1;
```

`chart` stays in the enum though the view is deferred (D024) — closed enum, cheap to keep.

Config shapes per view type are in `06_db_views.md`.

---

## view_filters

```sql
CREATE TABLE view_filters (
  id           TEXT PRIMARY KEY,
  view_id      TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  filter_group TEXT NOT NULL DEFAULT 'default',
  operator     TEXT NOT NULL CHECK (operator IN (
                 'equals', 'not_equals', 'contains', 'not_contains',
                 'greater_than', 'less_than', 'is_empty', 'is_not_empty',
                 'before', 'after'
               )),
  value        TEXT,
  position     TEXT NOT NULL
);

CREATE INDEX ix_vfilters_view ON view_filters(view_id, filter_group, position);
```

Conditions sharing a `filter_group` are AND'ed. Groups are OR'ed at the top level.

---

## view_sorts

```sql
CREATE TABLE view_sorts (
  id          TEXT PRIMARY KEY,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('asc', 'desc')),
  position    TEXT NOT NULL
);

CREATE INDEX ix_vsorts_view ON view_sorts(view_id, position);
```

---

## view_properties

```sql
CREATE TABLE view_properties (
  id          TEXT PRIMARY KEY,
  view_id     TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  is_visible  INTEGER NOT NULL DEFAULT 1,
  width       INTEGER,
  position    TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_vprops ON view_properties(view_id, property_id);
CREATE INDEX ix_vprops_view   ON view_properties(view_id, position);
```

---

## page_links

Graph edges and backlinks. Populated during projection.

```sql
CREATE TABLE page_links (
  id              TEXT PRIMARY KEY,
  source_page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_block_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('mention', 'embed', 'relation')),
  created_at      INTEGER NOT NULL
);

CREATE INDEX ix_links_src ON page_links(source_page_id);
CREATE INDEX ix_links_tgt ON page_links(target_page_id);
```

Sources: `@page` mentions in block content, DB embed blocks, relation values.

Fully derived (D011) — rebuilt from scratch on reprojection, never synced.

---

## versions

```sql
CREATE TABLE versions (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  snapshot    BLOB NOT NULL,   -- Y.snapshot() bytes
  label       TEXT,            -- null = auto, non-null = user-labeled
  created_at  INTEGER NOT NULL
);

CREATE INDEX ix_versions_page ON versions(page_id, created_at DESC);
CREATE INDEX ix_versions_auto ON versions(created_at) WHERE label IS NULL;
```

A Yjs snapshot is a state vector plus delete set — kilobytes, not a document copy (D017).

**This table is the one exception to "SQLite is disposable."** Snapshots must survive reprojection, so they are written back into the update log as vault-level metadata. See `08_version_history.md`.

---

## favorites

```sql
CREATE TABLE favorites (
  id       TEXT PRIMARY KEY,
  page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  position TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_favorites ON favorites(page_id);
```

---

## tabs

Device-local (D021). Never synced.

Lives in a **separate SQLite file** (`local.db`), so it survives reprojection.

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
CREATE INDEX ix_tabs_pos          ON tabs(position);
```

**No foreign keys.** SQLite cannot reference across database files, and `tabs` is in `local.db` while `pages` is in `vault.db`. Dangling `page_id` values are expected and handled as tombstone tabs (`10_navigation.md`).

The partial unique index enforces exactly one active tab in the database rather than in application code. Scope is the vault, since a vault is a workspace (D026).

---

## tree_collapse

Also device-local, also in `local.db`. Sidebar collapse state is a per-machine viewing preference, not vault content.

```sql
CREATE TABLE tree_collapse (
  page_id      TEXT PRIMARY KEY,
  is_collapsed INTEGER NOT NULL DEFAULT 0
);
```

Absent row means expanded. Rows for deleted pages are harmless and swept on launch.

---

## Settings

No settings table.

- **Vault-level** (retention window, cascade behaviour, export schedule) — vault ydoc, so they sync
- **Device-level** (theme, window bounds, sidebar width, recent vaults, `PROJECTOR_VERSION`) — `local.json`, beside `local.db`

---

## Full Table List

```
vault.db  (disposable projection)
  pages                everything is a page; carries props value map
  blocks               block rows + derived plaintext
  blocks_fts           FTS5 virtual table over plaintext
  databases            database metadata + type provenance
  types                reusable property schemas
  type_properties      template properties per type
  properties           live schema per database
  property_conditions  conditional visibility rules
  select_options       select/multiselect options + dependent selects
  relations            entry links, keyed by relation_id
  views                named views per database
  view_filters         filter rules (+ groups for OR logic)
  view_sorts           sort rules
  view_properties      column visibility, width, order
  page_links           graph edges
  versions             snapshot index (mirrored into the update log)
  favorites            pinned pages

local.db  (device-local, survives reprojection)
  tabs                 open tabs, active tab
  tree_collapse        sidebar collapse state per page
```

16 tables plus one virtual in the projection. Two tables device-local.

**Removed from the previous schema:**

- `property_values` — replaced by `pages.props` (D004)
- `property_sync_status` — removed with automatic type propagation (D019)
- `workspaces` — a vault is a workspace (D026)
