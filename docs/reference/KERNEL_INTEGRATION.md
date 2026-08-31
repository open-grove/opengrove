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
