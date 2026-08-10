# DB Views System Design

A view is a saved configuration — filters, sorts, grouping, column visibility — over the same dataset. Views are independent: switching Table → Board → Table returns you to exactly where you left the Table view. This falls out of the data model; no extra logic.

---

## Query Strategy

### One query

The previous design used two queries — one for filtered and sorted entry IDs, one to bulk-fetch property values — plus a pivot step in TypeScript. All of that existed because `property_values` was EAV.

With values in a JSON column on `pages` (D004, D005), an entry is one row. Filters and sorts are ordinary WHERE and ORDER BY clauses.

```sql
SELECT p.id, p.title, p.icon, p.cover, p.props, p.created_at, p.updated_at
FROM pages p
WHERE p.parent_id = ? AND p.is_deleted = 0
  AND <filters>
ORDER BY <sorts>
LIMIT ? OFFSET ?;
```

The `p` alias is required — the resolver below emits `p.title` and `json_extract(p.props, …)`, so every query it feeds must alias `pages` as `p`.

`JSON.parse` the `props` column and render. No pivot, no join, no assembly.

Relation values are fetched separately from the `relations` table, batched by entry ID — one extra query, unavoidable since relations are many-to-many.

---

## The Property Resolver (D009)

Title, Created at and Updated at are not stored values. Every part of the query builder goes through one function that returns the SQL expression for any property:

```ts
function resolve(prop: Property): string {
  switch (prop.system_key) {
    case 'title':      return 'p.title'
    case 'created_at': return 'p.created_at'
    case 'updated_at': return 'p.updated_at'
  }
  if (isComputed(prop)) {
    return `json_extract(p.props, '$."_computed"."${prop.id}"')`
  }
  return `json_extract(p.props, '$."${prop.id}"')`
}
```

Filters, sorts, board grouping, calendar date selection and rollup targets all call it. Without this, sorting a table by Title — the most common operation in any database view — silently returns nothing, because Title has no entry in `props`.

Typed accessors extend it:

```ts
resolveTyped(prop)   // number   → CAST(json_extract(…, '$."<id>".number') AS REAL)
                     // select   → json_extract(…, '$."<id>".option_id')
                     // date     → json_extract(…, '$."<id>".start')
                     // checkbox → json_extract(…, '$."<id>".checked')
                     // text     → json_extract(…, '$."<id>".text')
```

Dates are stored as epoch milliseconds, so comparison is numeric and needs no date parsing.

---

## Filters

Plain WHERE clauses:

```sql
WHERE p.parent_id = ? AND p.is_deleted = 0
  AND json_extract(p.props, '$."status-uuid".option_id') = 'done-uuid'
  AND CAST(json_extract(p.props, '$."prio-uuid".number') AS REAL) > 2
  AND p.title LIKE '%draft%'
```

Note the third condition — a Title filter, resolving to a real column. That case did not work at all under the previous design.

### OR via filter groups

Conditions sharing a `filter_group` are AND'ed; groups are OR'ed:

```sql
AND (
  (<group A cond 1> AND <group A cond 2>)
  OR
  (<group B cond 1>)
)
```

A flat list with a per-row `and`/`or` column was rejected — it cannot express `(A AND B) OR (C AND D)` and leaves evaluation order ambiguous. Groups map to how users think about filters and match Notion's model.

### Empty handling

`is_empty` must catch both a missing key and an explicit null:

```sql
(json_extract(p.props, '$."<id>"') IS NULL)
```

Because absent keys are simply not written, this is one check rather than two.

### Computed properties

Rollup and Lookup values are materialized into `props._computed` **in the projection** (D023), so they filter in SQL like anything else. The in-memory post-filter is gone.

They are not present in the ydoc's `props` map — derived values do not sync (D011). This is invisible to the query layer, which only ever reads the SQLite column.

Formula, when it ships, uses the same mechanism.

---

## Sorts

