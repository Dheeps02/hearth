---
paths:
  - "src/renderer/**"
---

# Renderer rules

- No Node APIs, no `fs`, no `better-sqlite3`. Everything crossing the process boundary goes through the typed IPC bridge defined in `src/shared/ipc.ts`.
- The editor never writes to SQLite. It binds to the ydoc; SQLite serves queries only.
- Styling is StyleX. Do not add inline `style` props, CSS Modules, or additional stylesheets. `src/renderer/index.css` holds global resets and the theme import; it is the only plain CSS file.
- `@blocknote/core` and `@blocknote/xl-multi-column` only. All editor chrome is custom. `@blocknote/react` is a transitive dependency of the multi-column package — do not import from it in application code.
- Column width is a flex-grow ratio, not pixels (D013). Animate with CSS `transform` during a drag and commit the `width` prop on release. Never use layout-animation libraries inside the editor.
