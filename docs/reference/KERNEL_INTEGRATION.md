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

Claude runs exclusively through the Agent SDK. The old `OPENGROVE_CLAUDE_CODE_RUNTIME`
switch has no effect. Engine discovery and `OPENGROVE_CLAUDE_CLI_PATH` remain available
because the SDK launches the Claude Engine and native Login commands use that executable.

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

## Host instructions and current context

Keep these channels distinct until the Adapter renders a native request:

| Content | Host field | Claude / Codex placement |
| --- | --- | --- |
| Employee identity and durable collaboration rules | `sessionInstructions` | Native system append / developer instructions |
| Current Room, members, language, CLI environment and optional Skill index | `assembledContext.hostState` | Named, replaceable sections in the current user input |
| Required or explicitly selected Skills and message-specific directions | `assembledContext.turnInstructions` | Current user input |
| Attachment excerpts and explicit selections | `assembledContext.promptBlock` and `items` | Task materials in user input; images use native media blocks |

Host-generated stable collaboration rules use one canonical language; changing
the UI or reply-language preference updates Turn state, not those rules.

Claude enables native system-prompt snapshots. Existing sessions whose recorded
Host prompt is unknown or changed use `snapshot: false` until native compaction
clears the old snapshot; this preserves their transcript while removing stale
Host text from the system channel. Mutable state and task materials
must therefore never be appended to that prompt. Both Claude and Codex retain
their native base instructions, tools and transcript ownership.

For Claude and Codex, the first delivery to a native session contains all current
Host state. Empty sections are absent on initial delivery; removal notices are
sent only for previously delivered sections. Full snapshots explicitly replace
all earlier Host state, including an empty current state, so omitted sections
cannot remain active in retained history. A successful native turn records a receipt; later turns send changed
sections and explicit notices for removed sections. Materials and per-turn
instructions are delivered each turn. Failed, canceled, overlapping or
unacknowledged deliveries cannot suppress the next full state. Receipts are
bounded and keyed by Kernel and native session within the Host process; restart or eviction safely causes
a full delivery, without replaying conversation history.

Compaction invalidates the receipt. Claude's synchronous `SessionStart` hook
with `source: compact` supplies the current Host state and turn instructions
before native continuation; attachment excerpts are excluded. Codex restores the
full state with the next Host turn. The supported app-server boundary does not
guarantee synchronous Host injection during an automatic compaction inside a
running turn; a queued steer must not be described as that guarantee. Mutable
Room facts remain available through Room tools.

Pi keeps stable Host instructions in its native system prompt. Its native
`transform_context` hook projects the current state and turn instructions into
user-role context before **each model request**, including tool continuations
and requests after compaction. These projected blocks are not written to the
native transcript; attachment materials and user messages remain in native
history. A Host restart rebuilds the current projection on resume. Language,
Skill, Pack and Capability catalogs do not mutate the system prefix.

OpenClaw Gateway uses `agent.extraSystemPrompt` for stable rules and `agent.message`
for current state, turn instructions and materials. It retains native model
selection, session history, `agent.wait` and `chat.abort`; a native abort
acknowledgement also counts as cancellation when `agent.wait` reports `error`.
State is sent in full each Host turn, including the first turn after compaction.
This RPC does not expose a synchronous callback to restore dynamic Host state
during an in-flight native compaction.

ACP `session/prompt` and Hermes TUI Gateway `prompt.submit` currently expose
user-input context, not a general system-instructions or before-model-request
hook. These adapters send stable rules and full current state in user input
each Host turn. Native in-process plugin hooks do not establish remote protocol
support. Their session diagnostics identify the delivery channel and next-Host-turn
recovery boundary; no undocumented parameters or assistant-transcript injection
are used to simulate a stronger contract.

Host instructions, state and Skill instructions have no combined Host character
cap; native model windows and Kernel compaction retain ownership of the overall
context. `ContextEnvelope.budget` describes material excerpts only. The default
material budget is 6,000 rendered characters and eight items; text attachments
start with at most 3,200 characters. Excerpts are labeled, retained attachment
paths remain complete, and omitted material is reported. Native history, native
base prompts and the user's own request are not truncated by this budget. A
material allowance too small for an omission notice does not reject the Turn;
the envelope still reports that material was omitted.

