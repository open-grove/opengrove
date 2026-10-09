# Kernel capability sources

OpenGrove capability declarations are checked against installed package types
or official upstream sources. Third-party source snapshots are not copied into
this repository.

| Kernel/source | Reviewed source |
| --- | --- |
| Codex | [`openai/codex` app-server protocol at `3f615700`](https://github.com/openai/codex/tree/3f6157004419e21547962670026c6f6001d06fe8/codex-rs/app-server-protocol) |
| Claude Agent SDK | Installed `@anthropic-ai/claude-agent-sdk` `0.3.295` package types; bundled engine [`v2.1.295`](https://github.com/anthropics/claude-code/tree/v2.1.295) |
| Pi | Installed `@earendil-works/pi-durable` / `pi-ai` `1.1.0` types and [`v1.1.0`](https://github.com/earendil-works/pi/tree/v1.1.0); explicit legacy aliases retain [`v0.85.1`](https://github.com/earendil-works/pi/tree/v0.85.1) for old storage |
| Hermes | [`NousResearch/hermes-agent` `v0.21.6`](https://github.com/NousResearch/hermes-agent/tree/v0.21.6) |
| OpenCode | [`anomalyco/opencode` `v1.18.35`](https://github.com/anomalyco/opencode/tree/v1.18.35) |
| Kimi Code | [`MoonshotAI/kimi-code` `@moonshot-ai/kimi-code@2.1.1`](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.1.1) |
| OpenClaw | [`openclaw/openclaw` `v2026.9.9`](https://github.com/openclaw/openclaw/tree/v2026.9.9); the older exact-version certification remains available via `npm run certify:openclaw:2026.8.2` |

Version and verification dates remain attached to individual facts in
`src/kernel/capabilities/native-facts.ts`.

Native integration targets Codex 0.162.0, Claude Agent SDK 0.3.295 / engine
2.1.295, Pi 1.1.0, OpenCode 1.18.35, Kimi Code 2.1.1, Hermes 0.21.6 and
OpenClaw 2026.9.9. Shared transport/session execution comes from
[`@open-grove/agent-host`](https://github.com/open-grove/agent-host).
OpenGrove retains product authorization, context, stores and event projection.
The [package support matrix](https://github.com/open-grove/agent-host/blob/feat/native-agent-extraction/docs/kernel-support.md)
distinguishes contract tests from model-backed probes and documents native limits.

Older capability evidence retains its actual upstream version and date. Updating
the dependency or source review does not certify every existing capability on the
new version. In particular, Pi 0.85 evidence applies to the compatibility adapter,
not automatically to Pi 1.1. Native product-tool/continuation probes are separate
from the complete capability certification suite.

Hermes permission presets separately use the public TUI `config.get` contract and
native `HERMES_YOLO_MODE`, checked against [`v2026.9.7`](https://github.com/NousResearch/hermes-agent/tree/v2026.9.7).
`scripts/certify-hermes-permissions.mjs` checks native configuration and approval gates
without a model call. Ask and auto review require desktop contract v3 or newer;
the adapter does not import Hermes private approval helpers.

New Pi sessions use the native 1.1 durable Harness, conversations and CodingTools.
Existing 0.85 JSONL sessions continue through `native-pi-session.compat.ts` and
pinned legacy dependencies. Their transcripts are not rewritten or replayed into
new sessions. Pi 1.1 native deletion is unavailable and returns an explicit
unsupported result. The compatibility boundary can be removed when an upstream
migration exists or old conversations are deliberately retired.

Hermes now stores product-owned native profiles persistently, separated by session,
provider/tool configuration and permission mode. Closing the runtime preserves
native history for restart. The former ephemeral profiles cannot be reconstructed
from old Host IDs; missing native history is not silently recreated as a resume.

OpenClaw product tools require Agent Host's bundled native Gateway plugin on the
same machine. The plugin is opt-in; a missing plugin fails before dispatch. Native
turns without product tools do not require it. The extraction uses current native
session keys and refuses to recreate deleted bound sessions.

Use `npm run certify:openclaw` for the current Gateway handshake and model-list
contract; the version-specific 2026.8.2 command remains reproducible.
