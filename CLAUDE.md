# Hearth

Local-first block-based personal knowledge base. Yjs is the source of truth; SQLite is a disposable local index rebuilt from CRDT update logs. Electron shell, AGPL-3.0, solo developer.

## Commands

- `bun install` — install dependencies (also runs electron-rebuild via postinstall)
- `bun run dev` — start Vite dev server
- `bun run build` — production build
- `bun run typecheck` — type-check without emitting (`tsc --build --noEmit`)
- `bun run test` — unit and integration tests (Vitest)
- `bun run test:e2e` — end-to-end tests (Playwright)
- `bun run rebuild` — rebuild `better-sqlite3` against Electron's ABI

## Invariants

Breaking any of these corrupts user data rather than merely annoying someone.

1. **Yjs is the source of truth; `vault.db` is a disposable projection** (D002, D020). Never treat SQLite as authoritative. Never write user data to SQLite that does not originate from a ydoc.
2. **The projector is the only writer to `vault.db`** (D020). No other code path writes to it.
3. **Never generate timestamps at projection time** (D025). `created_at` and `updated_at` are ydoc content; the projector copies them and never invents them. Generating them restamps the entire vault on every rebuild.
4. **`_computed` is projection-only** (D023, D011). Rollup and Lookup values are written into `pages.props` in SQLite and never into `ydoc.getMap('props')`. Derived values must not sync. `_errors` is the exception — it does sync.
5. **Position strings are local projections and never enter shared state** (D010, D011). Order is structural in the ydoc. The same rule covers `blocks.plaintext`, `blocks.has_link`, `page_links`, and graph `linkCount`. General form: if two devices can compute a value from shared state, sync the state and compute locally.
6. **`PROJECTOR_VERSION` is device state, not vault state** (D020). It lives in `local.json` beside `local.db`, never in `vault/updates/`. A synced marker makes upgraded and non-upgraded devices rebuild each other's databases in a loop.
7. **Full replace is illegal** (D002, D017). Restore and any bulk write must be expressed as operations against the live document. A delete-everything-and-reinsert is resurrected by any peer holding older state.

## Where truth lives

`docs/decisions.md` is the single source of truth for architecture. If a design document contradicts it, the decision log wins. Decisions are append-only — do not edit or renumber existing entries. Use the index table at the top to locate an entry by ID.

## How to work

- **Ask before making a design decision.** If a fork in the road is not covered by the specification, stop and ask rather than choosing.
- **Do not resolve open questions** (O001–O005 in `docs/decisions.md`) without being asked to.
- **Never commit directly to `dev` or `main`.** Branch, then open a pull request.
- **Merge commits, never squash.**
- **Never add a co-author trailer or generated-by line** to a commit message.
- **Conventional Commits.** Any commit touching a decision carries `Refs: Dxxx` in the body.
- **Deferred features (D024)** leave behind schema columns, a stubbed no-op interface, and architecture notes. Do not remove a stub because the feature is not built.
- **Explain changes in plain language.** The repository owner is deliberately learning this stack. Define jargon inline. Concrete beats abstract.