`npm run test:native-claude-context` runs the installed SDK and native CLI against
a loopback Messages API, verifying actual multi-turn request roles, native
resume, state deltas and the compaction hook without model credentials.
The Pi runtime harness exercises the installed SDK with a deterministic provider.
`npm run test:native-openclaw-context` starts an isolated OpenClaw 2026.9.2 Gateway
and loopback model API to verify request roles, reconnect, native compaction and
provider cancellation. Set `OPENGROVE_TEST_OPENCLAW_CLI` to an installed
`openclaw.mjs` to avoid fetching that version with npx. It does not use personal
Gateway state or model credentials. Relevant PR, merge-queue and Main source
checks run the Claude probe through affected harness selection and the OpenClaw
probe in a separate `native-context` check. The latter may fetch the pinned CLI
and is explicitly tracked as network-dependent.

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
| Claude Agent SDK | `default` | `auto`; await native `setPermissionMode` before sending user input | `bypassPermissions` + `allowDangerouslySkipPermissions` |
| Hermes | `approvals.mode: manual` | `approvals.mode: smart` | `HERMES_YOLO_MODE=1`; isolated configuration also sets `approvals.mode: off` |
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
OpenGrove treats Auto as a Claude SDK permission preset for its supported model roster, just as it does
for Codex and Hermes. The picker, Employee defaults, migrations and API validation do not consult model
IDs or cached support flags. Verify supported Claude models through the shipping SDK and Provider route
during [release acceptance](../development/RELEASE_PROCESS.md#claude-auto-acceptance).
Execution sets the requested native permission mode; this acknowledgement is not a capability probe.
If Auto activation fails or the reported mode differs from `auto`, the
Adapter asks the same native session to switch to `default`. Only an acknowledged Ask transition emits
a visible warning containing the reason and continues the turn; it does not replay the user's prompt.
The Host saves Ask for the affected Employee and matching shared bindings without creating user-override
markers; the chat picker and matching queued messages also switch to Ask. A later user selection takes
priority over recovery from an older turn. Cancellation never initiates fallback. If Ask cannot be enabled,
the turn fails with both causes instead of claiming recovery. Model metadata refresh starts before activation
and remains best-effort without blocking user input on a catalog response. Claude execution uses the Agent SDK.

An actual activation failure (for example, native settings disabling Auto) is reported through the
runtime recovery above. It does not change the product's model support policy. The configured Claude
directory still owns native settings and the model/reasoning catalog cache; that cache has no authority
over permission selection or Employee defaults.

Hermes separates processes by environment and preset. Generated configuration copies preserve user
denials and auxiliary reviewer settings. Full access uses the native YOLO switch, including for
native gates that do not consult `approvals.mode`; native hard blocks and explicit denials still apply.
Ask and auto review verify the effective mode through the public `config.get` RPC (desktop contract
v3+), including for custom gateway commands. An unavailable RPC or mismatched mode stops before
submitting a prompt and explains how to update Hermes or align its configuration.

Without a Provider override, an explicit `HERMES_HOME` / `OPENGROVE_HERMES_HOME`, or
`OPENGROVE_HERMES_ISOLATED_HOME=0`, uses the native directory and retains its data. That directory's
approval configuration must match the requested Ask/Auto preset; OpenGrove does not rewrite it.
`OPENGROVE_HERMES_ISOLATED_HOME=1` requests a configuration copy instead. Provider overrides always
use a copy. These copies are temporary: initialization failures, gateway exit and runtime shutdown
remove them. They do not provide cross-process native session persistence. Startup also removes owned
temporary homes whose Host and recorded gateway processes have exited; unknown ownership or an uncertain
spawn is retained. Native homes are read by Hermes itself, without an extra Host YAML gate. Omitted presets
retain native approval and YOLO settings, including in configuration copies. When a copy is needed, invalid
YAML and unreadable credentials produce actionable errors without echoing configuration contents. Approval and question
bridges support both desktop contract v7 server requests and earlier notification-based requests.
Unanswered approvals default to rejection after five minutes; cancellation, turn completion and gateway
exit settle pending requests. Questions remain human decisions and cancel when their turn ends.

After `npm run build:server`, run `node scripts/certify-hermes-permissions.mjs [hermes-command]` to verify
the three native configuration modes, Full access, manual rejection and explicit deny rules with disposable
homes. This contract check makes no model requests and executes no tool commands; it does not assess
the smart reviewer's model decisions. These permissions were verified against Hermes `v2026.9.7`.

The global PM and its App-scoped bindings default to **Help me approve**, retaining Claude Agent SDK
and DeepSeek v4 Flash. This explicit product default does not depend on the local model cache;
before submitting user input, the native session must acknowledge Auto or the Ask fallback. Other new Employees and chats
prefer **Help me approve** for Codex, Hermes and Claude SDK, independently of model metadata.
Pi, Kimi and OpenCode start
with Ask for approval. OpenClaw remains Gateway-managed; remote permissions belong to the remote owner.

Explicit user choices survive ordinary seed synchronization and take priority over App defaults;
compatible App declarations take priority over product defaults. App version activation and the
explicit restore-App-defaults action can reapply the App's configuration.
App default snapshots remain separate from user selections. Restoring defaults reads the App declaration;
an omitted permission resolves to the product default instead of the user's last choice. Ordinary synchronization
also preserves saved permissions for all product Employees, including PM, and App Employees whose App declares
no permission mode or an unchanged declaration. System permission migrations never create user-override
markers. A changed App declaration can still supply its default. Refreshing or losing Claude model
metadata cannot change either saved permissions or new Employee defaults. Unsupported kernel combinations are still repaired.
A one-time v4 migration raises existing local Employees from Ask for approval to Help me approve
where Auto is supported, including an explicitly saved Ask choice. Auto and Full access stay unchanged.
It runs after legacy model identifiers are resolved, backs up changed state and records completion
atomically with Employees in SQLite/JSON state. Missing or quarantined settings cannot skip an unapplied
migration or repeat a completed one. Older state uses its saved settings versions until this record is established.
Missing modes and unsupported combinations are still normalized. Subsequent permission changes,
including switching back to Ask, survive restarts; PM's App-scoped bindings follow its global definition.
Stored chat choices are read without being rewritten;
an unset chat choice resolves against the selected kernel.

Unrecognized permission values in App declarations or stored Employee records normalize to Ask;
only an omitted value follows the product default. Writable HTTP fields retain their enum validation.

Unsupported Kernel presets are disabled in the picker and rejected at execution. Employee saves and API
writes use that same Kernel rule. Changing a Claude model or Provider never invalidates Auto or blocks
an edit. Unrelated Employee fields save independently of pending permission edits.
Clearing an API
permission with `null` follows App/product defaults and removes its user-override marker.
Within an Employee editing session, each Kernel remembers its model, Provider, reasoning and permission
selection. Returning to a Kernel restores those selections, including an explicit Ask or Full choice.
For a Kernel not yet visited, an incompatible Auto selection changes to Ask and displays a notice.
Employee creation, updates, App imports and seed synchronization apply the same compatibility rule.
Publishing rejects unsupported Kernel/preset combinations. Claude Auto declarations do not depend on a local cache.

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
