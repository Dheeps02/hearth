# Decision Log

Single source of truth for architectural decisions. Design docs reference entries here rather than restating rationale. If a doc contradicts this file, this file wins.

**Status values:** `active` — in force. `superseded` — replaced, see the superseding entry. `open` — not yet decided.

---

## D001 — Desktop shell: Electron
**Status:** active · **Supersedes:** Tauri, Electrobun

Electron + `better-sqlite3`. Bun retained as the build tool only.

Electrobun was rejected on review: it defaults to system WebViews (WebKit / WebView2 / WebKitGTK), which is the exact cross-platform rendering inconsistency that caused Tauri to be rejected in the first place. CEF bundling is an opt-in escape hatch that reintroduces Chromium — at which point Electron is the mature version of the same thing. The framework reached v1 in February 2026 and the ecosystem is still thin.

The performance case for Bun does not apply here. Every hot path runs in the renderer's V8: BlockNote/ProseMirror, React, the CRDT→SQL projector, the D3 force simulation. The backend is a thin RPC shim over prepared statements. SQLite performance is identical between `bun:sqlite` and `better-sqlite3` — both are thin synchronous bindings over the same C library.

Bundle size and idle memory are explicitly not project goals.

---

## D002 — Yjs is the source of truth
**Status:** active · **Supersedes:** SQLite-as-truth, "collab slots in later"

Y.Doc is authoritative. `vault.db` is a disposable, rebuildable projection.

The previous plan treated collaboration as a layer to be added later. It is not a layer — it is an inversion of what owns truth. Under Yjs the document diff is already computed by the CRDT, and `sync_blocks_full_replace` is illegal because a full replace is resurrected by any peer holding older state. Deferring this meant a persistence rewrite, not a feature addition.

Multi-device sync is a stated requirement (D003), and a single monolithic SQLite file placed in a synced folder corrupts rather than conflicts. This decision is what makes sync possible at all.

---

## D003 — Sync model: per-device append-only update logs
**Status:** active

Never sync the database. Sync the CRDT log. Rebuild the database locally.

Each device appends only to its own directory under `vault/updates/<device-id>/`. No file ever has two writers, so any file-level sync transport (iCloud, Dropbox, Syncthing, git) works without conflict resolution. On startup, all logs are read and applied in arbitrary order — Yjs updates are commutative — then projected into SQLite.

No server, no websocket provider, no subscription.

---

## D004 — Property values: JSON column, not EAV
**Status:** active · **Supersedes:** `property_values` table

Property values live in a `props` JSON column on `pages`, keyed by property UUID. The `property_values` table is dropped.

EAV forced four separate workarounds: one EXISTS subquery per filter, one LEFT JOIN per sort level, a pivot step in TypeScript on every read, and in-memory post-filtering for computed properties. All four disappear. Filters and sorts become ordinary WHERE and ORDER BY clauses over a single row per entry.

Hot properties get virtual generated columns plus indexes, added lazily.

The decisive argument is D002: `ydoc.getMap('props')` is already a key→value map per entry. Projecting it into one JSON column is a copy. Fanning it into N rows would mean reinventing a row-diffing problem the CRDT has already solved.

**Trade accepted:** deleting a property now requires rewriting every entry row rather than one DELETE. This runs as a background job over a rebuildable cache; failure is not data loss.

---

## D005 — Column on `pages`, not a side table
**Status:** active

`props` is a column on `pages`, not a separate `entry_props` table. View queries already read `pages` for parent, title and sort order; a side table would add a join to every view load. "Everything is a page" is the stated mental model and entries carrying their own values is faithful to it.

Cost: a nullable column on every non-entry page.

---

## D006 — FTS5 indexes derived plaintext
**Status:** active · **Supersedes:** indexing `blocks.content`

The old index pointed at `blocks.content`, which is `JSON.stringify(InlineContent[])`. That put the tokens `type`, `text`, `styles`, `bold`, `href`, `attrs` and every mention UUID into the index for every block in the vault. Searching "text" matched everything, bm25 ranked against JSON keys, and `snippet()` returned raw JSON to the UI.

