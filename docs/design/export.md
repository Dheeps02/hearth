# Export (D014)

```
1. Walk the page tree from the vault doc
2. Per page: reconstruct Block[] → blocksToMarkdownLossy()
3. Write to MyVault_export/<mirrored path>.md
4. Databases → CSV per view, plus properties.json
5. Copy referenced assets
6. Full JSON dump alongside
```

Runs on a schedule in the main process, and on demand. Full rewrite each time. Writes to a **sibling directory outside the vault**, so GC and the page indexer never see it.

Conversion rules: `@page` mentions become relative links, DB embeds become a link to the database page, synced mirrors render resolved content.
