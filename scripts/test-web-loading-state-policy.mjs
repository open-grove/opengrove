import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const result = await build({
  entryPoints: [resolve("web/src/app-mounted-app-workflow-model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const source = result.outputFiles[0].text;
const model = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const bootstrapResult = await build({
  entryPoints: [resolve("web/src/runtime/client-bootstrap.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const bootstrapSource = bootstrapResult.outputFiles[0].text;
const bootstrapModule = await import(`data:text/javascript;base64,${Buffer.from(bootstrapSource).toString("base64")}`);
const startupTimeoutResult = await build({
  entryPoints: [resolve("web/src/components/app-shell/startup-timeout-policy.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const startupTimeoutSource = startupTimeoutResult.outputFiles[0].text;
const startupTimeoutPolicy = await import(
  `data:text/javascript;base64,${Buffer.from(startupTimeoutSource).toString("base64")}`
);
const mountedApp = {
  id: "app:real-app",
  name: "real-app",
  title: "Real App",
  kind: "app",
  enabled: true,
};

assert.equal(startupTimeoutPolicy.resolveStartupTimeoutMs({}), 15_000);
assert.equal(
  startupTimeoutPolicy.resolveStartupTimeoutMs({ recoveringLocalService: true }),
  45_000,
  "a recovering desktop Bridge must retain its loading state through normal cold-start CLI discovery variance",
);
assert.equal(
  startupTimeoutPolicy.resolveStartupTimeoutMs({ recoveringLocalService: true, timeoutMs: 10 }),
  10,
  "explicit harness and product overrides must remain authoritative",
);

assert.equal(
  model.resolveActiveMountedApp({
    activeMountedAppId: "removed-app",
    activeView: "app",
    embeddedAppId: "",
    embeddedMode: false,
    mountedApps: [mountedApp],
    pendingMountedAppOpenId: "",
  }),
  mountedApp,
  "a stale stored App id must fall back synchronously instead of flashing an empty surface",
);
assert.equal(
  model.resolveActiveMountedApp({
    activeMountedAppId: "real-app",
    activeView: "app",
    embeddedAppId: "",
    embeddedMode: false,
    mountedApps: [mountedApp],
    pendingMountedAppOpenId: "installing-app",
  }),
  undefined,
  "an explicit unresolved App request must not show a different mounted App",
);

assert.equal(
  model.resolveMountedAppHostState({
    activeView: "app",
    hasActiveMountedApp: false,
    hasUnresolvedMountedAppRequest: false,
    inventoryError: false,
    inventoryFetching: true,
    inventoryPending: true,
  }),
  "resolving",
  "an App route must preserve its shell while inventory is still resolving",
);
assert.equal(
  model.resolveMountedAppHostState({
    activeView: "app",
    hasActiveMountedApp: true,
    hasUnresolvedMountedAppRequest: false,
    inventoryError: false,
    inventoryFetching: true,
    inventoryPending: true,
  }),
  "ready",
  "an already resolved App must stay visible during background inventory refreshes",
);
assert.equal(
  model.resolveMountedAppHostState({
    activeView: "app",
    hasActiveMountedApp: false,
    hasUnresolvedMountedAppRequest: false,
    inventoryError: false,
    inventoryFetching: false,
    inventoryPending: false,
  }),
  "empty",
  "a settled inventory without a matching App is an empty state, not an unsupported App",
);
assert.equal(
  model.resolveMountedAppHostState({
    activeView: "app",
    hasActiveMountedApp: false,
    hasUnresolvedMountedAppRequest: true,
    inventoryError: false,
    inventoryFetching: true,
    inventoryPending: false,
  }),
  "resolving",
  "an explicit App request must keep its shell while a refreshed inventory is in flight",
);
assert.equal(
  model.resolveMountedAppHostState({
    activeView: "app",
    hasActiveMountedApp: false,
    hasUnresolvedMountedAppRequest: true,
    inventoryError: false,
    inventoryFetching: false,
    inventoryPending: false,
  }),
  "missing",
  "a settled explicit App request must report a missing App instead of reusing the no-canvas surface",
);
assert.equal(
  model.resolveMountedAppHostState({
    activeView: "app",
    hasActiveMountedApp: false,
    hasUnresolvedMountedAppRequest: false,
    inventoryError: true,
    inventoryFetching: false,
    inventoryPending: false,
  }),
  "unavailable",
  "an inventory failure must remain distinct from a genuinely empty App inventory",
);
assert.equal(
  model.resolveMountedAppHostState({
    activeView: "chat",
    hasActiveMountedApp: false,
    hasUnresolvedMountedAppRequest: false,
    inventoryError: false,
    inventoryFetching: true,
    inventoryPending: true,
  }),
  "inactive",
);

const desktopBootstrapResult = await build({
  entryPoints: [resolve("web/src/runtime/desktop-bootstrap-policy.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const desktopBootstrapPolicy = await import(
  `data:text/javascript;base64,${Buffer.from(desktopBootstrapResult.outputFiles[0].text).toString("base64")}`
);
assert.equal(
  desktopBootstrapPolicy.desktopBridgeReadyForBootstrap(undefined),
  true,
  "normal Web bootstrap must not wait for a desktop Bridge",
);
assert.equal(
  desktopBootstrapPolicy.desktopBridgeReadyForBootstrap({
    bridgeStartupState: { stage: "starting", attempt: 1 },
  }),
  false,
  "desktop bootstrap must wait while the local Bridge starts",
);
assert.equal(
  desktopBootstrapPolicy.desktopBridgeReadyForBootstrap({
    bridgeStartupState: {
      stage: "blocked",
      attempt: 1,
      code: "state_locked",
      message: "locked",
      actions: ["retry"],
    },
  }),
  false,
  "a startup blocker must stay in the startup experience instead of issuing a bootstrap request",
);
assert.equal(
  desktopBootstrapPolicy.desktopBridgeReadyForBootstrap({
    bridgeStartupState: { stage: "ready", generation: 1 },
  }),
  true,
  "desktop bootstrap may start after the local Bridge reports ready",
);
assert.equal(
  desktopBootstrapPolicy.desktopBridgeReadyForBootstrap({
    bridgeStartupState: { stage: "starting", attempt: 1 },
    getBridgeStartupState: () => ({ stage: "ready", generation: 2 }),
  }),
  true,
  "the live preload getter must supersede the immutable initial startup snapshot",
);
assert.equal(
  desktopBootstrapPolicy.desktopBridgeReadyForBootstrap({}),
  false,
  "desktop bootstrap must not infer readiness when the Host startup state is unavailable",
);

const originalFetch = globalThis.fetch;
let bridgeStateListener;
const bootstrapRequests = [];
globalThis.fetch = async (input) => {
  bootstrapRequests.push(String(input));
  return new Response(
    JSON.stringify({
      environment: {
        preset: "local-single",
        profile: "local",
        tenancy: "single-principal",
        execution: "local-process",
        workspace: "host-local",
        stateStore: "sqlite",
        blobStore: "filesystem",
        auth: "session",
      },
      auth: { mode: "session", tokenRequired: false },
      hostId: "0123456789abcdef",
      mcpApps: {},
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
};
try {
  const desktopApi = {
    apiBase: "opengrove-desktop://ui/api",
    bridgeStartupState: { stage: "starting", attempt: 1 },
    onBridgeStartupStateChange(callback) {
      bridgeStateListener = callback;
      callback(this.bridgeStartupState);
      return () => {
        bridgeStateListener = undefined;
      };
    },
  };
  const pendingBootstrap = bootstrapModule.loadClientBootstrapForRuntime(desktopApi);
  await Promise.resolve();
  assert.equal(
    bootstrapRequests.length,
    0,
    "desktop startup must not request /bootstrap before the Bridge publishes a ready API base",
  );
  bridgeStateListener({ stage: "migrating", attempt: 1 });
  await Promise.resolve();
  assert.equal(bootstrapRequests.length, 0, "desktop migration progress must remain a non-ready startup state");
  bridgeStateListener({ stage: "retrying", attempt: 2, retryInMs: 1_000, message: "retrying" });
  await Promise.resolve();
  assert.equal(bootstrapRequests.length, 0, "desktop Bridge retries must keep the client bootstrap request paused");
  bridgeStateListener({ stage: "ready", generation: 1 });
  await pendingBootstrap;
  assert.deepEqual(
    bootstrapRequests,
    ["opengrove-desktop://ui/api/bootstrap"],
    "desktop bootstrap must use one stable Host-owned URL instead of the dynamic Bridge origin",
  );
  globalThis.fetch = async () =>
    new Response("<!doctype html><title>OpenGrove</title>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  await assert.rejects(
    () => bootstrapModule.loadClientBootstrap(),
    (error) => error instanceof Error && /Bootstrap/u.test(error.message) && !/Unexpected token/u.test(error.message),
    "a non-JSON bootstrap response must become a stable compatibility error instead of leaking a JSON parser exception",
  );
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.__OPENGROVE_API_BASE__;
}

const appStoreCss = await readFile(resolve("web/src/components/network/app-store-view.css"), "utf8");
assert.match(
  appStoreCss,
  /\.app-store-view\[data-presentation="grove"\] \.app-store-app-card \{[\s\S]*?height: var\(--app-store-grove-card-height\);[\s\S]*?min-height: var\(--app-store-grove-card-height\);/,
  "loaded App Store cards and their loading placeholders must inherit one explicit compact height",
);
assert.match(
  appStoreCss,
  /--app-store-grove-card-height: 132px;/,
  "the Grove App Store card height must remain compact",
);
assert.doesNotMatch(
  appStoreCss,
  /\.app-store-catalog-loading \.app-store-app-card \{[^}]*(?:min-)?height:/,
  "the loading state must not override card height and introduce a layout shift",
);

console.log("web loading-state policy contract passed");
