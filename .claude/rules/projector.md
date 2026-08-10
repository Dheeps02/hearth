---
paths:
  - "src/main/projector/**"
---

# Projector rules

The highest-risk code in the project. Every rule here maps to a data-corruption path.

- Timestamps are copied from ydoc attributes, never generated (D025). The projector copies `createdAt`/`updatedAt`; it never calls `Date.now()` or similar.
- `_computed` is written here and never into the ydoc (D023). Rollup and Lookup values go into `pages.props` in SQLite only. They must not sync.
- Foreign keys are enforced. Write in dependency order: pages → blocks → databases → properties → everything else.
- The projector is idempotent and re-runnable over the whole vault at any time. That property is what makes full rebuild possible — do not introduce state that breaks it.
- Full rebuild: one transaction for the whole run, not one per page. Build FTS5 after bulk insert. Release each page doc immediately after projecting it — `gc: false` means a materialised doc carries all its tombstones, and holding thousands at once is an out-of-memory crash (D020).
- Validation failure blocks the SQL write and logs loudly. It never touches the ydoc.