A derived `blocks.plaintext` column is populated during projection and indexed instead. Mention **labels** are included; mention UUIDs are not.

Create-time options, fixed and not alterable later:
- `prefix='2 3'` — as-you-type prefix queries are a direct lookup rather than a term-list walk
- `tokenize="porter unicode61 remove_diacritics 2"` — stemming and accent folding

Porter is English-only. Accepted (D007).

---

## D007 — English-only search
**Status:** active

Porter stemming is English-only. Non-English vaults lose stem matching. Accepted for a personal tool. Revisiting means dropping the tokenizer and reindexing the vault.

---

## D008 — Titles are a pinned section, not unified ranking
**Status:** active · **Supersedes:** "titles and blocks ranked together by bm25"

Page titles are a column on `pages`, not an FTS table, so they cannot share a scoring space with block hits. Rather than adding a `pages_fts` table, titles render as a separate pinned section above content results.

A title match should outrank a body match unconditionally anyway. Notion and Linear both do this. Less machinery, better result ordering.

---

## D009 — System properties resolve via a resolver
**Status:** active

Title, Created at and Updated at are not stored values. `created_at` and `updated_at` are removed from the property type enum entirely — they are computed system columns, not value types.

Properties gain `system_key TEXT` (`'title' | 'created_at' | 'updated_at' | null`) rather than relying on `is_system` plus a name match, which breaks when the user renames Title.

A single resolver returns the SQL expression for any property. Filters, sorts, board grouping and rollup targets all call it. See `06_db_views.md`.

`updated_at` advances only on content-bearing changes — not on projection churn, cursor movement or view config edits.

---

## D010 — String-based fractional indexing
**Status:** active · **Supersedes:** `REAL` positions

Base62 TEXT keys, not floats. Repeated midpoint insertion into the same gap exhausts double precision in roughly 50 moves, after which siblings collide and sort order is undefined. The old mitigation — a periodic rebalance job — reintroduces the mass rewrite that fractional indexing exists to prevent.

String keys grow at roughly one character per six insertions into the identical gap and never run out.

Columns using `position` are `TEXT`, sorted with default BINARY collation. Never apply `COLLATE NOCASE` — base62 is case-sensitive.

---

## D011 — The CRDT owns order; positions are local projections
**Status:** active

Ordering is structural in the ydoc (`Y.Array` for sibling lists, `Y.XmlFragment` for blocks). Position strings exist only in SQLite and are never written into shared state.

If positions were shared, two devices independently rebalancing the same sibling list would emit competing writes and Yjs would resolve each field separately — producing a silently reordered list that neither user asked for. Because positions are derived, rebalancing is local reprojection with zero sync surface.

General rule: **if two devices can compute a value from shared state, sync the state and compute locally.** Also applies to `blocks.plaintext`, `blocks.has_link` and graph `linkCount`.

**Rebalance trigger:** `max(len) > 20 AND max(len) > 3 × median(len)`, scoped to one parent's children. Never global.

---

## D012 — License: AGPL-3.0
**Status:** active

The vault format is the thing worth defending. AGPL prevents a proprietary hosted fork of it. The network clause is largely inert for a desktop app — that is fine; its job is deterrence.

GPLv3 §13 explicitly permits combining GPLv3 code into an AGPLv3 work, so BlockNote's XL packages are compatible. BlockNote core is MPL-2.0 and compatible.

**Consequence:** the custom multi-column sprint is cut (D013).

---

## D013 — Use `@blocknote/xl-multi-column`
**Status:** active · **Supersedes:** custom `columnList` / `column` implementation

The XL packages are GPL-3.0 or commercial. Under D012 they are free to use. This deletes an entire scoped sprint: custom column block types, drag-to-split detection, resize handles and auto-cleanup.

Remaining work is restyling and animation. Two constraints:
- Column width is a flex-grow **ratio** (`0.8`, `1.4`), not pixels. Do not build a pixel-based resize UI on top of it.
- ProseMirror owns the DOM inside the editor and re-renders node views on transaction. Animating a width **prop change** causes flicker. Animate with CSS `transform` during drag; commit the `width` prop once on release. Never use layout-animation libraries inside the editor.

