# Kernel capability sources

OpenGrove capability declarations are checked against installed package types
or official upstream sources. Third-party source snapshots are not copied into
this repository.

| Kernel/source | Reviewed source |
| --- | --- |
| Codex | [`openai/codex` app-server protocol at `3f615700`](https://github.com/openai/codex/tree/3f6157004419e21547962670026c6f6001d06fe8/codex-rs/app-server-protocol) |
| Claude Agent SDK | Installed `@anthropic-ai/claude-agent-sdk` `0.3.235` package types; bundled engine [`v2.1.235`](https://github.com/anthropics/claude-code/tree/v2.1.235) |
| Pi | Installed `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` `0.83.0` package documentation and types; upstream [`v0.83.0`](https://github.com/earendil-works/pi/tree/v0.83.0) |
| Hermes | [`NousResearch/hermes-agent` `v2026.8.3`](https://github.com/NousResearch/hermes-agent/tree/v2026.8.3) |
| OpenCode | [`anomalyco/opencode` `v1.18.3`](https://github.com/anomalyco/opencode/tree/v1.18.3) |
| Kimi CLI | [`MoonshotAI/kimi-cli` at `4a550eff`](https://github.com/MoonshotAI/kimi-cli/tree/4a550effdfcb29a25a5d325bf935296cc50cd417) |
| OpenClaw | [`openclaw/openclaw` `v2026.7.1-2`](https://github.com/openclaw/openclaw/tree/v2026.7.1-2) |

Version and verification dates remain attached to individual facts in
`src/kernel/capabilities/native-facts.ts`.
