# Kernel integration guide

This guide covers adding a native Agent SDK, CLI, JSON-RPC service, ACP
subprocess, or Gateway to OpenGrove. The goal is to preserve the Kernel's native
model loop while projecting the parts the Host and UI must understand.

## Responsibility boundary

- The **Kernel** owns its model loop, native tools, authentication, transcript,
  compaction, Provider behavior, and native permission semantics.
- The **Host** owns OpenGrove sessions and rooms, local state, Apps, approvals,
  artifacts, explicit context, diagnostics, and product policy.
- The **Adapter** owns transport, event projection, stable native-session
  binding, capability declarations, and translation between native requests and
  Host controls.

Do not reimplement a Kernel's loop in the Host, replay Host history into a
Kernel-owned transcript, bypass `KernelAdapter` / `AgentRuntime` to update the
UI, or replace structured native events with log parsing when a protocol surface
exists.

The public contracts are defined in
[`src/kernel/types.ts`](../../src/kernel/types.ts),
[`src/kernel/adapter.ts`](../../src/kernel/adapter.ts), and the Kernel-specific
files under [`src/kernel/adapters/`](../../src/kernel/adapters/).

## Choose the narrowest transport

Prefer the Kernel's supported programmatic boundary:

| Shape | Current reference |
| --- | --- |
| JSON-RPC service | Codex: `src/runtime/codex/app-server-client.ts` and `src/runtime/codex/event-projector.ts` |
| In-process SDK | Claude Agent: `src/runtime/claude-agent-sdk-runtime.ts`; Pi: `src/runtime/pi-runtime.ts` |
| ACP subprocess | Shared runtime: `src/runtime/acp-cli-runtime.ts`; OpenCode/Kimi adapters in `src/kernel/adapters/` |
| Gateway | Hermes: `src/runtime/hermes-runtime.ts`; OpenClaw: `src/runtime/openclaw-gateway-runtime.ts` |

Use a generic text CLI only when no structured boundary is available. Native
protocol events are the source of truth for tool lifecycle, approvals, session
identity, usage, and errors.

## Minimum end-to-end loop

A new integration must first prove this loop:

1. A Host turn reaches the native runtime with the selected model, explicit
   context, attachments, and runtime controls.
2. Initialization records the native version, session identity, and safe
   diagnostics.
3. Native answer deltas map to `assistant.delta`.
4. The terminal answer maps to exactly one `model.response` before exactly one
   `turn.finished`.
5. Errors and cancellation still close the stream with `turn.finished`.
6. Every advertised native tool, Host tool, approval, question, steering, or
   compaction capability has a real mapping and a harness assertion.
7. A fake runtime verifies the mapping without a network call or real account.

The shared event contract harness checks terminal ordering, duplicate output,
and correlated tool progress in
[`src/tests/kernel-event-contract-harness.ts`](../../src/tests/kernel-event-contract-harness.ts).

The runtime contract still requires one `model.response`. At the Host boundary,
`KernelAdapter` preserves an existing `assistant.final` or derives one from a
non-empty `model.response` before `turn.finished`; it never duplicates an
existing final event. The `collectAssistantText` recovery helper prefers
`assistant.final`, then `model.response`, then accumulated `assistant.delta`
text when it must read an event sequence directly.

## Adapter contract

Every adapter should declare a `KernelAdapterContract` next to its
implementation. The contract records:

- ownership for sessions, loop, native and Host tools, approvals, questions,
  skills, context, compaction, auth, sandbox, transport, and diagnostics;
- native-to-Host and Host-to-native event mappings;
- diagnostic capture modes and redaction;
- config, executable, native skill, and knowledge paths;
- model display aliases and input templates; and
- user-facing labels.

Capability flags are promises to the product. Do not mark a feature supported
because the upstream Kernel documents it; mark it supported only when this
adapter exposes it and a contract test covers the path. The capability catalog,
UI behavior, and reports are sourced from
[`src/kernel/capabilities/native-facts.ts`](../../src/kernel/capabilities/native-facts.ts),
[`docs/reference/KERNEL_SOURCES.md`](KERNEL_SOURCES.md), and
[`web/src/runtime/kernel-capability-ui-policy.ts`](../../web/src/runtime/kernel-capability-ui-policy.ts).