---

## D014 — Export ships in v1
**Status:** active · **Supersedes:** export deferred to post-1.0

Data you can only read through the app that wrote it is not owned. Post-D002 the source of truth is a directory of binary CRDT blobs, which is *less* legible to outside tools than the previous SQLite file.

The failure mode that matters is not corruption but abandonment: loss of interest, a breaking Yjs change, or an unnoticed projector bug. A plain-text mirror is the fallback.

Two exports:
- **Markdown mirror** — one file per page, directory tree matching the page tree, assets copied. Lossy: relations, rollups, property schemas and column layouts do not survive.
- **Full JSON dump** — complete, lossless, machine-readable.

Scheduled background export writes to a **sibling directory outside the vault**, so GC and the page indexer never see it. Full rewrite each run, not incremental — it is a mirror, not a sync target, and the UI must say so.

CSV **import** remains deferred. Import is convenience; export is credibility.

---

## D015 — Global undo via Y.UndoManager
**Status:** active

Editor-only undo left page deletion, property type changes, timeline drags, select-option removal, sidebar reordering and type sync with no recovery path.

`Y.UndoManager` covers content, metadata, property values and schema through one mechanism.

Transactions are tagged with an origin (`'editor'`, `'sidebar'`, `'db-view'`, `'schema'`) and undo is **scoped per surface**. Cmd+Z in the editor must never rewind a sidebar drag from ten minutes ago. Undo does not cross tabs.

---

## D016 — Relations keyed by shared `relation_id`
**Status:** active · **Supersedes:** relations keyed by `property_id`

A two-way relation is two property rows with different UUIDs — "Project" on Tasks, "Tasks" on Projects. Keying rows by `property_id` meant queries from the inverse side returned nothing, while the documented UNION query assumed both sides shared an ID. The two statements were mutually exclusive.

Rows are keyed by `relation_id`, shared by both property definitions. One-way relations have a single property pointing at it. Converting one-way to two-way becomes "create the inverse property, point it at the same `relation_id`" — no data migration.

Self-referential relations (sub-items) must set `is_directional`, or a neighbourhood query returns parents and children indistinguishably.

---

## D017 — Version history survives Yjs, in changed form
**Status:** active

Yjs does not replace version history. It has no wall-clock timestamps (updates are keyed by client ID and logical clock), no time travel without `gc: false`, and no labels.

`versions` stores `Y.snapshot()` BLOBs — a state vector plus delete set, kilobytes rather than a full document copy. Write amplification is no longer a concern.

The gap+cap session logic is retained unchanged; it now decides which points in the log to surface rather than when to duplicate a document.

**Requires `gc: false`,** so deleted content is never freed. See D018.

Property values are now covered by history automatically — previously an explicit v1 gap.

---

## D018 — Tombstone retention and compaction
**Status:** active

`gc: false` (D017) means tombstones accumulate forever. Compaction via `Y.mergeUpdates` collapses update count but cannot drop tombstones without losing rewindability.

Policy: full history within the retention window (default 30 days); beyond it, compact with GC enabled, accepting loss of fine-grained rewind. Labeled versions pin their snapshots and survive compaction.

---

## D019 — Types are provenance, sync is manual and pull-only
**Status:** active · **Supersedes:** permanent live link, "the type always wins"

The previous model — permanent link, automatic propagation, no merge, type wins on conflict — was the app holding an opinion about the user's schema, which contradicts the stated philosophy (`01_overview.md`).

New model: a database records which type it came from. Type changes **never** push, never prompt, never auto-apply. The database surfaces a quiet "updates available" affordance; the user opens a diff and picks what to apply.

Dropped: `property_sync_status`, the three-button destructive-change prompt, outdated red indicators, automatic value conversion across databases the user is not looking at.

Kept: the type link, `is_core` locking on system types, per-cell conversion error flags for manually applied datatype changes.

