# Feature Scope

Scope boundary is defined in D024. This document details what is in.

---

## Block Editor

### Block Types (v1)

- Paragraph
- Heading (H1–H6, toggleable)
- Bullet list, Numbered list, Checklist, Toggle list
- Quote
- Callout (custom BlockNote block)
- Divider (custom BlockNote block)
- Code block (syntax highlighting)
- Table
- Image, Video, Audio, File
- Math / equation (KaTeX)
- Table of contents (auto-generated from headings)
- Breadcrumb (page location in hierarchy)
- Embed (any URL — oEmbed → iframe → bookmark fallback)
- Inline DB embed (linked view of a database)
- `columnList` / `column` — from `@blocknote/xl-multi-column` (D013)

Synced blocks are deferred. Schema and read/write hooks exist (`design/deferred.md`).

### Multi-Column

Provided by `@blocknote/xl-multi-column`. Drag-to-split, resize and cleanup all come for free. Remaining work is visual.

Two constraints (D013):

- Width is a flex-grow **ratio**, not pixels. Do not build a pixel resize UI over it.
- Animate with CSS `transform` during drag; commit the `width` prop on release. Animating the prop directly causes ProseMirror to re-render the node view mid-transition. No layout-animation libraries inside the editor.

Safe to animate freely: hover states, drop cursors, column insert/remove.

### Block Interactions

- Drag and drop reordering
- Slash commands (block types plus actions like "create DB", "link to page")
- Block colours — text and background per block
- Block-level linking — `page#block-id`
- Nested blocks

### Inline Content

- `@page` mentions
- `@date` mentions
- `@person` mentions (Person-type DB entries)

Mention **labels** are indexed for search; mention UUIDs are not (D006).

### Page Features

- Title (stored in page meta, outside the block fragment)
- Icon (from a provided icon set, e.g. Lucide)
- Cover image (local file in `assets/`)
- Subpages (infinite nesting)
- Page templates (stored pages used as starting points)
- Version history (`design/version-history.md`)

---

## Undo (D015)

Global, not editor-only. `Y.UndoManager` covers block content, page metadata, property values and database schema through one mechanism.

Scoped per surface by transaction origin — `editor`, `sidebar`, `db-view`, `schema`. Cmd+Z in the editor never rewinds a sidebar drag. Undo does not cross tabs.

Covered: page deletion, property type changes, timeline bar drags, select-option removal, sidebar reordering, applying a type update.

---

## Navigation

- **Tree sidebar** — hierarchical, collapsible
- **Tabs** — browser-style, device-local (D021)
- **Command palette** — fuzzy search, keyboard-first
- **Vaults** — one open at a time, one window each (D026)

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

Full behaviour in `design/navigation.md`.

---

## Search

- FTS5 over derived block plaintext (D006)
- Prefix matching for as-you-type (D006)
- English stemming (D007)
- Page titles as a pinned section above content hits (D008)
- Facets: `type:`, `in:`, `has:`, `before:`, `after:` — plain WHERE clauses on the base table, not FTS syntax
- Block-level results navigate to `page#block-id`

---

## Databases

### Core Model

- A database is always its own page
- Inline embeds are a *view* of that database page, not a separate entity
- Every entry is a page with block content plus a `props` value map (D004, D005)
- Sub-items via a self-referential relation, marked directional (D016)

### Views

Table · Board · Gallery · Calendar · Timeline

Chart is deferred (D024).

### Properties (v1)

| Property | Notes |
|---|---|
| Text | |
| Number | integer, decimal, currency, percentage |
| Checkbox | |
| URL | |
| Email | |
| Phone | |
| Select | options in `select_options` |
| Multi-select | options in `select_options` |
| Date | optional time, optional range |
| Files & Media | local paths in `assets/` |
| Relation | one-way or two-way, cross-DB, keyed by `relation_id` (D016) |
| Rollup | aggregates through a relation |
| Lookup | pulls a value from related records |

Formula is deferred (D024).

`created_at` and `updated_at` are **not** property types (D009). They are system columns exposed through the resolver.

### System Properties

Auto-created on every database, identified by `system_key` rather than name:

- Title (`system_key = 'title'`) — position 1, undeletable, renameable
- Created at (`system_key = 'created_at'`) — undeletable
- Updated at (`system_key = 'updated_at'`) — undeletable

`updated_at` advances only on content-bearing changes (D009).

### Data Integrity

- Required properties
- Default values, per property and type-specific
- Field validation (format hints for email, phone, URL)
- Unique constraint, enforced at application level
- Conditional properties — show/hide based on another property's value
- Dependent selects — options filtered by a parent select's value

### Saved Views

Named, persistent, each with independent filters, sorts, grouping, column visibility, width and order. One default view per database.

### Types (D019)

Types are reusable property schemas used as **starting points**.

- Two kinds: `system` (shipped) and `user` (created explicitly)
- A database records which type it came from. The link is provenance
- Type changes never push, never prompt, never auto-apply
- The database surfaces a quiet "updates available" affordance; the user opens a diff and chooses
- A database can have no type at all

Full behaviour in `design/types.md`.

---

## Graph View

- Nodes are pages, edges are mentions, embeds and relations
- Data from `page_links` and `relations`, both populated during projection
- Block-level edge precision via `source_block_id`
- `d3-force` simulation in a Worker, Canvas 2D rendering (D022)
- Local (side panel) and global (full-page tab) modes

Full design in `design/graph.md`.

---

## Sync (D003)

- Per-device append-only Yjs update logs
- Any file-sync transport: iCloud, Dropbox, Syncthing, git
- No server, no account, no subscription
- No conflict UI — CRDT convergence is automatic
- Offline by default; sync is a filesystem side effect

Collaborative *presence* — live cursors, avatars, comments — is deferred. The data layer supports it.

---

## Export (D014)

Ships in v1.

- **Markdown mirror** — one file per page, directory structure mirroring the page tree, assets copied. Databases additionally emit one CSV per view plus a `properties.json` describing the schema. Lossy: relations, rollups and column layouts do not survive
- **Full JSON dump** — complete and lossless
- **Scheduled background export** to a sibling directory outside the vault. Full rewrite each run. Not a sync target, and the UI says so

Markdown conversion rules:

- `@page` mentions → relative links
- DB embeds → link to the database page
- Synced block mirrors → resolved content inline

CSV import is deferred.

---

## Version History

- Snapshots at session boundaries — 5 min inactivity, or 15 min of continuous editing
- `Y.snapshot()` blobs, not document copies (D017)
- Property values and schema included automatically
- User-labeled versions kept indefinitely; auto-snapshots pruned after the retention window
- Restore applies a diff as operations, never a full replace (D017)

Full design in `design/version-history.md`.
