# Project Overview

## Philosophy

> The app is a substrate, not a workflow. Users build their workflow inside the app, not around it.

Notion's flexibility and block editing quality, Obsidian's data ownership. Relational databases and rich blocks, stored locally, syncable across your own devices without a server.

The app has no opinion on how you use it. It provides the primitives — blocks, pages, databases, relations — and gets out of the way.

That principle is load-bearing, not decorative. It is the reason the type system propagates nothing without being asked (D019), and the reason full export ships in v1 rather than as a later convenience (D014).

## Core Motivations

- **Data ownership** — your data is a directory on your machine, in a documented format, with a continuously maintained plain-text mirror. No servers, no subscriptions, no kill switch, and no dependence on this app continuing to exist.
- **Flexibility** — no enforced workflow. Build whatever system fits your brain.
- **Quality** — Notion-level UI and UX, not a rough approximation of it.

## Non-Goals

- Real-time collaborative presence (cursors, avatars, comments) — the data layer supports it; the UX is out of scope for v1
- AI built into the app (LLM access is via MCP, post-v1, and never baked in)
- Graph view as a primary feature — nice to have
- Markdown-first storage. Rich blocks and markdown do not map cleanly. Markdown is an **export target** (D014), not the storage format
- Small bundles and low idle memory. Explicitly not a goal (D001)

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Editor | BlockNote | Notion-like blocks out of the box, extensible, native Yjs support, built on ProseMirror/TipTap |
| Multi-column | `@blocknote/xl-multi-column` | GPL-3.0, compatible with our license (D012, D013) |
| Desktop shell | Electron | Bundled Chromium means consistent rendering everywhere; mature packaging, signing and auto-update (D001) |
| Build tool | Bun | Fast bundling and transpilation. Build-time only |
| Source of truth | Yjs (CRDT) | Multi-device sync without a server; conflict-free by construction (D002) |
| Local index | SQLite via `better-sqlite3` | Fast synchronous queries and FTS5 over a disposable projection (D020) |
| UI | React + Tailwind + ShadCN | Modern, composable, good ecosystem |
| Graph view | `d3-force` + Canvas 2D in a Worker | Organic force-directed feel, full visual control (D022) |
| License | AGPL-3.0 | Protects the vault format from proprietary forks (D012) |

## Data Model Mental Model

```
Everything is a page.
Pages contain blocks (the editor content).
Some pages are databases.
Databases have properties (schema) and entries (which are also pages).
Entries carry their property values directly, as a JSON map.
Databases relate to each other through relation properties.
All connections (mentions, embeds, relations) are tracked as page_links.
```

## Storage Strategy

The single most important thing to understand about this project:

> **The CRDT log is the data. SQLite is a cache.**

```
MyVault/
  updates/
    device-a1b2c3/          ← this device appends here, and only here
      <page-uuid>.ybin
      vault.ybin
    device-d4e5f6/          ← another device's log, read-only to us
      ...
  assets/
  vault.db                  ← derived. Deletable. Never synced.
  local.db                  ← device-only: tabs, tree collapse state
  local.json                ← device settings + PROJECTOR_VERSION (D020)

MyVault_export/             ← sibling directory, regenerated (D014)
  ...
```

- **Yjs documents are authoritative** (D002). One doc per page, one for vault-level schema.
- **Update logs are per-device and append-only** (D003). No file ever has two writers, so any file sync transport works.
- **`vault.db` is a projection** (D020). It exists for SQL queries, FTS5 search and view rendering. Losing it costs a rebuild, not data.
- **`PROJECTOR_VERSION` is device state**, not vault state (D020). It describes the binary running on this machine, so syncing it would make every device rebuild on every launch.
- **Assets are files** in `assets/`, referenced by relative path.
- **A vault is a workspace** (D026). Opening a different vault is the switch; there is no workspace concept inside one.
- **A plain-text mirror is maintained** in a sibling directory (D014).

### Why not sync the database

A single SQLite file in a synced folder, edited on two machines, does not produce conflicts — it produces a corrupted file. This is why Obsidian sells Sync as a product despite storing plain markdown, and why Anytype built on CRDTs from the start rather than adding them later.

Syncing an append-only log per device sidesteps the problem entirely. Updates are commutative, so they apply in any order and converge.

## Deferred to Post-v1

See D024 for the full boundary and `04_architecture.md` for what each deferred feature leaves behind.

Headline items: Formula properties, synced blocks, MCP server, Chart view, DB automations, CSV import, comments, collaborative presence.
