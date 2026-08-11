---
name: verify
description: Full verification checklist before declaring any task done. Run after implementing any change.
disable-model-invocation: true
---

Run these steps in order. Each step states what "pass" looks like — exiting zero is not sufficient on its own.

## 1. Type check

```
bun run typecheck
```

Pass: exits zero **and** reports files checked. If it exits zero but the output shows "checking 0 files", the tsconfig is misconfigured — treat that as a fail.

## 2. Unit and integration tests

```
bun run test
```

Pass: all tests pass, no skipped tests that were expected to run.

## 3. End-to-end tests

```
bun run test:e2e
```

Pass: all Playwright scenarios pass.

## 4. Dev build smoke check

```
bun run dev
```

Open the devtools console (Electron devtools or browser devtools) and verify:
- The app loads without errors.
- No CSP (Content Security Policy) violations in the console.
- The feature you changed works as expected on the happy path.

## 5. Production build

```
bun run build
```

Pass: build completes without errors.

Then launch the production build and verify:
- The app loads.
- No CSP violations in the devtools console.
- The feature you changed works in the production bundle.

Note: dev and production are different code paths (vite-plugin-electron builds main/preload separately). A working dev build does not prove a working production build.

## 6. Working tree check

```
git status
```

Pass: no unintended untracked or modified files. Only what belongs in this commit is staged or modified.
