// The desktop bundle resolves workspace runtime exports from dist.
// build-server owns the clean workspace rebuild, so clients must not race it.
await import("./build-server.mjs");
await import("./build-clients.mjs");
