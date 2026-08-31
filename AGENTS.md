# OpenGrove Agent Map

Use this file before broad searches. Default to focused reads under `src/`, `web/src/`, `docs/`, and `scripts/`; avoid `node_modules/`, `dist/`, `web-dist/`, `data/`, and generated archives unless the task is explicitly about generated output. Read `.codex/` only for skill, prompt, or agent-behavior tasks; it is a local untracked directory — skip if absent.

Terminology: `CONTEXT.md` at the repo root is the canonical glossary — use its terms in code, docs, and issues.

## Code Map

- UI and settings: `web/src/app.tsx`, `web/src/store.ts`, `web/src/components/**`, `web/src/styles.css`.
- Local bridge routes/state: `src/server/local-bridge.ts`, `src/server/create-server.ts` (assembly only; routes live in `src/server/router.ts` + `src/server/routes/**`), `src/server/bridge-state.ts`, `src/server/bridge-types.ts`.
- Kernel detection and runtime selection: `src/server/kernel-selection.ts`, `src/server/kernel-registry.ts`, `src/kernel/**`, `src/runtime/**`.
- App import/store/install: `src/app-builder/**`, `src/server/app-store.ts`, `src/server/app-store-registry.ts`, `src/server/routes/app-store.ts`, `src/tests/app-store-harness.ts`.
- Store App Workspaces keep their stable containers under the user-owned
  `OpenGrove/workspaces/` root. Replaceable program generations live under the
  platform-native `OpenGrove/programs/` root; the mounted App setting binds the
  active program to its persistent Workspace. The old `apps/` and
  `data/app-store/programs/` roots are migration sources only.
- Rooms and local delivery: `src/rooms/**`, `src/server/room-runs.ts`, `src/server/routes/rooms/**`, `web/src/components/rooms/**`.

## Validation Ladder

- Docs-only change: `npm run check:doc-refs` (broken repo-relative links fail CI).
- UI-only change: `npm run typecheck:web`.
- Server/kernel contract change: `npm run smoke:server`.
- App Store install: `npm run build:server && node dist/tests/app-store-harness.js`.
- Full local confidence: `npm run smoke:critical`.
- Release confidence only when needed: `npm run test:harness` or `npm run release:check`.

When a failure is localized, run the narrow smoke first, fix, then widen one level. Do not start with the full harness for a small UI or single-adapter change.

Definition of done: ran its ladder level and reported which. Not run = not done.

---

# Collaboration Rules

## 0. Collaboration and Communication

- **Speak plainly.** After every substantial change, recap three things in ordinary language: what changed, what it means, and what remains.
- **Start from the user's perspective.** Understand the problem before discussing a solution. Explain first how users experience it, where it appears in the interface, and what path they follow; discuss code last.

## 1. Before You Start

- For non-trivial changes, run an alignment interview first: ask one question at a time and include a recommended answer. Investigate facts in the code yourself; leave product decisions to the user. Start implementation only after alignment.
- Before changing architecture or public interfaces, read `PROJECT_OVERVIEW.md`, `docs/architecture/OVERVIEW.md`, and the relevant public specification under `docs/product/` or `docs/reference/`.

## 2. Engineering Guardrails

- **Before building anything, ask whether an existing capability can be reused.** Check Rooms, knowledge, the event layer, and existing UI before creating something new.
- Solve problems at the root or architectural level: do not mock, compromise, route around, patch over, or force-fit the behavior.

## 3. Code Quality (Core)

