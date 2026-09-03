# OpenGrove Technical Reference

This document covers kernel configuration, provider setup, Bridge API, rooms & ledger, data paths, repository layout, and troubleshooting. For an introduction, see the [README](../../README.md).

## Status

OpenGrove is an early local development project.

- The package retains a CLI entrypoint for built artifacts, but public npm
  publication is disabled. Source checkouts invoke `node dist/cli.js` after a
  server build.
- APIs, state files, and adapter contracts may change.
- The Bridge runs locally and binds to `127.0.0.1` by default.
- Repository development uses Node.js 24 and the npm version bundled with the
  supported Node.js release. The `packageManager` field is compatibility
  metadata for tools that honor it, not an exact npm requirement enforced by CI.

---

## Kernels

OpenGrove selects kernels through `OPENGROVE_KERNEL`. The default is the bundled Claude kernel. Set a concrete kernel id to use another installed kernel.

```bash
# Default kernel
OPENGROVE_KERNEL=claude-code npm start

# Force a specific kernel
OPENGROVE_KERNEL=codex npm start
OPENGROVE_KERNEL=claude-code npm start
OPENGROVE_KERNEL=hermes npm start
OPENGROVE_KERNEL=openclaw npm start
OPENGROVE_KERNEL=opencode npm start
```

### Kernel Details

| Kernel | Runtime path | Provider/config boundary | Overrides |
| --- | --- | --- | --- |
| Codex | `codex app-server --listen stdio://` JSON-RPC bridge | ChatGPT product Login or an explicitly configured OpenGrove Provider; app-server owns events, approvals, dynamic tools, and thread reuse | `OPENGROVE_CODEX_BIN` |
| Claude Agent | Anthropic Claude Agent SDK stream bridge | Native Claude account Login or an explicitly configured OpenGrove Anthropic/AWS/Vertex Provider; SDK owns the session and Claude Agent tools | `OPENGROVE_CLAUDE_CLI_PATH` |
| Hermes | TUI Gateway over stdio JSON-RPC | Gateway events, native approval/question requests, native skill directory | `OPENGROVE_HERMES_BIN`, optional `OPENGROVE_HERMES_TUI_GATEWAY_PYTHON` |
| Pi | Pi Agent SDK in-process | OpenGrove passes the explicitly selected Provider/model into `NativePiSession`; Pi configuration is not imported into the Host Provider directory | Optional `PI_MODEL` |
| OpenClaw | Gateway WebSocket (`models.list`, `sessions.patch`, `chat.send`, `agent.wait`) | Gateway-discovered upstreams are Providers; OpenClaw keeps credentials while OpenGrove pins the exact `provider/model` before sending | `OPENGROVE_OPENCLAW_GATEWAY_URL`, `OPENGROVE_OPENCLAW_GATEWAY_TOKEN` |
| OpenCode | ACP over stdio (`opencode acp`) | OpenGrove passes an explicitly selected Host Provider; OpenCode-owned Provider configuration is not imported | `OPENGROVE_OPENCODE_BIN` |
| Kimi Code | ACP over stdio (`kimi acp`) | Kimi product Login or an explicitly selected external Provider supplied through `KIMI_MODEL_*` | `OPENGROVE_KIMI_BIN` |

### Codex-specific Options

```bash
OPENGROVE_KERNEL=codex
OPENGROVE_CODEX_MODEL=gpt-5.4
OPENGROVE_CODEX_APPROVAL_POLICY=never
OPENGROVE_CODEX_SANDBOX=danger-full-access
npm start
```

### Hermes-specific Options

```bash
OPENGROVE_KERNEL=hermes
OPENGROVE_HERMES_MODEL=your-model
OPENGROVE_HERMES_PROVIDER=your-provider
OPENGROVE_HERMES_TOOLSETS=shell,edit
# Optional, only needed when OpenGrove cannot infer Hermes' venv python from OPENGROVE_HERMES_BIN.
OPENGROVE_HERMES_TUI_GATEWAY_PYTHON=/path/to/hermes-agent/venv/bin/python
npm start
```

### OpenClaw Gateway Options

