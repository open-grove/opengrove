# OpenGrove Project Overview

OpenGrove is a desktop workspace for native coding agents. It gives Codex,
Claude Agent, Hermes, Pi, OpenClaw, OpenCode, and Kimi a shared host for rooms,
contacts, knowledge files, approvals, artifacts, mounted apps, and diagnostics.

OpenGrove does not replace a kernel's model loop. Native kernels keep their own
tools, sessions, auth, compaction, provider behavior, and configuration.
OpenGrove owns the product layer around them.

## Current Product Surface

- **Local UI**: React workspace for chat, rooms, contacts, knowledge, settings,
  apps, voice input, approvals, and diagnostics.
- **Desktop shell**: Electron host that starts the local bridge, injects the
  in-memory bridge token, captures logs, and keeps renderer Node access off.
- **Local bridge**: Node HTTP server on loopback. CLI mode defaults to
  `127.0.0.1:37371`; desktop mode uses a random loopback port. It serves the UI,
  persists host state, and routes turns to the selected kernel.
- **Room ledger**: server-backed local room state for members, messages,
  mentions, and run status.
- **Knowledge vault**: file-first local knowledge under the OpenGrove data
  directory plus JSON-backed ledgers for feedback, evidence, revisions, and
  delivery.
- **Kernel adapters**: protocol-native bridges for Codex, Claude Agent, Hermes,
  Pi, OpenClaw, OpenCode, Kimi, and compatible external CLIs.
- **OpenGrove Apps**: mounted local app roots that can bundle skills, CLIs,
  workspace files, provider env requirements, previews, and developer sessions.
- **App Store**: configurable package registry whose downloads are installed as
  side-by-side local program generations, with persistent App Workspaces kept
  at stable Host-owned paths.
- **Browser extension**: a small page-context adapter. It does not persist page
  content or call the bridge directly.

## Deployment Shape

OpenGrove ships one local product shape.

- **Local runtime and data**: `npm start` runs the desktop shell from source;
  `npm run bridge:web` runs the local browser UI and bridge on this machine.
  Chat history, rooms, the knowledge vault, settings, apps, kernel sessions,
  provider auth, and local workspaces stay local. Default state lives in the OS
  app-data directory; legacy persisted state is not imported from a
  repository-local `data/` directory.

Hosted Cloud, Cloud Connector, server profile, Postgres service storage,
Matrix remote rooms, and Invite Landing are outside this repository.

## Architecture

OpenGrove has three responsibility layers.

| Layer | Owns |
| --- | --- |
| Kernel | Native reasoning loop, native tools, auth, session semantics, provider config, compaction, and runtime-specific permissions |
| Host | Local state, bridge APIs, rooms, knowledge files, approvals, artifacts, settings, provider bindings, extension inventory, diagnostics, and event history |
| Adapter | Mapping native transport/events/tools into OpenGrove events, runtime controls, knowledge sources, approvals, and session handles |

The rule is simple: preserve native power at the kernel boundary, normalize only
what the host and UI need to understand.

## Repository Map

| Path | Purpose |
| --- | --- |
| `src/core/` | Domain contracts: events, policy, registries, stores, shared runtime and knowledge types |
| `src/app/` | Composition root that wires stores, tools, skills, packs, context, and kernels |
| `src/kernel/` | Adapter contracts, discovery, manifests, tool bridge, and kernel-specific adapters |
| `src/runtime/` | Concrete protocol bridges: Codex RPC, Claude SDK/CLI, ACP, HTTP/SSE, Gateway WebSocket, Pi, generic CLI, captures, projectors |
| `src/server/` | Local bridge, routes, settings, kernel selection, provider binding, approvals, rooms, apps, voice, preview, and knowledge file orchestration |
| `src/rooms/` | Server-backed room ledger and event model |
| `src/knowledge/` | Knowledge store views, organizer helpers, feedback, and vault-facing records |
| `src/skills/` | Skill catalog, invocation state, and native skill publication helpers |
| `web/src/` | Local React UI and browser-side bridge client |
| `desktop/` | Electron main/preload, bridge supervisor, custom protocol, shell env, and diagnostics plumbing |
| `extension/` | Browser page-context adapter |

## Context And Safety

OpenGrove should not dump the whole workspace into every prompt. Default turn
context is small: user input, explicit attachments, explicit context chips,
runtime controls, and narrow hints. Full files should be read through native
tools when needed.

Secrets belong in ignored local files, environment variables, or native provider
config. They must not be copied into prompts, event logs, workspace files, or
tracked docs.

Risky actions should stay visible through typed approvals, event logs, and UI
feedback. The bridge runs locally and binds to `127.0.0.1` by default; set
`OPENGROVE_BRIDGE_TOKEN` before exposing it to anything non-local.

## Documentation

- `README.md`: install, quickstart, feature summary, and support matrix.
- `docs/development/BUILDING.md`: source setup, desktop and Web development,
  build outputs, packages, and troubleshooting.
- `docs/reference/TECHNICAL_REFERENCE.md`: kernel/provider setup, Bridge API, data paths,
  repository layout, security notes, and troubleshooting.
- `docs/reference/KERNEL_INTEGRATION.md`: native Kernel adapter contracts,
  event projection, sessions, tools, and harnesses.
- `docs/product/OPENGROVE_APP_SPEC.md`: mounted app manifest and capability layout.
- `docs/architecture/OVERVIEW.md`: public architecture and responsibility boundaries.
- `docs/development/RELEASE_PROCESS.md`: version, release-note, artifact gate,
  and release promotion checklist.

Long drafts, experiments, and sensitive local notes should live outside tracked
public docs, for example under `docs.local/`.
