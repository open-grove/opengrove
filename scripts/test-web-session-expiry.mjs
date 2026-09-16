import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "opengrove-session-expiry-"));
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalApiBase = globalThis.__OPENGROVE_API_BASE__;
try {
  const bundle = join(temporary, "session.mjs");
  await build({
    stdin: {
      contents: `export { fetchJson, BridgeRequestError } from "./web/src/bridge-client";
        export { OpenGroveClientError } from "@opengrove/client";
        export { isRoomsSessionRequiredError } from "./web/src/components/rooms/rooms-api";
        export { openAppSignInUrl } from "./web/src/compat/openapp-session";`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
  });
  const { fetchJson, BridgeRequestError, OpenGroveClientError, isRoomsSessionRequiredError, openAppSignInUrl } =
    await import(pathToFileURL(bundle).href);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 });
  await assert.rejects(fetchJson("/rooms/events"), (error) => {
    assert.equal(
      isRoomsSessionRequiredError(error),
      true,
      "an expired gateway session must trigger Rooms sign-in recovery",
    );
    return true;
  });
  for (const [status, message, needsSession] of [
    [401, "session_required", true],
    [401, "bridge_token_required", false],
    [403, "authentication_required", false],
    [503, "authentication_required", false],
    [503, "session_temporarily_unavailable", false],
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: message }), { status });
    await assert.rejects(fetchJson("/rooms/events"), (error) => {
      assert.equal(error.status, status);
      assert.equal(isRoomsSessionRequiredError(error), needsSession);
      assert.equal(openAppSignInUrl(error), undefined, "Node/CLI requests must not navigate");
      return true;
    });
  }
  const expired = new BridgeRequestError("authentication_required");
  expired.status = 401;
  globalThis.window = { location: new URL("https://portal.example.test/instances/test/ui/") };
  globalThis.__OPENGROVE_API_BASE__ = "/instances/test/api";
  assert.equal(openAppSignInUrl(expired), "https://portal.example.test/");
  for (const [status, message, code, needsSession, portal] of [
    [401, "authentication_required", undefined, true, true],
    [401, "session_required", undefined, true, false],
    [401, "Please sign in", "authentication_required", true, true],
    [401, "bridge_token_required", undefined, false, false],
    [403, "authentication_required", undefined, false, false],
    [503, "session_required", undefined, false, false],
  ]) {
    const error = new OpenGroveClientError(message, { status, code });
    assert.equal(isRoomsSessionRequiredError(error), needsSession, `Client ${status} ${message}`);
    assert.equal(openAppSignInUrl(error), portal ? "https://portal.example.test/" : undefined);
  }
  for (const base of ["/api", "/instances/other/api", "https://foreign.example.test/instances/test/api"]) {
    globalThis.__OPENGROVE_API_BASE__ = base;
    assert.equal(openAppSignInUrl(expired), undefined, "only the current instance's same-origin gateway owns sign-in");
  }
  globalThis.__OPENGROVE_API_BASE__ = "/instances/test/api";
  globalThis.window.openGroveDesktop = {};
  assert.equal(openAppSignInUrl(expired), undefined, "desktop must keep its own sign-in flow");
  delete globalThis.window.openGroveDesktop;
  globalThis.window.location = new URL("https://portal.example.test/ui/");
  assert.equal(openAppSignInUrl(expired), undefined, "unrelated Web pages must not redirect");
  globalThis.fetch = originalFetch;
  console.log("web-session-expiry contract ok: expiry classification and sign-in boundary");
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalApiBase === undefined) delete globalThis.__OPENGROVE_API_BASE__;
  else globalThis.__OPENGROVE_API_BASE__ = originalApiBase;
  await rm(temporary, { recursive: true, force: true });
}
