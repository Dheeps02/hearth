# DB Types & Templates System Design

Types are reusable property schemas used as **starting points** for databases.

---

## Type Kinds

Two kinds (`derived` is removed — it existed only so every database had a link, and links are now optional).

### `system`

Shipped with the app: Person, Company, Book, Task and similar. A useful starting point without setup.

**Core properties are locked.** App-defined properties on a system type cannot be renamed or deleted, so an app update that modifies a system type cannot collide with user edits. Enforced through `type_properties.is_core`.

**User additions are fully editable.** System types are a floor, not a ceiling.

### `user`

Created explicitly. Fully editable, nothing locked.

---

## The Database → Type Relationship

```
Created from a type    → databases.type_id set
                         type_properties copied into properties
                         each copy carries type_property_id
                         type_synced_at = now

Created from scratch   → type_id null
                         properties defined directly
                         nothing to sync, nothing to derive
```

`type_id` is nullable. Most databases in a personal vault will never have one, and that is the correct default.

`type_property_id` on a property records where it came from. It is provenance, not a binding — a property with no origin is normal, not "unlinked" or in an error state.

---

## Type Editing

The type editor is a form. Add, rename, delete, change a datatype, then Save. Changes are batched; nothing commits until Save.

**Saving a type affects only the type.** No prompt, no propagation, no diff calculation, no databases touched. The three-button destructive-change dialog is gone.

The only guard is `is_core` on system types, checked in the editor.

---

## Applying Updates from a Type

Entirely user-initiated.

### Surfacing availability

When a database with a `type_id` is opened, the app diffs the type's current `type_properties` against the database's `properties`, matched on `type_property_id`, and compares `types.updated_at` to `databases.type_synced_at`.

If there is a delta, the database header shows a quiet affordance:

```
Person  ·  3 updates available
```

Not red. Not a warning. Nothing is wrong — the type simply moved on.

### The diff view

Clicking it opens a list. Each row is independently selectable:

```
┌────────────────────────────────────────────────┐
│  Updates from "Person"                         │
│                                                │
│  [x]  + Add "LinkedIn"          (url)          │
│  [x]  ~ Rename "Mobile" → "Phone"              │
│  [ ]  − Remove "Fax"                           │
│  [ ]  ! Change "Score": text → number          │
│         12 of 40 values won't convert          │
│                                                │
│              [Cancel]        [Apply selected]  │
└────────────────────────────────────────────────┘
```

Two things this does that the old prompt could not:

- **Per-change selection.** Take the new property, skip the deletion
- **Conversion is dry-run first.** The count of values that will not convert is computed before anything is applied

Nothing is applied until Apply. Cancel changes nothing.

### Applying

**Add** — new property appended, `type_property_id` set. Column appears with empty values.

**Rename** — `name` updated on the matching property. No data change.

**Remove** — the property's `type_property_id` is set to null. The property and all its values are **preserved**; it simply stops appearing in future diffs. No data is ever hard-deleted by applying a type update.

**Datatype change** — each value is converted. Successes are rewritten. Failures leave the original value in place and set a flag:

```json
"_errors": { "score-uuid": "conversion" }
```

The cell renders with a red highlight and the original value visible, so the user has the context to fix it. `_errors` clears on successful edit.

After applying, `type_synced_at` is updated.

Every application runs in one transaction tagged `'schema'`, so it is a single undo step (D015). Combined with vault-doc snapshots (`design/version-history.md`), applying a type update is now fully reversible — previously it was not.

---

## Detaching

A database can be detached from its type at any time: `type_id` set to null, every property's `type_property_id` cleared. Nothing else changes.

The previous model forbade this on the grounds that the link should be permanent. There is no reason for that. Databases diverge from their starting point — that is normal and expected.

---

## Saving a Database as a Type

From the database menu: **Save as Type**.

```
Enter a name → confirm
  → new types row, kind = 'user'
  → properties copied into type_properties (system properties excluded)
  → the source database is NOT linked to it
```

The source database is deliberately left unlinked. Saving a type is exporting a shape, not adopting a parent. Linking it would recreate the surprise the old model was built on.

The type appears in the picker when creating new databases.

---

## Creating a Database from a Type

The picker shows all `system` and `user` types, plus "Empty database".

On confirm:

1. New `pages` row, `type = 'database'`
2. New `databases` row with `type_id` and `type_synced_at`
3. Each `type_property` copied into `properties` with `type_property_id`
4. System properties created — Title, Created at, Updated at (D009). These are never type properties
5. Default Table view created

---

## Practical Note: Divergence Is Expected

Two databases from a shared Person type — one for friends and family, one for colleagues — share name, email, phone and birthday. Within a month one has "how we met" and the other has "company", "title" and "last 1:1".

Under the old model each divergence produced a property in an unlinked limbo state, with recovery UI deferred to post-1.0. Under this model divergence is simply what the databases look like. The type stays a starting point and both databases keep their own shape.

---

## Post-1.0

- Type versioning — browse a type's schema history
- Explicit type deletion, with a rule for what happens to databases that came from it
- Type picker search and filtering
- Bulk apply — push an update to several databases from the type's side, still opt-in per database
