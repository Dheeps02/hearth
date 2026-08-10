# Version History System Design

Snapshot creation, session boundaries, restore semantics, pruning and the history panel.

---

## Why This Still Exists

Yjs has no wall-clock timestamps, no time travel without `gc: false`, and no labels — so `versions` survives, storing points in the log rather than copies of the document (D017).

---

## Snapshot Content

```sql
snapshot BLOB NOT NULL   -- Y.snapshot() bytes
```

A Yjs snapshot is a state vector plus delete set — kilobytes, not a document copy. The write-amplification concern from the previous design is gone.

**What it covers, automatically:**

- Block content
- Title, icon, cover (page `meta`)
- **Property values** (page `props`) — previously an explicit v1 gap

Because everything lives in one Y.Doc, there is no list of fields to enumerate and nothing to forget.

**What it does not cover:** database *schema*, which lives in the vault doc. Schema history is a separate concern; the vault doc keeps its own snapshots on the same mechanism, which makes applying a type update reversible — previously it was not.

### `gc: false` is required

Page docs and the vault doc are both constructed with `gc: false`. Without it, deleted content is freed and old snapshots cannot be materialized.

The cost is permanent tombstones. Managed by D018.

---

## Session Boundary Logic

Unchanged from the previous design. It was right; only its meaning shifts — from "when do we duplicate the document" to "when do we mark a point in the log."

### Gap-based with a continuous-write cap

Either condition triggers a boundary:

- **Inactivity gap** — 5 minutes without an edit to the page
- **Continuous cap** — 15 minutes of uninterrupted editing

Detected on the *next* write after the condition is met; the snapshot captures state just before that write.

**Rejected alternatives:**

- Per-keystroke or per-debounce — 20 snapshots an hour, most mid-sentence. Unusable
- Fixed timer — same noise, whether or not anything meaningful changed
- Gap only, no cap — breaks for long uninterrupted sessions. Write for an hour and your only rollback point is the start

Gap plus cap scales with behaviour rather than the clock, and makes the guarantee communicable: **you can always roll back to within the last 15 minutes.**

```ts
type PageSessionState = { lastEditedAt: number; sessionStartedAt: number }
const sessionState = new Map<string, PageSessionState>()

function shouldSnapshot(pageId: string): boolean {
  const s = sessionState.get(pageId)
  if (!s) return true                       // first edit ever
  const now = Date.now()
  return now - s.lastEditedAt     > 5  * 60_000
      || now - s.sessionStartedAt > 15 * 60_000
}
```

### Integration

The trigger moved. It was called inside `syncBlocks()`; it now hangs off the document's update observer, because there is no longer a write path to hook.

```ts
pageDoc.on('update', (_update, origin) => {
  if (origin === 'remote') return          // don't snapshot others' edits as ours
  if (shouldSnapshot(pageId)) createSnapshot(pageId, null)
  updateSessionState(pageId)
})
```

**Remote updates are excluded.** A snapshot represents *this* device's editing session. Snapshotting on incoming sync would produce noise proportional to other devices' activity.

**Unloaded pages never snapshot.** Page docs load lazily (`design/sync.md`), so this observer only exists for docs the user has opened. That is the correct behaviour and not a gap: a session boundary marks *this device's* editing, and a page nobody opened here was not edited here. Remote edits are captured by the originating device's own snapshots, which sync through `vaultDoc.versions`.

### createSnapshot()

```ts
function createSnapshot(pageId: string, label: string | null) {
  const snapshot = Y.encodeSnapshot(Y.snapshot(pageDoc))
  const record = { id: uuid(), snapshot, label, createdAt: Date.now() }

  vaultDoc.getMap('versions').get(pageId).push([record])   // syncs
  db.insertVersion(pageId, record)                       // projection
}
```

---

## Snapshots and the Projection

`versions` is the one table whose contents are not reconstructible from page documents alone — a snapshot is a *decision* about which moments matter, not derived data.

Snapshot records therefore live in `vaultDoc.versions` and are projected into SQLite like everything else. They survive reprojection, and version history is consistent across devices.

The BLOB is small, so carrying it in the vault doc is acceptable.

---

## Restore

### Snapshot first, no confirmation

Restore is a write, so the same rule applies: snapshot before overwriting. Every restore is reversible — restore the wrong version and the state you just replaced is itself a snapshot.