A passing real-runtime certification is sticky. A Kernel version, runtime mode,
or Provider change schedules context revalidation but does not hide the feature
from users by itself. Only a newer failed certification for the current context,
or an explicit `not-wired` / `suppressed` contract mapping, revokes exposure.

## Event projection

Maintain an explicit mapping for the native protocol. At minimum:

| Native boundary | OpenGrove event | Requirement |
| --- | --- | --- |
| query/turn start | `turn.started` | One lifecycle start per run |
| assembled request | `context.assembled` / `model.requested` | Preserve model, session, tools, skills, and explicit context metadata |
| text delta | `assistant.delta` | Stream incrementally; do not wait for the final result |
| tool start/progress/result | `tool.started` / `tool.progress` / `tool.finished` | Preserve native tool and call identifiers |
| permission request | `approval.requested` | Await the Host decision and answer the same native request |
| final response | `model.response` | Emit once; use accumulated answer text only as a documented fallback |
| error | `error` | Redact credentials and private payloads; preserve safe upstream correlation ids |
| run end | `turn.finished` | Emit once on success, failure, cancellation, and interruption |

All events in one run use the same `runId`. Tool progress must correlate to a
started call. Never render diagnostic-only data as conversation text.

## Sessions and runtime binding

An OpenGrove session id and a native session id are different identities. An
adapter must persist the native binding, resume the native transcript when it
still exists, and create a new native session honestly when it does not.

Include every input that changes transcript compatibility in the runtime
binding fingerprint, such as Kernel, working directory, App/version scope,
Provider route, and material runtime configuration. A changed fingerprint must
not silently reuse an incompatible native transcript.

The available model catalog, model order, pricing and context limits are not
conversation identities. Refreshing these facts must preserve native session
bindings; pass updated model configuration through the Kernel's own controls.

## Tools, approvals, and elicitation

Support is adapter-specific:

- Native tools execute inside the Kernel; the Adapter projects their lifecycle
  and never executes them a second time.
- Host tools cross an explicit bridge such as dynamic tools or a per-session MCP
  server. Inputs and results must remain JSON-compatible and bounded.
- Native permission requests wait for OpenGrove's approval decision before the
  same native turn continues.
- Native questions use a structured elicitation path when the protocol exposes
  one. Do not claim elicitation support for a text-only fallback.
- Rejection, timeout, cancellation, and process exit must all terminate without
  leaving a pending run or approval.

## Three permission presets

Employees (including the global PM and App-scoped PM bindings) and chat share exactly three
choices: **Ask for approval** (`default`), **Help me approve** (`auto-review`), and **Full access**
(`full-access`). Presets do not change App scope, Workspace, tool visibility, or administrator
identity. Kernels approve native tools; Host tools continue to enforce App policy.

| Kernel | Ask for approval | Help me approve | Full access |
| --- | --- | --- | --- |
| Codex | `workspace-write` + `on-request` + reviewer `user` | Same sandbox and policy; reviewer `auto_review` | `danger-full-access` + `never` |
| Claude Agent SDK | `default` | `auto`; check fresh `supportsAutoMode` and await `setPermissionMode` before sending user input | `bypassPermissions` + `allowDangerouslySkipPermissions` |
| Hermes | `approvals.mode: manual` | `approvals.mode: smart` | `approvals.mode: off` |
| OpenCode | Allow reads, ask for other operations, retain explicit deny rules | Unavailable | Allow ordinary operations, retaining explicit denials in supplied configuration |
| Kimi | Human ACP approval | Unavailable | Select `allow_once` for ordinary ACP permission requests; questions still need an answer |
| Pi | Host policy and native tool hooks | Unavailable | Allow ordinary tools, retaining explicit denials |
| OpenClaw | Gateway-managed | Unavailable | Unavailable until per-employee control is connected |

