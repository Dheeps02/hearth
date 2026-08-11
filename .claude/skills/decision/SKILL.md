---
name: decision
description: Procedure for adding an entry to docs/decisions.md. Only run when explicitly asked to add a decision — never on your own initiative.
disable-model-invocation: true
---

Only add a decision entry when explicitly asked to. Never add one on your own initiative.

## Before writing

1. Confirm the change is architectural rather than an implementation detail. If it is a detail, do not log it.
2. Read `docs/decisions.md` and find the next free D-number from the index table at the top.
3. Identify any existing entries this decision supersedes.

## Entry format

    ## Dxxx — Title
    **Status:** active · **Supersedes:** Dyyy (if applicable)

    [Rationale — one to three paragraphs. Why this, not the alternatives. What trade-off was accepted.]

Rules for the entry:
- Status must be one of: `active`, `superseded`, `open`.
- If this entry supersedes another, also mark the old entry `superseded` and append `· **Superseded by:** Dxxx` to it.
- Never edit the rationale of an existing entry. If it is wrong, supersede it.
- Never renumber existing entries.
- Never add a decision entry without being explicitly asked.

## After writing

1. Add a row to the index table at the top of `docs/decisions.md`:

       | Dxxx | Short description | active |

2. Design documents reference the ID (`D025`) and never restate the rationale. If a design doc needs updating, add the ID reference — do not copy the decision text into it.
3. Use `Refs: Dxxx` in the commit body for any commit that adds or references a decision.
