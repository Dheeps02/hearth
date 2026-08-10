---
paths:
  - "tests/**"
---

# Test rules

- Vitest for unit and integration (`tests/unit`, `tests/integration`); Playwright for E2E (`tests/e2e`). Vitest must not load the Electron plugin.
- The projector is the priority target for tests — it is pure, deterministic, and the highest-consequence code in the project.
- A full rebuild from a fixture update log producing a known-good `vault.db` is the highest-value integration test.
- `fixtures/demo-vault/` holds committed `.ybin` update logs. `.gitignore` exempts them from the global `*.ybin` ignore via `!fixtures/**/*.ybin` — do not break that negation.
