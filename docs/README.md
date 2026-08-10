# Hearth Docs

Hearth is a local-first personal knowledge tool combining Notion's flexibility and block editing with Obsidian's data ownership. Relational databases and rich blocks, stored locally, syncable across your own devices without a server. The app has no opinion on how you use it — it provides the primitives (blocks, pages, databases, relations) and gets out of the way.

## Reading order

For someone new to the project: [`overview.md`](overview.md) → [`scope.md`](scope.md) → [`decisions.md`](decisions.md) → design docs as needed.

## Documents

| Document | Description |
|----------|-------------|
| [overview.md](overview.md) | Project philosophy, motivations and tech stack |
| [scope.md](scope.md) | v1 feature scope with per-feature detail |
| [decisions.md](decisions.md) | Architectural decision log — single source of truth |
| [reference/schema.md](reference/schema.md) | SQLite projection schema (full DDL) |
| [reference/crdt.md](reference/crdt.md) | Yjs CRDT document layout |
| [reference/fractional-indexing.md](reference/fractional-indexing.md) | Base62 fractional indexing algorithm |
| [design/sync.md](design/sync.md) | System architecture, sync model and data integrity |
| [design/projector.md](design/projector.md) | The projection engine (flatten, diff, reconstruct) |
| [design/editor.md](design/editor.md) | Read path and global undo |
| [design/search.md](design/search.md) | FTS5 search query |
| [design/navigation.md](design/navigation.md) | Tabs, command palette, vault switching and sidebar |
| [design/databases.md](design/databases.md) | DB views, query strategy and view types |
| [design/computed-props.md](design/computed-props.md) | Rollup, Lookup and Formula evaluation |
| [design/version-history.md](design/version-history.md) | Snapshot creation, session logic and restore |
| [design/types.md](design/types.md) | DB types as reusable starting-point schemas |
| [design/graph.md](design/graph.md) | Graph view (force simulation, Canvas 2D, queries) |
| [design/assets.md](design/assets.md) | Asset storage and GC integration |
| [design/export.md](design/export.md) | Export pipeline (Markdown mirror and JSON dump) |
| [design/gc.md](design/gc.md) | Garbage collection |
| [design/deferred.md](design/deferred.md) | Extensibility principle and deferred feature stubs |

## Conventions

- **`decisions.md` is the single source of truth.** If a design document contradicts it, the decision log wins.
- **Design documents reference decision IDs and never restate rationale.** If the why is in the decision log, the design doc cites the ID.
- **Decisions are append-only.** Superseding an entry means adding a new one and marking the old one `superseded`, never editing it in place.
- **Filenames are stable and carry no numeric prefix.** Reading order lives here, not in the names.