```bash
OPENGROVE_KERNEL=openclaw
npm start
```

OpenGrove first honors explicit `OPENGROVE_OPENCLAW_GATEWAY_URL` / `OPENGROVE_OPENCLAW_GATEWAY_TOKEN` overrides. If they are not set, it reads the local OpenClaw config at `~/.openclaw/openclaw.json` and connects to the configured local or remote Gateway. The Bridge reads the configured model catalog at startup, whenever Settings is opened, and every six hours. It stores only Provider/model metadata; OpenClaw keeps the credentials.

The Gateway bridge is certified against OpenClaw `2026.8.2`. It waits for the Gateway challenge and negotiates wire protocol v4 exactly; `npm run certify:openclaw:2026.8.2` launches the exact upstream package in an isolated local state directory and verifies the real challenge handshake plus `models.list`. Existing long-running `agent.wait` behavior remains Kernel-owned: OpenGrove adds no fixed Run deadline, and user cancellation is the Host liveness boundary.

## Kernel Integration Layers

Kernel integrations are split into four layers:

| Layer | Purpose |
| --- | --- |
| Transport | Owns the wire boundary: ACP, stdio JSON-RPC, HTTP/SSE, Gateway WebSocket, PTY terminal, structured stream JSON CLI, or SDK in-process. |
| Event projector | Converts native events into OpenGrove events such as `assistant.delta`, `tool.started`, `tool.finished`, and `approval.requested`. |
| Kernel manifest | Records launch command, session strategy, provider binding, approval policy, event mapping, capabilities, and rollout status. |
| Harness template | Gives each protocol a fake-server test shape so new kernels can be added without guessing at runtime behavior. |

Implemented runtime paths include Codex app-server JSON-RPC, Claude Agent SDK streaming, Hermes TUI Gateway, Pi SDK in-process, OpenClaw Gateway WebSocket, and OpenCode/Kimi ACP.

---

## Providers

Provider setup can be managed in the settings UI or through environment variables. The built-in catalog currently covers WW, Volcengine, OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, AWS Bedrock, Google Vertex AI, Zhipu GLM, Kimi, Alibaba Bailian, MiniMax, Xiaomi MiMo, AiHubMix, Azure OpenAI, and xAI. Public model metadata comes from a bundled Models.dev snapshot plus a small OpenGrove connection overlay. Models with the same catalog display name are shown once while every exact upstream wire id remains available for routing; differently named variants such as Fast or Free remain separate choices.

A route identity is either **Login** or **Provider**. Login is a Kernel product-account login, currently ChatGPT/Codex, Claude Agent, or Kimi Code. It is displayed and managed separately from Providers. OpenGrove launches the Kernel's native login/status/logout commands and does not copy or persist its tokens. Authenticated Login routes are projected into model selectors only at runtime. Runtime route priority is Employee override, then the saved default for the exact model, then selection required. New settings write `$login` for Login and concrete ids for Providers; `$native` is accepted only by the OpenGrove 0.6.1 upgrade migration.

The main Provider list contains only services that are enabled, have a configured credential, or were added by the user. Inactive built-ins stay under **Add Provider**. OpenGrove does not scan Codex, Claude, Hermes, Pi, OpenCode, or Kimi Provider configuration into this list. OpenClaw Gateway upstreams are the deliberate exception because the Gateway itself is the selected runtime boundary; they remain Gateway-managed Providers and their credentials stay in OpenClaw.

The settings UI writes local bridge preferences to the OpenGrove data directory,
normally `bridge-settings.json` under the OS app-data path. That file may
contain pasted provider API keys, custom provider definitions, kernel/provider
bindings, App Store registry settings, and voice settings. Treat it as a local
secret file; prefer environment variables for shared or reproducible setups.

### Environment File Load Order

1. `OPENGROVE_ENV_FILE`
2. `~/.opengrove/.env.local`
3. `./.env.local`
4. `./.env`

### Minimal Config