**Derived types are removed.** They existed to keep every DB linked to something. With a nullable link there is nothing to derive.

---

## D020 — SQLite is disposable; the update log is the artifact
**Status:** active

Nothing in `vault.db` is unique. The rebuild path is the sync path, so it is exercised constantly rather than being untested recovery code.

- **Migrations** are de-risked: schema changes bump a projector version, which triggers a full rebuild on next launch. No migration runner.
- **Backups** target `vault/updates/`, not the database. `VACUUM INTO` is pointless.
- **Corruption** is recoverable by deletion.

The projector version marker is device-local, stored beside `local.db` — never in `vault/updates/`. A synced marker deadlocks: an upgraded device writes version 5, a device still on the old build reads the mismatch, rebuilds with its old projector and writes 4, and both devices then rebuild the entire vault on every launch forever. The marker describes *this binary*, so it is device state.

### Rebuild is a visible, first-class operation

A full rebuild on a large vault takes tens of seconds. It must never look like a hang.

**UI contract:**

- A blocking splash with a **determinate** progress bar — pages projected / total, since the page count is known upfront from the vault doc
- A one-line explanation, not a spinner alone: "Updating local index — your data is safe, this is a rebuildable cache"
- Phase labels, because the cost is lopsided: *Reading update logs → Projecting pages → Building search index*
- Cancellable. Cancelling leaves a partial `vault.db` and an unset version marker, so the next launch simply starts over. No resume, no partial-state bookkeeping

**Performance requirements**, which dominate the number far more than machine speed:

- One transaction for the whole rebuild, not one per page. Per-page commits mean a per-page fsync and roughly a 10× slowdown
- Build FTS5 **after** bulk insert. Let the triggers fire per row and indexing becomes the bottleneck
- Release each page doc immediately after projecting it. `gc: false` means a materialised doc carries all its tombstones; holding 5,000 of them at once is the difference between a rebuild and an out-of-memory crash

Rebuild is triggered by a version mismatch, a missing or corrupt database, or the "Rebuild" palette command (`10_navigation.md`).

---

## D021 — Tabs are device state
**Status:** active

Tabs and active-tab selection stay in local SQLite, outside the ydoc. A laptop's open tabs are not a desktop's.

---

## D022 — Graph: `d3-force` for simulation, renderer decoupled
**Status:** active

`d3-force` for physics, Canvas 2D for rendering, run in a Web Worker.

Sigma.js was reconsidered and rejected on visual direction — its defaults read as network-science output, and custom appearance requires writing WebGL programs, which is slow to iterate on during visual exploration. Canvas 2D allows trying six node treatments in an afternoon.

Obsidian's graph runs a force simulation for physics and draws with WebGL; those concerns are separable. **The draw loop must not be coupled to the simulation** — positions are just numbers, so the renderer stays swappable if Canvas 2D hits a ceiling.

The simulation ticks ~300 times on load. On the main thread that is a frozen UI at a few thousand nodes. Worker from the start; retrofitting means restructuring the render loop.

---

## D023 — Computed properties may materialize into `props`
**Status:** active · **Supersedes:** "lazy-only, SQL filtering deferred to post-1.0"

Rollup and Lookup were kept lazy because eager evaluation needed a reverse dependency graph to know what to invalidate.

Under D002 that problem is solved: every change is observed, so the set of touched entries is already known. Computed values are written into the `props` JSON under a reserved `_computed` key, making them filterable and sortable in SQL like any stored value.

**Written to SQLite only, never into the ydoc.** `_computed` is derived from shared state, so under D011 it must not be synced — two devices recomputing the same rollup would both write it, producing redundant sync traffic at best and flapping values at worst. The projector writes `_computed` into `pages.props`; `ydoc.getMap('props')` contains stored values only. Same treatment as `blocks.plaintext` and `has_link`.

This removes the in-memory post-filter limitation and the skeleton-loading UI.

Formula remains deferred (D024). Its expression evaluator is an **open** choice — mathjs was provisionally selected but the project would use a fraction of a full CAS. Re-evaluate at implementation time.

---

