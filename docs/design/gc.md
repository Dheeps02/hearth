# Garbage Collection

Runs on launch and on a timer:

```
1. Hard-delete pages where is_deleted = 1 and deleted_at older than the window
   → removes them from the ydoc; the projection follows
2. Prune auto-snapshots older than the window (labeled versions skipped)
3. Compact update logs with Y.mergeUpdates (D018)
4. Delete assets unreferenced by any active block or props value
5. Rebalance degenerate position keys (local only — D011)
```

Retention window: configurable, default 30 days. Stored in vault settings, so it syncs.

**Take a log backup before step 1 or 3.** They are the only steps that touch the source of truth.
