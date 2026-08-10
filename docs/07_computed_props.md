# Computed Properties System Design

Rollup, Lookup and Formula. Rollup and Lookup ship in v1; Formula is deferred (D024).

---

## Evaluation Model

### Materialized, not lazy (D023)

Computed values are written into the `props` JSON column under the reserved `_computed` key and refreshed when their dependencies change.

```json
{
  "a3f9-estimate": { "number": 5 },
  "_computed": {
    "f0a1-total-hours": { "number": 42 },
    "f0a2-owner-email": { "text": "sam@example.com" }
  }
}
```

**Projection only.** `_computed` exists in `pages.props` in SQLite. It is never written into `ydoc.getMap('props')`.

Both devices can compute a rollup from the same shared state, so under D011 the value must not sync. Writing it would mean two devices emitting competing updates for the same derived field on every dependency change — redundant traffic at best, values flapping between two mid-recompute results at worst. The ydoc carries stored values; the projector adds the derived ones.

**Why this changed.** The previous design evaluated lazily on every view load, because eager evaluation needed a reverse dependency graph — "which entries depend on this entry?" — to know what to invalidate, and a missed invalidation means silent staleness with no server to reconcile against.

Under D002 that problem no longer exists. Every change arrives as an observed CRDT update, so the set of touched entries is already known. The invalidation trigger is a side effect of the sync architecture rather than machinery to be built and maintained.

**What it buys:**

- Computed values filter and sort in SQL like any stored value — the in-memory post-filter limitation is gone
- No skeleton-loading UI. Values are present when the row renders
- View loads stay a single query

**What it costs:** a recompute pass on dependency change, and `_computed` occupying space in `props`. Both are cheap.

**Failure mode:** stale values, never wrong data. `_computed` is derived — a full recompute during reprojection corrects anything that drifted, and reprojection is exercised constantly (D020).

---

## Invalidation

A Rollup or Lookup on entry E depends on:

1. The set of records linked to E through the relation property
2. The target property's value on each of those records

Both are observable. The trigger is the **projector**, not the page document — page docs load lazily (`04_architecture.md`), so an observer hung off `pageDoc` would miss changes to unloaded pages arriving from another device.

```ts
// vault doc is always resident
vaultDoc.getMap('relations').observeDeep(evt => {
  // a link changed → recompute dependents on both sides
})

// fires for every projected page, loaded or not
projector.on('page_props_changed', ({ pageId, changedPropIds }) => {
  // a value changed → recompute entries linking to this page
})
```

Because the projector runs for every incoming update regardless of whether a doc is materialised, and because `_computed` is projection-only, recompute never needs a page doc in memory — it reads `props` from SQL and writes `_computed` back to SQL.

The reverse lookup — "which entries link to this one?" — is one indexed query, not a maintained graph:

```sql
SELECT source_id FROM relations WHERE relation_id = ? AND target_id = ?;
```

`ix_rel_tgt` covers it.

### Recompute batching

Changes are batched on a short debounce (~200 ms) and recomputed together. Two queries regardless of entry count:

```sql
SELECT relation_id, source_id, target_id FROM relations WHERE source_id IN (…);
SELECT id, props FROM pages WHERE id IN (…);
```

Aggregate in TypeScript, write `_computed` back in one transaction.

### Full recompute

Runs during reprojection and on demand from settings. Because `_computed` is derived, this always converges.

### Chain depth

A Rollup over a property that is itself computed is **not supported in v1**. Only stored properties are valid targets. This avoids cascade ordering and cycle detection.

Lookup on a computed property of a linked record: same restriction, same reason. Deferred (D024).

---

## Rollup

Aggregates a property across all records linked via a relation.

```
Tasks has a Relation to Projects.
Rollup on Tasks: "sum of Estimate across linked Projects"
```

```json
{ "relation_property_id": "uuid",
  "target_property_id": "uuid",
  "function": "sum" | "count" | "avg" | "min" | "max" | "percent_checked" }
```

### Evaluation

1. Resolve the relation's `relation_id` from the relation property's config
2. Fetch linked record IDs (respecting `is_directional` — D016)
3. Fetch the target property value from each linked record's `props`
4. Apply the aggregation
5. Write to `_computed`

### Aggregation functions

| Function | Returns | Valid for |
|---|---|---|
| `count` | number | any |
| `sum` | number | number |
| `avg` | number | number |
| `min` | number or date | number, date |
| `max` | number or date | number, date |
| `percent_checked` | number 0–100 | checkbox |

