# Asset Management

```
vault/assets/
  <sha256-prefix>.png
  <sha256-prefix>.pdf
```

Content-addressed by hash (O005 — confirm before implementing). Two devices adding the same image produce the same filename, so the file sync transport deduplicates for free and there is no rename conflict.

- On insert: hash, copy into `assets/`, store the relative path
- On delete: files are never removed immediately — the same asset may be referenced elsewhere
- GC scans for files unreferenced by any active block or `props` value
