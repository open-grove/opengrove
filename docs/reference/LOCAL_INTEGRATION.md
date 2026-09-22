# Local product integration

[中文](LOCAL_INTEGRATION.zh-CN.md)

External editors, websites and plugins can use OpenGrove without installing an
OpenGrove App or adopting its UI. Run the local Host, connect with the JavaScript
SDK or the generated HTTP/CLI interface, and supply your product's context and
tools. The Host owns Agent execution; your product owns its UI and business
operations. This contract targets one local owner.

## Deliverables

| Interface | Purpose |
| --- | --- |
| Local Host | Native Kernel adapters, task execution, persistence, interactions and optional modules |
| Host Protocol | Typed operations and OpenAPI, shared by SDK and CLI |
| `@opengrove/sdk` | Generated operations plus `connectOpenGrove`, sessions and task observation |
| `opengrove` CLI | Start the Host, inspect schemas, invoke the same operations from scripts |

Build installable archives with Node.js 24:

```sh
npm ci
npm run pack:local
```

This creates `release/local/opengrove-host-0.7.0.tgz` and
`release/local/opengrove-sdk-0.1.0.tgz`. Install those local files into a consuming
project with `npm install /absolute/path/to/archive.tgz`. The Host archive
contains server code, bundled Skills and runtime dependencies. It excludes
tests, Electron, Desktop output and Web UI output. Its exported
`startOpenGroveServer(options)` returns a Node HTTP server; `server.close()`
stops scheduling and shuts down its workers. It still assembles the existing
Host modules, including internal storage dependencies; it is not a collection of
independently installable Kernel/Room/Skill packages. No registry publication is
implied.

## Start and connect

Use a separate data directory and an explicit Bridge token for your product.
Configuration and native login discovery follow the normal Host rules; see
[Configuration](CONFIGURATION.md) and [Security model](SECURITY_MODEL.md).

```sh
export OPENGROVE_USER_DATA_DIR=/absolute/path/to/product-runtime
export OPENGROVE_WORKSPACE_ROOT=/absolute/path/to/product-project
export OPENGROVE_WEB_AUTH_MODE=bridge-token
export OPENGROVE_BRIDGE_TOKEN=your-local-secret
npx --no-install opengrove start --host 127.0.0.1 --port 37371
```

A source checkout can use `node dist/cli.js` in place of the installed CLI after
`npm run build:server`. The chosen Kernel must be installed and logged in, or
have a configured Provider. A `$login` route uses its native login. Browser
clients need an allowed origin. Keep the token in a trusted local integration or
backend; it authorizes the entire single-owner Host, not a tenant or a single
session. Do not put a shared token into a public website or miniapp bundle.

```js
import { connectOpenGrove } from '@opengrove/sdk';

const op = await connectOpenGrove({
  baseUrl: 'http://127.0.0.1:37371/api',
  token: process.env.OPENGROVE_BRIDGE_TOKEN,
});
const runtime = { kernel: 'codex', providerId: '$login', model: 'gpt-6-astra',
  workspaceRoot: '/absolute/path/to/project' };
const inspection = await op.api.host.runtime.inspect({ body: runtime });
if (!inspection.data.available) throw new Error(inspection.data.reason);
const session = op.session({ sessionId: 'my-project', ...runtime });
const task = await session.run('Describe the supplied selection', {
  selection: 'A product-owned document fragment',
});
const result = await task.wait({ onEvent: event => console.log(event.type) });
console.log(result.run.lifecycle.taskState, result.answer);
```

Choose an actually available model from `op.api.host.runtime.list()` and inspect
its explicit Provider route. Discovery does not prove a successful native call.
The example model is not a promise of availability on every account.

## Sessions, context and results

A Session is a continuing conversation; a Run is one task. The first direct Run
binds a session to Kernel, requested model, Provider and workspace. Conflicting
bindings and simultaneous direct Runs return 409. Use a new session identifier
to change that binding. Inputs include instructions, string or JSON context,
text/image/file attachments, discovered Skill names and access mode. New context
is a snapshot supplied per Run, not automatic bidirectional product state sync.
Native history may retain earlier inputs. Attachment support depends on the
Kernel and model; large media should use project files and product tools.

