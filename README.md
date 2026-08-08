# Hearth

A local-first, block-based personal knowledge base. Everything lives on your machine — no server, no sync service. Think Notion, but the data is yours.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [Node.js](https://nodejs.org) ≥ 20 (for native module rebuild)
- C++ build toolchain — needed to compile `better-sqlite3` from source:
  - **Arch Linux**: `sudo pacman -S base-devel`
  - **Windows**: Visual Studio Build Tools with the "Desktop development with C++" workload
  - **macOS**: `xcode-select --install`

## Install

```sh
bun install
```

## Commands

| Command | Description |
|---|---|
| `bun run dev` | Start the app in development mode |
| `bun run build` | Build for production |
| `bun run typecheck` | Run the TypeScript type checker |
| `bun run test` | Run unit and integration tests |
| `bun run test:e2e` | Run end-to-end tests |
| `bun run rebuild` | Rebuild native modules against the installed Electron version |

## License

AGPL-3.0-only
