---
paths:
  - "vite.config.ts"
  - "vitest.config.ts"
  - "tsconfig*.json"
  - "package.json"
---

# Build configuration rules

Each item here is a non-obvious bug that has already cost real time.

- `vite-plugin-electron` builds the main and preload entries with `configFile: false`. The root `resolve.alias` does not reach them. Aliases must be repeated in each sub-build's own `vite` config block.
- On Vite 8, the plugin writes `build.rolldownOptions` and deletes `build.rollupOptions`. `external` must go in `rolldownOptions` or it silently does nothing.
- `better-sqlite3` is a native module and must be marked external. It also needs `electron-rebuild` against Electron's ABI, not Node's.
- The main and preload bundles land flat in `dist-electron/`. The renderer builds to `dist/`. Paths in `main.ts` must account for both.
- `@stylexjs/unplugin` appends its CSS to an existing bundler-produced CSS asset. If nothing imports CSS, Vite emits no asset and styles are silently absent in production while working in dev. `src/renderer/index.css` must stay imported from `main.tsx`.
- Dev and production are different code paths. Verifying a build change in `bun run dev` alone proves nothing about production. Both must be checked.
- Always check the latest published version before adding or changing a dependency. Never downgrade without first confirming no newer compatible version exists.
- Do not change TypeScript `target`, `module`, or `moduleResolution` without being asked.