`task.wait()` consumes cursor-based events and waits for finalized output.
Failed/canceled task results retain their actual lifecycle. `task.result()` reads
a snapshot; `outputAvailable` and `finalized` distinguish saved output from an
unfinished task. Complete answers are persisted separately from bounded event
summaries. `op.api.artifact.artifact` supports create/get/list/update/delete.
`op.api.workspace.file` lists, reads and writes files in the session's bound
workspace. Writes use the revision returned by read; `missing` creates a new
file. Traversal, escaping symlinks and stale revisions are rejected.

`task.cancel()` stops execution; aborting the signal supplied to `wait()` only
stops observation. `task.guide()` and `op.api.run.direct.compact()` reuse native
controls where supported. Events can be replayed while retained; an expired
cursor produces an explicit history error. Completed results survive Host
restart. An interrupted producer is marked lost by the existing recovery path;
this does not promise automatic continuation of unfinished execution.

## Product tools and human interaction

Supply `tools` on the session, each with a `client.*` ID, description, JSON input
schema and async `execute(input, {runId, callId, signal, deadlineAt})` handler. Handlers can
run in your frontend, local plugin or backend. They must validate business
inputs, permissions and return `{ok, value?, error?}`. A tool may ask the user in
the product's own UI before changing anything. See the runnable
[external editor example](../../examples/external-editor/index.mjs).

The Host sends the tool definition to the native Agent, queues its actual call,
waits for the product result and returns that result to the same execution.
Low-level clients use `run.tool.list` and `run.tool.resolve`. The default deadline
is 120 seconds (configurable 1–600 seconds); losing the observer does not silently
succeed. Late results after cancellation/expiry conflict. Repeating an identical
result is accepted; changing it conflicts. Calls are task-scoped and are not
registered globally. Each SDK task handle deduplicates in-flight handlers and
completed results across observation retries. Across handles, process restarts
or multiple clients, the product must persist an idempotency receipt keyed by
`callId`; there is no exactly-once business mutation guarantee. Pending calls
are not replayed after Host restart.

Native approvals/questions use `wait({onApproval, onQuestion})` or
`op.api.interaction`; lists support `runId` filtering. The Kernel and mode
determine whether a native interaction is available and whether it continues
the same execution. Product-tool confirmations are owned by the product and do
not depend on a Kernel-specific question mode. Tool selection and Skill
selection do not replace native sandbox policy: a Kernel may retain its own
shell/filesystem tools. A workspace is a file API boundary, not a universal OS
sandbox. Set `accessMode` deliberately; its enforcement depends on the Kernel.

## Optional modules

| Need | SDK namespace | Dependencies and semantics |
| --- | --- | --- |
| Roles | `api.employee.employee` | Reuse persisted Employee configuration; single tasks can use inline instructions |
| Collaboration | `api.room` | Existing members, messages, delegation and scheduler; retain Room participation/authorization rules |
| Skills and extensions | `api.extension` | Discover, import, publish/refresh/remove Skills; enable/disable/delete native deployments; project/user scope is explicit |
| Workflows | `api.routine.routine` | Create/import/list, run and schedule; Employee steps reuse Rooms; tool steps require registered Host tools |
| History and progress | `api.run` | Sessions, runs, executions, event cursors and task controls |

A task's client callbacks are not durable workflow tool registrations. For a
scheduled workflow, use installed Host tools or Employee steps with their
configured capabilities. The Host must remain running for local schedules;
there is no distributed scheduler or missed-run catch-up guarantee. Extension
publication affects native configuration; start a new session after changing
its deployed extensions. Knowledge/memory/feedback API expansion and server
multitenancy are outside this contract. Existing internal persistence remains.

## CLI and verification

Inspect exact options without connecting:

```sh
opengrove schema run.direct.start
opengrove schema extension.skill.publish
opengrove schema routine.routine.create
opengrove host runtime list
```

Use `OPENGROVE_BRIDGE_URL` and `OPENGROVE_BRIDGE_TOKEN` for commands against a
running Host. High-risk mutations require CLI `--yes`. SDK calls use explicit
methods. Run `npm run test:local-integration` for contracts, workspace conflicts,
product-tool lifecycle and SDK observation tests. Then use
`npm run smoke:server` and `npm run smoke:critical` for broader regression.
Fixture tests do not establish native Kernel behavior; validate a real installed
Kernel with the external editor example.

## Host composition

The same execution path serves the desktop and external products. Optional modules
are selected at startup, not switched while tasks are running:

```js
import { startOpenGroveServer } from '@opengrove/host';
const server = startOpenGroveServer({
  port: 37371,
  statePath: '/absolute/path/to/product-runtime/state.sqlite',
  bridgeToken: process.env.OPENGROVE_BRIDGE_TOKEN,
  modules: [], // tasks, Skills, workspace files, results and interactions
});
```

