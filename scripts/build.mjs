// The desktop bundle resolves runtime exports from agent-protocol/dist.
// build-server owns the clean protocol rebuild, so clients must not race it.
await import("./build-server.mjs");
await import("./build-clients.mjs");