```bash
OPENGROVE_KERNEL=claude-code
OPENAI_API_KEY=replace-with-your-key

# Optional bridge protection for non-browser clients.
OPENGROVE_BRIDGE_TOKEN=replace-with-local-bridge-token
OPENGROVE_BRIDGE_ALLOWED_ORIGINS=http://127.0.0.1:37371
```

The browser extension reads the same bridge token from `chrome.storage.local.opengroveBridgeToken`.

---

## Rooms and Ledger

Rooms are backed by the server-side `RoomChannelStore`, not browser `localStorage`. The UI fetches the current Rooms snapshot from `/rooms`, polls `/rooms/events` for incremental changes, and posts user messages back to the bridge. Authoritative Room state is indexed in `local-state.sqlite`; large payloads are content-addressed under `state-blobs/`.

The local room ledger is the source of truth for room members, messages, run
status, and the incremental event stream consumed by the UI.

When a message targets local members, the bridge schedules one room agent run per runnable target, builds a per-member prompt with the current message and a recent ledger window, then writes final results back to the same ledger. Kernels that support native sessions still keep stable per-room-member native continuity behind that ledger-backed prompt. If an agent needs older channel context, it can call `room.ledger.read` with `roomId`, optional `query`, `limit`, `beforeSeq`, or `afterSeq`. The tool returns only room-visible messages by default and identifies the authoritative room with `sourceRoomId`. For a current membership check, callers must explicitly pass `includeMembers: true`; the added member summaries contain only ID, name, status, last activity, and the disabled flag, never the full role, Kernel, model, or App configuration. Ledger attachments never expose host-local paths, and inline text or data URLs larger than 16 KiB are omitted while attachment metadata remains available.

## App Store

The App Store is a configurable package registry. Listing, archive download,
installation, repair, and mounted-App publishing are mediated by the local
bridge. Installed packages are unpacked into the platform-native OpenGrove
Programs directory; there is no Connector or hosted runtime in this path.

Store-managed Apps use side-by-side program generations. The Bridge records the
active program path separately from the persistent Workspace path, validates a
new generation, and commits the mount pointer before attempting best-effort
cleanup of the previous generation. The program contains a compatibility link
at the manifest-declared workspace location, so App code can keep resolving the
same relative workspace path without making the Workspace part of the program
replacement transaction.
If the active program has a local `.git` repository, activation copies it into
the next generation after final target validation. Large repositories therefore
increase update time and temporary disk usage; Store archives never supply this
local repository state.

After WW authentication, the bridge reads `GET /v1/app-store/install-policy`
with the user's access token. The response supplies `policyKey`,
`assignmentSource`, and the authorized `apps` array (`packageKey`,
optional `minimumVersion` and `minHostReleaseNumber`; the Store catalog remains
the source of truth for the installable version). The bridge does not derive
this policy from Roles and does not call WW install-policy administration
endpoints. A missing endpoint, empty response, or empty `apps` array disables
this optional reconciliation for the current attempt without requesting the
catalog, changing local App state, or surfacing a workspace failure.

Portable packages may contain redistributable source, workspace templates,
manifest files, employees, skills, hooks, and scripts. Every packaging path
excludes Workspace, Git history, and its declared default/manifest paths. Local
drafts and formal-release source snapshots additionally exclude native
session/config directories and caches. The packer treats remaining file
contents as opaque; publishers remain responsible for excluding credentials,
private data, and machine-local configuration from direct `app pack` / `app
publish` flows.

---

## Bridge API