| Selection | Additional behavior |
| --- | --- |
| `[]` | No default Room/Employee seeding, App activation recovery, mounted App tools or Routine scheduler |
| `['rooms']` | Employees, Rooms, delegation and their existing authorization rules |
| `['rooms', 'routines']` | Workflow APIs/tools and the local scheduler |
| `['rooms', 'apps']` | App mounting, lifecycle, App-owned tools and product UI routes |
| Omitted | All three modules, preserving the normal desktop composition |

Apps and Routines currently require Rooms; invalid combinations fail before
opening the state store. The CLI reads `OPENGROVE_HOST_MODULES=core` or a
comma-separated list such as `rooms,routines`. Explicit programmatic options
win over that variable. `host.runtime.list` returns the selected `modules`;
disabled module endpoints return 404. Disabling a module does not delete its
persisted data. Always use a separate product data directory.

This is an execution/assembly boundary, not an OS security boundary or a claim
that package dependencies have been split. Shared persistence still includes
Room and knowledge-backed storage ports; the knowledge/feedback subsystem is
not newly abstracted by this integration. Module flags do not restrict a native
Agent's own shell or filesystem permissions.

## Reconnection and failure behavior

| Situation | Contract and caller action |
| --- | --- |
| Page closes or observation stops | Host execution continues. Reattach with `op.task(runId, tools)`; pending tools and interactions can be listed again while valid |
| Network request fails | `wait()` rejects. Reuse the task handle and call `wait()` again; do not start another Run as a retry |
| Event history has expired | By default `wait()` rejects. Provide `onHistoryGap(gap)` to acknowledge incomplete replay and continue. Read `result()` for authoritative output |
| Product tool expires or is canceled | Its callback signal aborts at its deadline or when observed as no longer pending. Check the signal before committing a side effect; a late Host submission conflicts |
| Host shuts down or loses a producer | Finished results remain persisted. An unfinished execution does not automatically resume; inspect its actual lifecycle before creating another task |
| Native session continues | Host persists the scoped worker's native resume metadata. Continuation still depends on that Kernel's native session support and configuration |

A callback receives `{runId, callId, signal, deadlineAt}`. Aborting observation
also aborts its handler signal; this cannot undo an already committed business
operation. Persist receipts with the business mutation. Native approval and
question lists are separate from product-owned UI confirmations. Their payloads,
deadlines and supported response forms remain Kernel-specific.

## Product integration patterns

A chat panel is optional. A button, background business event, CLI or another
Agent can start the same task. Products may reuse existing CLI/MCP services and
project files through the selected Kernel's supported configuration, or expose
callbacks when the operation must execute inside their frontend/plugin. A new
`client.*` function is not required for every existing business operation.
Credentials and access rules belong at the actual business-service boundary.
OpenGrove does not infer a product's APIs or automatically grant access to them.

The [external editor](../../examples/external-editor/README.md) has a standalone
web UI (`npm run web`) with configuration inspection, product confirmation,
progress, cancellation and persisted task history. Its local companion keeps
the Host token out of browser assets, validates pending tool calls, and writes
the project mutation and receipt together. It demonstrates one integration;
it is neither a generic embeddable OP UI package nor a complete video editor.

For real native acceptance, build the SDK and run from this repository:

```sh
npm run test:local-integration:real -- --kernel codex --model YOUR_MODEL \
  --provider '$login' --workspace /absolute/path/to/isolated-project
```

Set `OPENGROVE_BRIDGE_TOKEN` and optionally `--base-url`. The probe records the
observed Kernel version and independently checks product-tool execution,
conversation continuation and cancellation. It uses actual model requests;
installation/discovery alone does not pass the probe. Native approvals,
structured questions, Skills and compaction require their own acceptance
cases; this probe does not imply parity between all Kernels.

**Native session and interaction conditions**

When reconnecting a session, restore its original tool definitions, instructions and access configuration as well as the runtime binding. Native Agents apply additional conditions: Codex starts a new native thread when its dynamic tool definitions change. Reusing an OP Session ID does not guarantee native history survives arbitrary configuration changes.

`planMode` preserves OP's existing planning-input adaptation; it does not guarantee a change to the native Agent's collaboration mode. Codex `request_user_input` is unavailable in native Default mode. Neither `planMode: true` nor the discovered `elicitation` capability alone proves this tool is callable in a particular run.
