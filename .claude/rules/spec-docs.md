---
paths:
  - "docs/**/*.md"
---

# Spec and decision log rules

- `docs/decisions.md` is the single source of truth. If a design document contradicts it, the decision log wins.
- Decisions are append-only. Superseding means adding a new entry and marking the old one `superseded` — never editing an entry in place, never renumbering.
- Never add, edit, or remove a decision entry without being explicitly asked.
- Design documents reference decision IDs and never restate rationale. Do not reintroduce "the previous design did X" narration.
- Open questions O001–O005 are deliberately unresolved. Do not resolve one as a side effect of other work.
- When work touches architecture, read the relevant entries in `docs/decisions.md` first. Use the index table at the top to find them rather than reading the whole file.
