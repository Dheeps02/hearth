# Extensibility Principle

> Every deferred feature leaves behind the architecture to support it. No layer gets reworked just to add a feature that was always on the roadmap.

The previous version of this document claimed collaboration satisfied this. It did not — collaboration was an inversion of what owns truth, not a layer, and that is why D002 moved it to day one. The principle survives; the counterexample was removed by adopting it.

Requirements for any deferred feature:

1. **Schema columns exist from day one.** Since the projection is disposable (D020), this matters less than it did — a rebuild is not a migration
2. **Stubbed interfaces.** The interception point exists as a no-op
3. **Architecture notes.** Each stub below is the implementation spec
4. **No assumptions of absence.** Nothing may assume a deferred feature will never exist

---

## Deferred Feature Stubs

### Synced blocks

**CRDT:** the natural implementation is a shared `Y.XmlFragment` referenced by multiple pages, rather than copying content. `blocks.synced_source_id` remains for the projection so mirrors are identifiable in queries.

**Read hook:** in `reconstructBlocks()`, `resolveSyncedContent()` substitutes source content. Currently a no-op — `synced_source_id` is always null.

**Write hook:** with a shared fragment, writes go to the source automatically. No redirect layer is needed, which is a simplification over the pre-CRDT plan.

**Delete:** on source delete, prompt "delete everywhere" or "detach copies". Detach materialises the current content into each mirror as an independent fragment.

---

### Formula properties

**Schema:** `type = 'formula'` is in the enum; `config` holds `{ expression, returnType }`.

**Eval hook:** `computeFormulas(entries, properties)` returns an empty map today. When it ships, it evaluates against same-row values from `props` and writes results into `props._computed`, exactly as Rollup and Lookup already do (D023). Formula therefore inherits SQL filtering and sorting for free.

**Evaluator is open (O004).** mathjs was provisionally chosen; a full CAS is more than this needs.

---

### Chart view

**Schema:** `'chart'` is in the `views` type enum with config shape defined. Purely a new renderer over the existing view pipeline.

---

### MCP server

**Interface:** the main process already exposes `getPage`, `writePage`, `queryDatabase`, `getRelations` to the IPC layer. MCP is an additional caller of the same functions.

**Serialisation:** `blocksToMarkdownLossy()` for reads. Writes parse markdown to blocks and apply them **as ydoc operations**, never as a SQL write.

---

### Collaborative presence

Data convergence is solved (D002). What remains is awareness — cursors, selections, avatars — which needs a transport (`y-webrtc` or a relay) and UI. No schema impact.

`created_by` / `updated_by` ship with it. Under the CRDT, client IDs are already on every update, so authorship is recoverable from the log rather than requiring new columns.