Both restricted Codex presets disable sandbox network access. Outside-Workspace writes and
network escalation use native approval. Calls that omit `accessMode` retain the existing configured
approval/sandbox policy, with `danger-full-access` / `never` as the unconfigured fallback. For omitted
presets, network access remains owned by native configuration: neither thread config nor turn config
overrides it. Claude calls without a preset retain the configured mode, falling back to
`bypassPermissions`. These API fallbacks are separate from the product's explicit default selections.
Neither `on-failure` nor Claude `acceptEdits` is auto review.
Claude model availability comes from the SDK model cache and is revalidated for the current
model/account before each auto-review run. The native default selection uses the SDK `default` record. With an empty cache, support is
unknown until a normal turn refreshes it. Unknown support disables the picker option; a rejected
mode never silently falls back. The legacy CLI path lacks this preflight and must use the SDK for auto review.

Hermes isolates processes and configuration copies by environment and preset, preserving user
denials and auxiliary reviewer settings without editing a shared `HERMES_HOME`. Native startup
checks the effective mode and fails if it cannot apply it. Approval and question bridges support
both desktop contract v7 server requests and earlier notification-based requests.

The global PM and its App-scoped bindings default to **Full access**. Other new Employees and chats
prefer **Help me approve** when supported: Codex and Hermes use auto review; Claude requires cached
support for the selected model, otherwise it starts with Ask for approval. Pi, Kimi and OpenCode start
with Ask for approval. OpenClaw remains Gateway-managed; remote permissions belong to the remote owner.

Explicit user choices survive ordinary seed synchronization and take priority over App defaults;
compatible App declarations take priority over product defaults. App version activation and the
explicit restore-App-defaults action can reapply the App's configuration. A one-time v3 migration only
fills missing employee modes and repairs unsupported combinations, backing up changed state. It does
not blanket-reset compatible choices. PM's new default follows the existing product seed mechanism
and preserves explicit user permission overrides. Stored chat choices are read without being rewritten;
an unset chat choice resolves against the selected kernel and model.

Unsupported presets are disabled in the picker and rejected at execution. Switching to Pi, Kimi or
OpenCode while auto review is selected changes the selection to ask for approval and displays a notice.
Employee creation, updates, App imports and seed synchronization apply the same compatibility rule.
Publishing rejects unsupported combinations. Claude's locally unverified model support is distinct
from a Kernel that cannot support auto review and does not invalidate a portable App declaration.

Parameter contract tests: [`runtime-access-modes.test.ts`](../../src/tests/runtime-access-modes.test.ts).
Protocol references: [Codex desktop presets](https://learn.chatgpt.com/docs/sandboxing),
[Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
[Hermes approval implementation](https://github.com/NousResearch/hermes-agent/blob/main/tools/approval.py).

## Diagnostics and privacy

Useful diagnostics include the runtime version, safe executable source, native
session id, model id, permission mode, exposed tool names, bridge state, and a
Provider-supplied request id when one exists.

Never record API keys, OAuth tokens, cookies, complete request headers,
unredacted Provider payloads, private reasoning, unrelated environment
variables, or machine-local paths that are not required for the user's own
diagnostic bundle. Harness fixtures use generated temporary directories and
fake credentials.

## Verification

Add a fake-runtime harness under `src/tests/` for success, failure, cancellation,
resume, and every advertised interactive capability. Start narrow:

```bash
npm run build:server
node dist/tests/<kernel>-runtime-harness.js
npm run test:capabilities
```

If the change affects selection, Rooms, packaging, or shared event contracts,
run the corresponding integration group from `package.json`. Real-runtime
probes are additional evidence and may require local credentials; they do not
replace deterministic harnesses and must not commit their generated evidence.

## Completion checklist

- A real turn can run through the selected Kernel.
- The fake harness covers lifecycle, output, error, resume, and advertised
  tool/approval/question/control paths.
- `KernelAdapterContract` describes ownership, events, paths, diagnostics, and
  labels without generated fallback fields.
- Capability facts cite installed package types or pinned official sources;
  third-party source snapshots are not copied into the repository.
- Native session reuse is binding-safe and failure to resume is visible.
- Cancellation and denial cannot strand a turn.
- No cloud-only service is required for the local Kernel loop.
- No native credential or local runtime evidence enters tracked files or
  distributable Apps.
