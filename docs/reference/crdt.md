# The CRDT Layer

## Document layout

One Y.Doc per page:

```ts
pageDoc.getXmlFragment('blocks')   // BlockNote binds here directly
pageDoc.getMap('meta')             // title, icon, cover, createdAt
pageDoc.getMap('props')            // property values, entries only
```

One Y.Doc per vault, holding everything that is not page content:

```ts
vaultDoc.getMap('tree')        // parentId → Y.Array<pageId>   (D011)
vaultDoc.getMap('databases')   // dbId → { typeId, typeSyncedAt }
vaultDoc.getMap('properties')  // propId → definition
vaultDoc.getMap('propOrder')   // dbId → Y.Array<propId>
vaultDoc.getMap('selectOptions')
vaultDoc.getMap('views')       // + filters, sorts, column config
vaultDoc.getMap('types')
vaultDoc.getMap('relations')   // relationId → Y.Array<[sourceId, targetId]>
vaultDoc.getMap('favorites')   // Y.Array<pageId>
vaultDoc.getMap('settings')    // vault-level settings
vaultDoc.getMap('versions')    // pageId → Y.Array<{ id, snapshot, label, createdAt }>
```

**Both docs are constructed with `gc: false`** (D017). Required for time travel; the cost is permanent tombstones, managed by D018.

## Why the tree lives in the vault doc

Page ordering is structural (D011). `tree` maps a parent ID to a `Y.Array` of child IDs. A `Y.Array` is a sequence CRDT — it resolves insertions and moves, not competing values for a field.

`parent_id` on `pages` is **derived from the tree**, not stored in page meta. One source of truth for hierarchy.

If ordering were stored as position strings in shared state, two devices independently rebalancing the same sibling list would each write four position fields, Yjs would resolve each field separately by client ID, and the result would be an order neither user chose. Because positions are local projections, this cannot happen.

## Where relation values live

In `vaultDoc.relations`, keyed by `relation_id` (D016), **not** in the entry's `props` map. A relation is a link between two entries; putting it on one side means the inverse write is a second operation that can diverge. One `Y.Array` per relation, holding pairs, keeps both directions a single op.

`pages.props` therefore has no relation entries. The `relations` table is projected from `vaultDoc.relations`.