## D024 — v1 scope boundary
**Status:** active

**In v1:** block editor with multi-column (D013), inline mentions, page templates, version history, tree sidebar, tabs, command palette, workspaces, five DB view types, Table/Board/Gallery/Calendar/Timeline, relations, Rollup, Lookup, data integrity rules, types as templates (D019), graph view, full export (D014), global undo (D015), multi-device sync (D003).

**Deferred:** Formula, synced blocks, MCP server, Chart view, DB automations, button properties, CSV import, comments, real-time collaboration presence, `created_by`/`updated_by`, Blueprint formula editor, nested table subgroups, configurable null sort positioning, unlinked-property recovery UI, type versioning.

Deferred does not mean unplanned. See `04_architecture.md` for the stub each one leaves behind.

---

## D025 — Authored timestamps live in the ydoc
**Status:** active

A Yjs update carries a client ID and a logical clock. It carries no wall-clock time. Any timestamp the projector invents at projection time is therefore a **projection artifact**, not a fact about the document — and because a full rebuild reprojects everything (D020), it would stamp every block in the vault with the rebuild date.

Rebuild is the sync path and the recovery path. It runs often. Silently destroying every authored timestamp on each run is not acceptable, and it would break the `before:` and `after:` search facets (`10_navigation.md`).

So authored timestamps are content:

- **Blocks** — `createdAt` and `updatedAt` are block attributes in the `Y.XmlFragment`, set by the editing device
- **Pages** — `createdAt` and `updatedAt` live in `pageDoc.meta`

The projector copies them; it never generates them.

`updated_at` advances only on content-bearing changes (D009). That rule now has a concrete home: the mutation site decides whether to touch the timestamp, rather than the projector guessing after the fact.

Clock skew across devices is accepted. It is a personal vault, not an audit log.

---

## D026 — A vault is a workspace
**Status:** active · **Supersedes:** "workspaces are logical groupings within one vault"

There is no workspace concept. A vault is a directory; opening a different vault is the switch. Obsidian's model.

The previous design put many workspaces inside one vault, with `workspace_id` on every page and a scope clause on every query. It could not decide what a workspace *was*: the docs called it a boundary, then added a setting permitting relations across it.

The concept was redundant. A page tree is already infinitely nestable, so:

- **Soft separation** — Work and Personal as two top-level pages. Visually apart, still linkable, still covered by one search. Strictly better than a workspace.
- **Hard separation** — different sync targets, real isolation. That is a vault.

Workspaces sat between: too heavy to be a folder, too soft to be a boundary.

The arguments for keeping them do not survive:

- *Shared type library* — types are copy-on-create starting points (D019), so sharing one is copying it. A real library belongs at **app** level, available to every vault, not scoped to one.
- *Cross-context search* — the old design already scoped search to the active workspace and deferred cross-workspace search to post-1.0. It did not deliver this either.
- *Fast switching* — a normal launch is 200–400ms. Opening a vault is not slow enough to design around.

And the decisive gain: **sync policy becomes per vault.** Work syncs through Dropbox, the personal vault stays local-only. One vault holding everything forces one policy over all of it, which contradicts D003.

**Consequences:** the `workspaces` table is dropped; `workspace_id` is removed from `pages` and `tabs`; scope clauses come out of the search, view, graph and tree queries; the workspace switcher becomes an open-vault flow; cross-workspace relations cease to exist as a concept; `wsDoc` is renamed `vaultDoc`.

**Multi-vault UX:** one window per open vault, like Obsidian. No in-app switcher chrome beyond a recent-vaults list.

---

## Open

- **O001** — Deleting one side of a two-way relation: does the inverse property survive as one-way (Notion's behaviour) or die with it?
- **O002** — Restoring a DB entry whose parent database was deleted: it lands at root as an entry with values and no schema.
- **O003** — Relation ordering: Notion preserves link order. Requires a position key on `relations` if wanted.
- **O004** — Formula expression evaluator (D023).
- **O005** — Whether asset files are content-addressed by hash (dedupes, conflict-free across devices) or UUID-named.