```sql
ORDER BY
  CAST(json_extract(p.props, '$."prio-uuid".number') AS REAL) DESC,
  json_extract(p.props, '$."due-uuid".start') ASC,
  p.title ASC
```

No joins at any sort depth. Adding a sort level appends an expression.

### Nulls

SQLite orders NULLs first on ASC and last on DESC. That is v1 behaviour, documented and accepted.

Configurable null positioning is deferred (D024). SQLite supports `NULLS LAST` when it lands.

### Performance

For large databases, add a generated column and index for the sorted property (D004, `03_schema.md`). Because the schema is disposable, this is free to add and remove.

---

## Grouping

Client-side. Filters and sorts run in SQL; grouping splits an already-fetched list into buckets. No reason to return to SQLite.

---

## View Types

### Table

Flat list, configurable column visibility, width and order.

**Grouping:** optional single-level, by any property. Sections collapse. Nested subgroups deferred (D024).

```json
{ "group_by_property_id": "prop-uuid | null" }
```

---

### Board (Kanban)

Grouped into columns by a select property. Each option is a column.

**Column ordering** is per view, stored as an ordered array of option IDs in view config. Dragging a column updates the array; new options append.

This is deliberately separate from `select_options.position`, which orders options in **pickers**. Column order is a view concern, option order is a schema concern — they are allowed to differ, and previously having both claim ownership was a genuine ambiguity.

**Deleted option:** entries may still reference the old `option_id` in `props`. They fall into a "No Status" column. A ghost column for the deleted option was rejected — unclear what it represents.

```json
{ "group_by_property_id": "prop-uuid",
  "column_order": ["opt-1", "opt-2", "opt-3"] }
```

---

### Gallery

Grid. No grouping. Config names the preview media property.

```json
{ "preview_property_id": "prop-uuid" }
```

---

### Calendar

Entries plotted by a date property. Single dates and ranges both supported.

**Zoom:** Day, Week, Month. Persisted in config.

**Date property:** chosen explicitly, so databases with both "Due date" and "Start date" work cleanly.

**Overflow:** days with many entries fade toward the bottom. Clicking a day opens a panel with the full list.

```json
{ "date_property_id": "prop-uuid", "zoom": "day" | "week" | "month" }
```

---

### Timeline (Gantt)

Horizontal bars across a time axis, spanning start → end.

**Zoom:** Week, Month, Quarter, Year. Day omitted — too granular for planning.

**No end date:** the bar extends with a faded right edge, communicating "ongoing". A single-point marker was rejected — it loses duration.

**Collisions:** overlapping ranges stack into separate lanes.

**Today line:** always visible.

**Drag to resize:** in v1. Right edge changes end, left edge changes start, dragging the bar shifts both. Writes on drop.

Because writes are CRDT operations, two devices dragging the same bar while offline resolve last-writer-wins on the date field. No corruption, and the loser's change is recoverable through undo (D015) or version history (D017).

```json
{ "start_date_property_id": "prop-uuid",
  "end_date_property_id": "prop-uuid",
  "zoom": "week" | "month" | "quarter" | "year" }
```

---

### Chart

Deferred (D024). Enum value and config shape reserved:

```json
{ "type": "bar" | "pie" | "line", "x_property_id": "uuid", "y_property_id": "uuid" }
```

A DB view, not a standalone block.

---

## Data Integrity in Views

- **Required** — inline validation on the cell; the entry saves but flags incomplete. A CRDT cannot reject a write, so enforcement is presentational
- **Defaults** — applied on entry creation, not retroactively
- **Validation** — format hints for email, phone, URL. Warnings, not blocks
- **Unique** — checked on write against an index over the generated column. A late-arriving sync can still produce a duplicate; surface it, do not silently drop
- **Conditional properties** — hide/show only. Never filters the query
- **Dependent selects** — the parent option filters child options via `parent_option_id`

---

## Post-1.0

- Configurable null positioning per sort level
- Nested subgroups in Table
- Chart view
- Formula in filters and sorts (works automatically once Formula ships — D023)
