# Search Path

```sql
SELECT b.id, b.page_id, p.title,
       snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 20)
FROM blocks_fts
JOIN blocks b ON blocks_fts.rowid = b.rowid
JOIN pages  p ON b.page_id = p.id
WHERE blocks_fts MATCH ?
  AND p.is_deleted = 0
  AND (? IS NULL OR b.type = ?)          -- type: facet
  AND (? IS NULL OR b.page_id IN (...))  -- in: facet
ORDER BY bm25(blocks_fts)
LIMIT 50;
```

FTS5 matches; ordinary indexed columns handle faceting. As-you-type appends `*` to the final term (D006).

Titles are queried separately and pinned above content results (D008):

```sql
SELECT id, title, icon FROM pages
WHERE is_deleted = 0 AND title LIKE ? || '%'
ORDER BY length(title) LIMIT 5;
```