The local bridge is the boundary between UI, state, tools, and kernels.
Packaged desktop users may complete account onboarding by signing in or by
continuing without an OpenGrove Cloud account. That choice is a local UI
preference, separate from account session state. It never bypasses the
desktop's in-memory Bridge token. Browser session deployments still require an
account, and Cloud-backed features remain gated at their feature boundary.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET` | local Bridge liveness and capability summary; never validates the WW session |
| `/auth/email-codes` | `POST` | request a WW email code and report whether the email needs registration fields |
| `/auth/login` | `POST` | sign in with the email code; new accounts also send the user-selected ISO country/region and, when required, an invite code |
| `/auth/session` | `GET` | event-driven WW session restore with authenticated, unauthenticated, and temporarily unavailable outcomes |
| `/auth/client-update` | `GET` | current desktop release plus the applicable Cloud release; signed-in sessions receive the full version contract, while signed-out token-authorized desktop clients use the public sanitized version contract |
| `/auth/activity` | `POST` | once-daily minimal account activity for signed-in Electron desktop; carries no local product data |
| `/inventory` | `GET` | knowledge, memory, artifacts, sessions, tools, skills, and capabilities |
| `/ask/stream` | `POST` | streaming agent turn API |
| `/approvals` | `GET` | list approval requests |
| `/approvals/:id/approve` | `POST` | approve a pending action |
| `/approvals/:id/reject` | `POST` | reject a pending action |
| `/memory` | `GET` | list or search memory |
| `/artifacts` | `GET` / `POST` | list or create artifacts |
| `/routines` | `GET` | list routines |
| `/context-records` | `GET` | recent prompt/context diagnostics |
| `/settings` | `GET` / `PATCH` | read or update local bridge settings |
| `/extensions` | `GET` | scan mounted skills, CLIs, MCP config, hooks, plugins, and tool roots |
| `/extensions/skills/*` | `POST` | import, publish, republish, or unpublish skills for native kernels |
| `/app-store` | `GET` | list registry packages and local install status |
| `/app-store/publish-registry` | `POST` | publish registry metadata supported by the configured registry |
| `/app-store/publish-mounted-app/prepare` | `POST` | prepare an admin-only mounted-App release snapshot from current local defaults |
| `/app-store/publish-mounted-app` | `POST` | validate, package, and publish the submitted admin release snapshot |
| `/app-store/publish-employee` | `POST` | package and publish an employee |
| `/app-store/install` | `POST` | download and install a package locally |
| `/app-store/repair` | `POST` | repair a local package installation |
| `/app-store/packages/:packageId/archive` | `GET` | download an App Store archive |
| `/apps/:appId/files` | `GET` | list mounted App workspace files |
| `/apps/:appId/file` | `GET` / `PATCH` | read or update one mounted App workspace file |
| `/apps/:appId/raw/*` | `GET` | serve mounted App raw assets/files |
| `/voice/stt/providers` | `GET` | list configured speech-to-text providers |
| `/voice/transcriptions` | `POST` | transcribe uploaded audio through the selected STT provider |
| `/rooms` | `GET` / `POST` | read the room ledger snapshot or create a room |
| `/rooms/events` | `GET` | poll room ledger events after `afterEventSeq` |
| `/rooms/dm` | `POST` | open or create a direct room with one member |
| `/rooms/:roomId` | `PATCH` | update local room title, pin/archive state, or badge |
| `/rooms/:roomId/read` | `POST` | advance the Room read cursor through the body’s client-observed `observedEventSeq` |
| `/rooms/members` | `POST` | upsert a global room member |
| `/rooms/:roomId/members` | `POST` | add a member to a room |
| `/rooms/:roomId/members/:memberId` | `DELETE` | remove a member from a room |
| `/rooms/:roomId/messages` | `GET` / `POST` | read room messages or post a user message and schedule room runs |
| `/rooms/:roomId/messages/:messageId` | `PATCH` | update local message status, run metadata, or rendered parts |

When `OPENGROVE_BRIDGE_TOKEN` is set, non-health endpoints require the `x-opengrove-token` header.

### Browser synchronization contract

The browser hydrates bounded snapshots, then advances with cursors or
revisions. It must not repeatedly download complete state when the Bridge can
prove that nothing changed.

- `/events` returns a bounded latest snapshot when no cursor is supplied. The
  browser then requests deltas after the returned cursor, uses a 25-second long
  poll only after it has a cursor, catches up in bounded pages, and replaces its
  cache with a fresh snapshot when the Bridge returns `resetRequired`.
- Rooms hydrate from `/rooms`, then read `/rooms/events` after
  `afterEventSeq`. Empty delta requests may long-poll for 25 seconds. A stale
  sequence or an event that cannot be applied causes a bounded `/rooms`
  resnapshot.
- Revision-aware resources such as context records, runs, executions, App
  files, and flows send `afterRevision`; an `unchanged` response retains the
  existing payload and only advances its revision.
- Polling runs only while the relevant UI is enabled and does not refetch in a
  background tab unless a query explicitly requires it.

The implementation sources of truth are
[`use-agent-events-query.ts`](../../web/src/runtime/use-agent-events-query.ts),
[`rooms-server-sync.ts`](../../web/src/components/rooms/rooms-server-sync.ts),
and [`use-bridge-queries.ts`](../../web/src/runtime/use-bridge-queries.ts).
`npm run check:web-bridge-sync` enforces the long-poll and aggregation policy.

---

## Local Data

OpenGrove separates replaceable Store programs, user-owned App Workspaces, and
Host state instead of forcing them under one physical root:

| Platform | Programs | Workspaces | Host state root |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/OpenGrove/programs/` | `~/OpenGrove/workspaces/` | `~/Library/Application Support/OpenGrove/` |
| Windows | `%LOCALAPPDATA%/OpenGrove/programs/` | `%USERPROFILE%/OpenGrove/workspaces/` | `%APPDATA%/OpenGrove/` |
| Linux | `$XDG_DATA_HOME/opengrove/programs/` or `~/.local/share/opengrove/programs/` | `~/OpenGrove/workspaces/` | `$XDG_CONFIG_HOME/opengrove/` or `~/.config/opengrove/` |

| Path | Purpose |
| --- | --- |
| `<root>/data/local-state.sqlite` | SQLite index for persisted memory, artifacts, sessions, runs, approvals, routines, events, and the server-backed room ledger |
| `<root>/data/state-blobs/` | gzip-compressed, content-addressed large messages and tool/result payloads |
| `<root>/data/bridge-settings.json` | local bridge settings, including kernel/provider bindings, custom providers, optional API keys, App Store registry, and voice settings |
| `<root>/data/opengrove-vault/` | file-first vault mirror for OpenGrove knowledge |
| `<root>/data/codex-threads.json` | OpenGrove session to Codex thread bindings |
| `<root>/data/trajectories/` | run trajectory records |
| `<workspaces>/app-id/workspace/` | stable persistent Workspace for a Store-managed App |
| `<programs>/app-id/version-generation/app/` | replaceable side-by-side Store App program generation; the mounted pointer selects the active generation |
| `<state-root>/apps/` and `<state-root>/data/app-store/programs/` | legacy layout sources; after a validated migration and healthy startup they are renamed with `.legacy-v2`, never deleted by the migration |
| `<root>/logs/` | desktop main/bridge logs |

Legacy repository-local `data/` is still ignored by git, but default local and
desktop startup do not import persisted state from those old directories. A
source CLI can still use paths under the current checkout's `data/`: the
knowledge vault does so when `OPENGROVE_DATA_DIR` is unset, and diagnostic
captures do so unless their capture-specific paths are overridden. The path
overrides below select storage for the current runtime only.

Override paths with:

```bash
OPENGROVE_USER_DATA_DIR=/absolute/path/to/opengrove-user-data
OPENGROVE_DATA_DIR=/absolute/path/to/opengrove-data
OPENGROVE_STATE_PATH=/absolute/path/to/local-state.sqlite
OPENGROVE_BRIDGE_SETTINGS_PATH=/absolute/path/to/bridge-settings.json
OPENGROVE_PROGRAMS_DIR=/absolute/path/to/programs
OPENGROVE_WORKSPACES_DIR=/absolute/path/to/workspaces
```

`OPENGROVE_APP_STORE_APPS_DIR` remains a compatibility alias for
`OPENGROVE_WORKSPACES_DIR` during the legacy migration window.

---

## Browser Extension

OpenGrove includes a small browser extension in `extension/` for page context.

1. Open Chrome or Edge extension management.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select this repository's `extension/` directory.

The extension sends selected page context to OpenGrove, but it does not call the local bridge directly, does not persist page content, does not read password inputs, and skips browser-internal or sensitive URL surfaces.

---

## Repository Layout

```text
src/core/              Stable event, policy, registry, store, and shared type contracts
src/app/               OpenGrove composition root and app wiring
src/kernel/            Kernel contracts, discovery, tool bridge, and adapters
src/runtime/           Codex, Claude Agent, Hermes, Pi, HTTP, generic CLI, proxy, capture, transports, and projectors
src/server/            Local bridge, settings, kernel selection, routes, approvals, artifacts
src/rooms/             Server-backed local room ledger, members, messages, and room events
src/knowledge/         Knowledge store views, organizer helpers, feedback, and vault logic
src/skills/            Skill catalog, runtime, and native publication helpers
src/tests/             Harness tests for skills, kernels, runtimes, and bridge selection
src/evals/             Evaluation runner
web/                   React local UI
web/src/components/rooms/
                       Rooms, contacts, member targeting, mentions, and room API integration
extension/             Browser context adapter
assets/brand/          Wordmark, sapling mark, and visual system assets
```

---

## Development

Install once:

```bash
npm ci
```

Run checks:

```bash
npm run typecheck
npm run build
npm run smoke
npm run test:rooms
npm run test:harness
```

Run the desktop shell from source:

```bash
npm start
```

This builds the server, shared web renderer, and Electron entrypoints before launching the desktop shell.

Run the browser UI bridge explicitly:

```bash
npm run bridge:web
```

The `bridge:web` command builds server and web assets, sets `OPENGROVE_ENABLE_BROWSER_UI=1`, then starts `dist/server/local-bridge.js`.

Package a desktop build:

```bash
npm run pack:desktop
```

After `npm run build:server`, the source CLI exposes the API bridge with:

```bash
node dist/cli.js start
node dist/cli.js --version
```

---

## Design Principles

- Keep kernel-specific behavior in adapters.
- Keep host concepts small, typed, and visible.
- Prefer explicit user context over ambient prompt stuffing.
- Let native kernels use their own tools and skill loaders when possible.
- Store secrets only in ignored local files, environment variables, or provider-native config.
- Make risky actions visible through policy, approvals, and event logs.
- Keep the UI quiet: collapsed tool summaries, stable status rows, and no half-wired controls.
- Keep interaction color semantic: blue for active/focus/action states, green for OpenGrove identity and true success.

---

## Security Notes

OpenGrove runs its workspace locally, but it can still connect to powerful native agents and tools. Treat browser content, remote pages, and inbound instructions as untrusted.

- The local bridge binds to `127.0.0.1` by default.
- Set `OPENGROVE_BRIDGE_TOKEN` before exposing the bridge to any non-local client.
- Restrict CORS with `OPENGROVE_BRIDGE_ALLOWED_ORIGINS`.
- Do not commit `.env`, `.env.local`, bridge settings files, provider keys, OAuth tokens, native auth files, or capture logs.
- Keep credentials in ignored local files, environment variables, or
  provider-native stores. Repository and organization security policy is
  responsible for source secret protection; App packaging does not interpret
  arbitrary file contents.
- Review approvals for commands, file changes, desktop/browser actions, and durable memory writes.

---

## Troubleshooting

### No kernel was found

Install a supported kernel or point OpenGrove to its binary:

```bash
OPENGROVE_CODEX_BIN=/absolute/path/to/codex npm start
```

### The UI cannot talk to the bridge

Check that the bridge is running and that the browser origin is allowed:

```bash
curl http://127.0.0.1:37371/health
```

If `OPENGROVE_BRIDGE_TOKEN` is set, make sure the UI or extension is using the same token.

### Provider credentials are not detected

Put Provider secrets in `~/.opengrove/.env.local` or `./.env.local`, then restart the bridge. Product Login credentials stay in the Kernel's own config directory and can be checked from the Login section in Settings. Open Settings to trigger an OpenClaw Gateway Provider refresh.

### State looks stale

Stop the bridge, then back up `local-state.sqlite`, its `-wal`/`-shm` sidecars
if present, `state-blobs/`, and `bridge-settings.json` as one unit. Restart only
after the copy finishes. OpenGrove will recreate missing local state files.