No confirmation dialog. Reversibility beats warnings.

### Full replace is illegal

`sync_blocks_full_replace` is **dead**. Deleting all blocks and inserting the snapshot's blocks fresh works in a single-writer SQL model and is corrupting in a CRDT: another device holding pre-restore state merges it back on next sync, resurrecting the content you just removed.

Restore must be expressed as **operations against the live document**.

```ts
async function restoreVersion(pageId: string, versionId: string) {
  // 1. current state becomes a snapshot
  createSnapshot(pageId, null)

  // 2. materialize the historical document
  const record   = db.getVersion(versionId)
  const snapshot = Y.decodeSnapshot(record.snapshot)
  const historic = Y.createDocFromSnapshot(pageDoc, snapshot)

  // 3. apply the difference as ops, in one transaction, one undo step
  pageDoc.transact(() => {
    applyFragmentDiff(pageDoc.getXmlFragment('blocks'),
                      historic.getXmlFragment('blocks'))
    applyMapDiff(pageDoc.getMap('meta'),  historic.getMap('meta'))
    applyMapDiff(pageDoc.getMap('props'), historic.getMap('props'))
  }, 'restore')

  // 4. fresh session
  sessionState.delete(pageId)
}
```

The editor updates through its binding — no `replaceBlocks`, no reload, no cache invalidation.

`applyFragmentDiff` is the fiddliest code in the project. Budget for it. A correct-but-slow first version that deletes and reinserts *within a single transaction* is acceptable, since the ops are still ops and merge correctly; optimising to a minimal diff is a later refinement.

Tagging the transaction `'restore'` makes the whole restore one undo step (D015).

---

## Pruning

The auto versus labeled distinction falls out of the schema: `label IS NULL` is auto.

```sql
DELETE FROM versions
WHERE label IS NULL AND created_at < ?;
```

The same removal is applied to `vaultDoc.versions` so it propagates.

Labeled versions are never pruned by GC. Explicit deletion is post-1.0 (D024).

### Interaction with tombstone compaction (D018)

Pruning a snapshot row is not enough — the underlying tombstones still occupy the log.

Order of operations in GC:

```
1. Prune auto-snapshots older than the retention window
2. Compact the log up to the oldest surviving snapshot, GC enabled
3. Leave everything newer intact
```

A labeled version older than the window **pins** the log at its point. That is the intended trade: keeping a labeled version means keeping the ability to reach it.

The UI should say so where users label versions.

---

## Database Entries

Entries are pages, so everything above applies unchanged — same session logic, same snapshot shape, same restore.

Property values are now included automatically, which closes the previous v1 gap.

Entries are edited less often and have sparser content, so the session logic naturally produces fewer snapshots. No special casing.

---

## UI — History Panel

Opened from the page header. Side panel on the right, same pattern as the local graph.

```
┌─────────────────────────────┐
│  Version History            │
│─────────────────────────────│
│  📝 Before restructure      │  ← labeled
│     Aug 3, 2:14 PM          │
│─────────────────────────────│
│     Aug 3, 1:02 PM          │  ← auto
│     Aug 3, 11:47 AM         │
│     Aug 2, 6:30 PM          │
└─────────────────────────────┘
```

- Auto-snapshots show relative timestamps — "Today 3:45 PM", "Yesterday 11:20 AM", full date beyond
- Labeled versions lead with the label, timestamp secondary
- Newest first

### Interaction

- **Click** — materializes the snapshot into a detached doc and renders it read-only. A "Preview" banner and a Restore button appear. Closing the panel exits without restoring
- **Restore** — runs the sequence above. The panel stays open with the restored version highlighted
- **Label an auto-snapshot** — inline edit on click, saves on blur or enter. Updates `label` in place; no new row
- **No diff view** in v1. Meaningful tree comparison is non-trivial and adds significant UI for marginal value

Preview uses `Y.createDocFromSnapshot`, so it is a real document rather than a rendered blob. The live document stays in memory and exiting preview needs no round trip.

---

## Post-1.0

- Explicit version deletion
- Diff view between two snapshots
- Version branching — open a snapshot as a new page instead of overwriting
- Per-page retention windows (v1 exposes one global setting)
- Schema-level history UI for the vault doc (the data already exists)
