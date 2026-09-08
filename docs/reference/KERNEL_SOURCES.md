# Kernel capability sources

OpenGrove capability declarations are checked against installed package types
or official upstream sources. Third-party source snapshots are not copied into
this repository.

| Kernel/source | Reviewed source |
| --- | --- |
| Codex | [`openai/codex` app-server protocol at `3f615700`](https://github.com/openai/codex/tree/3f6157004419e21547962670026c6f6001d06fe8/codex-rs/app-server-protocol) |
| Claude Agent SDK | Installed `@anthropic-ai/claude-agent-sdk` `0.3.263` package types; bundled engine [`v2.1.263`](https://github.com/anthropics/claude-code/tree/v2.1.263) |
| Pi | Installed `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` `0.85.1` package documentation and types; upstream [`v0.85.1`](https://github.com/earendil-works/pi/tree/v0.85.1) |
| Hermes | [`NousResearch/hermes-agent` `v2026.8.3`](https://github.com/NousResearch/hermes-agent/tree/v2026.8.3) |
| OpenCode | [`anomalyco/opencode` `v1.18.3`](https://github.com/anomalyco/opencode/tree/v1.18.3) |
| Kimi Code | [`MoonshotAI/kimi-code` `@moonshot-ai/kimi-code@0.36.1`](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%400.36.1) |
| OpenClaw | [`openclaw/openclaw` `v2026.8.2`](https://github.com/openclaw/openclaw/tree/v2026.8.2); exact Gateway v4 challenge-handshake certification via `npm run certify:openclaw:2026.8.2` |

Version and verification dates remain attached to individual facts in
`src/kernel/capabilities/native-facts.ts`.

Native Provider integration targets Codex 0.153.4, Claude Agent SDK 0.3.263,
Pi 0.85.1, OpenCode 1.18.29, Kimi Code 0.41.0, Hermes 0.21.1
(`v2026.9.7`), and OpenClaw 2026.9.2. The source reviews above and individual
capability certifications retain their own versions; a Provider transport check
does not certify every capability of a newer runtime.

Pi uses the public 0.85.1 AgentHarness and AgentLane contracts for durable
turns, native tools, cancellation recovery and compaction. This upgrade starts
fresh native sessions for the former adapter's hashed session IDs. Old files
remain untouched; their native history is not imported. New sessions use Host
IDs in the native header, so listing sessions does not load their transcripts.

Use `npm run certify:openclaw` for the current Gateway handshake and model-list
contract; the version-specific 2026.8.2 command remains reproducible.