Type mismatch — `sum` on a text property — is caught at **property config time**, not at eval. Saving the config is blocked.

### No linked records

Returns `null`, displayed as an empty cell rather than zero. Zero implies a computed result; empty implies no data. Same distinction spreadsheets make.

### Nulls within the set

Excluded from `sum` and `avg` rather than treated as zero. `count` counts linked records, not non-null values.

Configurable null handling is deferred (D024).

---

## Lookup

Pulls the actual value from linked records rather than aggregating.

```
Tasks has a Relation to People.
Lookup on Tasks: "Email of linked Person"
```

```json
{ "relation_property_id": "uuid", "target_property_id": "uuid" }
```

### Multiple linked records

Returns an **array**, displayed as comma-separated chips. Collapsing to one value would need an arbitrary tiebreak.

A single linked record returns a bare value, not a one-element array.

### No linked records

Returns `null`. Empty cell.

### Return type

Inherited from the target property. A Lookup on a Date returns a date, or an array of dates, and formats accordingly.

### Sorting on an array Lookup

Sorts on the first element. Documented, arbitrary, and better than refusing to sort. Multi-value ordering has no non-arbitrary answer.

---

## Formula (deferred — D024)

### What exists today

- `type = 'formula'` in the properties enum
- `config` shape `{ expression, returnType }`
- `computeFormulas()` stub in the projector, returning an empty map
- `_computed` write path already built by Rollup and Lookup

Formula therefore inherits SQL filtering and sorting on day one, with no schema change.

### Expression evaluator — open (O004)

mathjs was provisionally chosen for broader built-in string function coverage, with bundle size deemed irrelevant on desktop. That still holds, but the project would use a small fraction of a full computer algebra system, and lighter evaluators have improved. Re-evaluate at implementation time.

Sandboxed JS `eval` is rejected regardless — largest attack surface, even locally.

### Declared return type

The user declares `text`, `number`, `boolean` or `date` when creating the property.

Inferring the type requires static analysis of the expression, which is hard to get right for nested `if()` branches returning different types. Declaring gives the column a known type upfront for sorting, filtering and display, and forces explicit intent.

A mismatch at eval time surfaces a type error in the cell rather than displaying garbage.

### `prop()` mapping

| Property type | Returns |
|---|---|
| Text, URL, Email, Phone | string |
| Number | number |
| Checkbox | boolean |
| Select | option **name** |
| Multi-select | array of strings |
| Date | timestamp (ms) |
| Relation | count of linked records |
| Rollup / Lookup | resolved value |

**Select returns the name** so formulas read as `prop("Status") == "Done"` rather than `== "opt-a3f9c"`. The tradeoff — renaming an option breaks the formula — is handled by the UI storing UUIDs behind name chips.

**Relation returns a count** because arithmetic on an array of page IDs is meaningless. Actual values from linked records are Rollup and Lookup's job.

### UI

**v1 when it ships:** raw text field plus a `prop()` picker. References are always inserted from the picker, never typed — the picker inserts a chip that displays the name and stores the UUID. Chips are rename-proof; typed strings are not.

**Post-1.0:** a node-graph editor built on React Flow, with type-aware ports and an Advanced tab holding the raw expression. Bidirectional: graph → expression is a traversal; expression → graph requires AST parsing, which mathjs supports natively. Same pattern as Jira's JQL Basic/Advanced toggle.

Deferred because it is a sprint on its own.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Rollup type mismatch (sum on text) | Blocked at config time |
| Relation property deleted | Property marked broken in the schema editor; cells show an error state |
| Linked record deleted | Excluded silently. Count reflects remaining records |
| Target property deleted | Cells show "property not found" |
| Circular reference | Impossible in v1 — computed properties cannot target computed properties |
| Formula parse error | Red cell state, evaluator message in tooltip |
| Formula returns wrong declared type | Red cell state, "Expected number, got text" |

Errors are stored in `props._errors`, keyed by property ID, so an error state survives reload without recomputation.

Unlike `_computed`, `_errors` **does** live in the ydoc and syncs. A failed conversion is a fact about the data — the original value was kept and needs fixing — not something a second device can recompute from shared state.

---

## Post-1.0

- Formula (D024)
- Configurable null handling in Rollup
- Computed properties targeting other computed properties, with cycle detection
- Node-graph formula editor
