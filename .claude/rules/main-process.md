---
paths:
  - "src/main/**"
  - "src/preload/**"
---

# Main process and preload rules

- No DOM APIs. This is Node, not a browser; `document`, `window`, `localStorage` and similar do not exist here.
- `better-sqlite3` is main-process only. Never import it from the renderer or the preload script.
- Every IPC channel is defined in `src/shared/ipc.ts` and typed on both sides. No string literals at call sites.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` are not negotiable. Do not change these flags.
- The `will-navigate` guard and `setWindowOpenHandler` exist because arbitrary remote content will eventually render in the renderer (the embed block). Do not weaken them.
- One window per open vault (D026). Window-to-vault is one-to-one.
