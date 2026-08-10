# Editor

## Read Path

```
User opens page
  → load page Y.Doc (from cache, or apply its logs)
  → bind BlockNote to ydoc.getXmlFragment('blocks')
  → editor is live
```

No SQLite read. No reconstruct. No cache-miss branch.

**Provider stub.** BlockNote's `collaboration` option expects a provider supplying an awareness instance, even with no peers. There is no network transport here (D003), so it takes a local stub: a bare `Awareness` instance over the doc, no connection. Verify the exact expected shape against the installed BlockNote version before wiring it — the option is validated at editor construction, so a wrong shape fails loudly and early rather than silently.

Awareness becomes real when presence ships (D024). Nothing else changes.

SQLite serves search, DB views, the sidebar tree, backlinks and the graph — everything that is a *query* rather than a *document*.

---

## Undo (D015)

```ts
const undo = new Y.UndoManager(
  [pageDoc.getXmlFragment('blocks'), pageDoc.getMap('meta'), pageDoc.getMap('props')],
  { trackedOrigins: new Set(['editor']) }
)
```

One manager per surface, filtered by transaction origin. Every mutation tags its origin:

```ts
pageDoc.transact(() => { /* … */ }, 'sidebar')
```

Surfaces: `editor`, `sidebar`, `db-view`, `schema`.

Page deletion is soft, so undo restores it in place rather than sending the user to Trash.

Undo does not cross tabs.