- Avoid `any` unless it is genuinely necessary; types are guardrails, and disabling them makes mistakes easier.
- Parse, validate, and normalize external input, persisted data, and network data at trust boundaries. Inside the boundary, rely on types to maintain invariants. When a runtime check contradicts the type model, fix the type or lifecycle model instead of layering on defensive null checks.
- A function must add semantic meaning or a distinct responsibility. Inline private, single-use forwarding functions that perform no transformation and establish no independent boundary.
- Do not delete or bypass code merely to silence type errors; fix the root cause. Upgrade outdated dependencies instead of coding around them.
- Do not add compatibility reads outside `migrations/`, `compat/`, `*.compat.ts`, or a documented protocol adapter boundary. Every new compatibility path must explain why it exists and record the applicable version or upstream evidence plus a removal condition. Link a public issue when useful, but never expose a private tracker from public source. Normalize legacy shapes immediately at the boundary; do not expand existing scattered compatibility logic.
- Names must be self-explanatory. Comments explain why, not what.
- Prefer explicit behavior: do not hide side effects, use top-level imports instead of dynamic imports, and keep dependencies visible.
- A failure must be handled, converted into an explicit domain result, or rethrown. Silent degradation is allowed only for non-critical paths such as caches, diagnostics, and cleanup, and it must be searchable and diagnosable. Never present degraded behavior as complete success.
- Keep each function at one abstraction level: high-level functions tell the story; lower-level functions own the details.
- Move genuinely independent responsibilities into separate files. Keep shared state and logic that changes together in the same place.
- When a large file remains intact, divide it with navigational section comments such as `// ===== xxx =====`.
- Repeated engineering rules that can be checked mechanically must become lint/check rules in CI. A new mechanical rule is not fully adopted until an automated check enforces it.

## 4. Testing Discipline

- Test behavior through agreed public seams, not implementation details. A refactor that preserves behavior should not break tests.
- Use fixed expected values from known answers or specification examples. Do not recompute expectations with the implementation's own algorithm; such tests cannot catch the same mistake.
- Deliver features as vertical slices: one test, one implementation, then repeat. Do not stockpile tests before implementing them.
- **Keep an honest capability ledger.** Never hand-author capability fields. `exposed` requires a passing contract test; `native` requires evidence shaped as `{ verified, source, checkedAt, upstreamVersion }`.

## 5. Bug-Fixing Discipline

- Reproduce before theorizing. First obtain a test, `curl`, or script command that finishes in seconds and is red when the bug exists and green when fixed. Do not build theories from code before that command exists.
- List and rank three to five falsifiable hypotheses at a time. Each must predict an observable result, such as "if X is the cause, changing Y makes the failure disappear." Discard hypotheses that make no prediction.
- Turn the minimal reproduction into a regression test before fixing the bug. If there is no suitable test seam, record that as an architectural finding in an issue.
- Prefix temporary debugging logs with `[DEBUG-xxxx]` and remove all of them before finishing.

## 6. Git Discipline

- Use the `git` and `gh` CLIs directly for GitHub operations by default.
- Commit only the files changed for the current task, and stage explicit paths with `git add <specific-path>`.
- Run `git status` before committing and confirm that only intended files are staged.
- Never use `git reset --hard`, `git stash`, `git checkout .`, or `git commit --no-verify`.
- Do not let changes accumulate in the working tree. Commit along clear boundaries, keep pure moves separate from features, and stay synchronized with the remote `main` branch.
- Use commit messages in the form `{feat,fix,refactor,docs}: brief description`.

## 7. Issue Conventions

- Track non-trivial work in GitHub Issues: open an issue before implementation and close it when the acceptance gate is complete.

## 8. User Instructions Take Priority

- If a user instruction conflicts with this file, identify the conflict and confirm it once before following the user's instruction.

## 9. Documentation and Decision Discipline

- Terminology lives in `CONTEXT.md`; public product contracts live under `docs/product/` and `docs/reference/`; architecture boundaries live in `docs/architecture/OVERVIEW.md`.
- Internal plans, QA evidence, research notes, local runtime evidence, and third-party source snapshots do not belong in the public repository.
- Public proposals should be tracked in Issues and resolved through reviewable code or specification changes, not committed planning diaries.
- Documentation references must resolve to real paths; `npm run check:doc-refs` enforces this.
