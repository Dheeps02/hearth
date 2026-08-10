# The Projector

The projector is the only writer to `vault.db`. One-way, idempotent, and re-runnable from scratch at any time.

```ts
function project(update: Uint8Array, doc: Y.Doc, pageId: string) {
  const flat = flattenFragment(doc.getXmlFragment('blocks'), pageId)
  const { toInsert, toUpdate, toDelete } = diffBlocks(pageId, flat)

  db.transaction(() => {
    deleteBlocks(toDelete)
    insertBlocks(toInsert)
    updateBlocks(toUpdate)
    upsertPageMeta(pageId, doc.getMap('meta'), doc.getMap('props'))
    writeComputed(pageId)          // _computed — projection only, D023
    rebuildPageLinks(pageId, flat)
  })()
}
```

`flatten`, `diff` and `reconstruct` survive from the previous architecture. They changed job title: they were the write path, they are now the projector. Same code, different trigger.

## Flatten (Y.XmlFragment → SQL rows)

```ts
type FlatBlock = {
  id: string
  page_id: string
  parent_block_id: string | null
  type: string
  props: string
  content: string
  plaintext: string      // derived — D006
  has_link: 0 | 1
  position: string       // base62 fractional key — D010
  created_at: number     // copied from block attrs — D025
  updated_at: number     // copied from block attrs — D025
}
```

Recursive DFS over the fragment. Sibling positions are generated as evenly spaced base62 keys, regenerated per parent whenever that parent's children change. Because positions never leave the machine (D011), regenerating them freely is safe.

`created_at` and `updated_at` are read from the block's ydoc attributes, never generated here (D025). The editing device stamps them; the projector transports them. Generating them at projection time would restamp the whole vault on every rebuild.

`plaintext` is built by walking inline content, concatenating `text` nodes and mention **labels**, skipping UUIDs and style metadata.

**Complexity:** O(n), one visit per block.

## Reconstruct (SQL rows → Block[])

Two passes: build an id→block map, then attach children to parents and sort by position at each level.

Used for export, version preview and MCP — **not** for loading the editor. BlockNote binds to the fragment directly, so the read path no longer goes through SQLite.

Orphan rescue is retained: a block whose parent is missing is pushed to root rather than dropped. Under the CRDT this should be unreachable; if it fires, the projector has a bug.

**Complexity:** O(n log n).

## Diff

Compares the freshly flattened array against the in-memory cache for that page and emits minimal INSERT/UPDATE/DELETE sets. Unchanged from the previous design except that its input comes from the fragment rather than `onChange`.

Yjs already knows which blocks changed, so the diff is an optimisation rather than a correctness requirement. Keeping it means the projector is safe to run over a whole document at any time — which is what makes full rebuild possible.

## Validation

Runs before every projection write: orphan check, required fields, parseable JSON. A failure means the projector is wrong, so it logs loudly and skips the write. The ydoc is unaffected and the data is not at risk.
