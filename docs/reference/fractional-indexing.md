# Fractional Indexing (D010)

Base62 strings, not floats.

```
Append:     a0  a1  a2 … a9  aA … az  b00
Insert:     a0 → a1 becomes a0 → a0V → a1
Again:      a0 → a0V becomes a0 → a0F → a0V
```

One character buys 62 slots; bisecting 62 takes ~6 steps. So keys grow roughly one character per six insertions **into the identical gap**. Appending never grows them.

Floats fail hard at ~50 midpoints. Strings degrade linearly and never fail.

**Rebalance:** local reprojection only, never a synced write. Triggered per parent when `max(len) > 20 AND max(len) > 3 × median(len)` — one long key among 400 short ones does not justify rewriting 400 rows.

Sorting uses default BINARY collation. Never apply `COLLATE NOCASE` — base62 is case-sensitive.
