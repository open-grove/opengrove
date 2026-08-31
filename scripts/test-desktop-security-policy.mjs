import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-security-"));
const bundlePath = join(tempDir, "security-policy.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "security-policy.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
  });
  const {
    createDesktopContentSecurityPolicy,
    createTrustedDesktopIpcRegistrar,
    createTrustedDesktopSyncIpcRegistrar,
    installDesktopExternalNavigationPolicy,
    installDesktopPermissionPolicy,
    installDesktopProtocolRequestAuthentication,
    isTrustedDesktopDocumentUrl,
  } = await import(pathToFileURL(bundlePath).href);

  assert.equal(isTrustedDesktopDocumentUrl("opengrove-desktop://ui/ui/"), true);
  assert.equal(isTrustedDesktopDocumentUrl("opengrove-desktop://ui/ui/rooms?tab=all"), true);
  assert.equal(isTrustedDesktopDocumentUrl("opengrove-desktop://evil/ui/"), false);
  assert.equal(isTrustedDesktopDocumentUrl("https://ui/ui/"), false);
  assert.equal(isTrustedDesktopDocumentUrl("not a url"), false);

  let protocolRequestFilter;
  let protocolRequestListener;
  installDesktopProtocolRequestAuthentication(
    {
      webRequest: {
        onBeforeSendHeaders(filter, listener) {
          protocolRequestFilter = filter;
          protocolRequestListener = listener;
        },
      },
    },
    () => "desktop-proxy-capability",
  );
  assert.deepEqual(protocolRequestFilter, { urls: ["opengrove-desktop://ui/*"] });
  assert.ok(protocolRequestListener);
  assert.deepEqual(
    authenticateProtocolRequest(protocolRequestListener, {
      frame: { url: "opengrove-desktop://ui/ui/rooms" },
      requestHeaders: { Accept: "application/json" },
    }),
    {
      Accept: "application/json",
      "x-opengrove-desktop-proxy-token": "desktop-proxy-capability",
    },
  );
  assert.deepEqual(
    authenticateProtocolRequest(protocolRequestListener, {
      frame: { url: "opengrove-desktop://mcp-app/mcp-app-sandbox" },
      requestHeaders: { "X-OpenGrove-Desktop-Proxy-Token": "spoofed" },
    }),
    {},
    "untrusted frames must not keep or receive the Host-only proxy capability",
  );

  const desktopPolicy = createDesktopContentSecurityPolicy();
  assert.deepEqual(cspDirectiveSources(desktopPolicy, "connect-src"), ["'self'"]);
  assert.deepEqual(cspDirectiveSources(desktopPolicy, "img-src"), ["'self'", "data:", "blob:", "https:"]);
  assert.deepEqual(cspDirectiveSources(desktopPolicy, "media-src"), ["'self'", "blob:", "https:"]);
  assert.deepEqual(cspDirectiveSources(desktopPolicy, "frame-src"), [
    "'self'",
    "opengrove-desktop://mcp-app",
    "https:",
  ]);
  assert.deepEqual(cspDirectiveSources(desktopPolicy, "script-src"), ["'self'"]);
  assert.deepEqual(cspDirectiveSources(desktopPolicy, "worker-src"), ["'self'", "blob:"]);
  assert.deepEqual(cspDirectiveSources(desktopPolicy, "object-src"), ["'none'"]);
  assert.doesNotMatch(desktopPolicy, /unsafe-eval/);
  assert.doesNotMatch(desktopPolicy, /127\.0\.0\.1|localhost/u);

  const customSandboxPolicy = createDesktopContentSecurityPolicy("http://sandbox.example.test:9080/path");
  assert.deepEqual(cspDirectiveSources(customSandboxPolicy, "frame-src"), [
    "'self'",
    "opengrove-desktop://mcp-app",
    "http://sandbox.example.test:9080",
    "https:",
  ]);

  let registeredHandler;
  let listenerCalls = 0;
  const handle = createTrustedDesktopIpcRegistrar({
    handle(channel, listener) {
      assert.equal(channel, "opengrove:test");
      registeredHandler = listener;
    },
  });
  handle("opengrove:test", (_event, value) => {
    listenerCalls += 1;
    return value;
  });
  assert.ok(registeredHandler);
  assert.equal(await registeredHandler({ senderFrame: { url: "opengrove-desktop://ui/ui/" } }, "ok"), "ok");
  assert.throws(
    () => registeredHandler({ senderFrame: { url: "https://attacker.invalid/" } }, "no"),
    /desktop_ipc_sender_not_trusted/,
  );
  assert.equal(listenerCalls, 1, "untrusted IPC senders must be rejected before the handler runs");

  let registeredSyncHandler;
  const rejectedSyncSenders = [];
  const registerSync = createTrustedDesktopSyncIpcRegistrar(
    {
      on(channel, listener) {
        assert.equal(channel, "opengrove:test-sync");
        registeredSyncHandler = listener;
        return this;
      },
    },
    (error) => rejectedSyncSenders.push(error),
  );
  registerSync("opengrove:test-sync", () => ({ stage: "ready" }));
  assert.ok(registeredSyncHandler);
  const trustedSyncEvent = {
    senderFrame: { url: "opengrove-desktop://ui/ui/" },
    returnValue: undefined,
  };
  registeredSyncHandler(trustedSyncEvent);
  assert.deepEqual(trustedSyncEvent.returnValue, { stage: "ready" });
  const untrustedSyncEvent = {
    senderFrame: { url: "https://attacker.invalid/" },
    returnValue: "unanswered",
  };
  registeredSyncHandler(untrustedSyncEvent);
  assert.equal(untrustedSyncEvent.returnValue, null, "a rejected sendSync call must still receive an immediate reply");
  assert.equal(rejectedSyncSenders.length, 1);

  let windowOpenHandler;
  let willNavigateHandler;
  const openedExternalUrls = [];
  installDesktopExternalNavigationPolicy(
    {
      setWindowOpenHandler(handler) {
        windowOpenHandler = handler;
      },
      on(event, handler) {
        assert.equal(event, "will-navigate");
        willNavigateHandler = handler;
        return this;
      },
    },
    (url) => openedExternalUrls.push(url),
  );
  assert.ok(windowOpenHandler);
  assert.ok(willNavigateHandler);
  assert.deepEqual(windowOpenHandler({ url: "https://example.com/sign" }), { action: "deny" });
  assert.deepEqual(windowOpenHandler({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.deepEqual(
    openedExternalUrls,
    ["https://example.com/sign"],
    "new windows must be denied in Electron and only safe URLs may reach the system browser",
  );

  let preventedNavigation = false;
  willNavigateHandler(
    {
      preventDefault() {
        preventedNavigation = true;
      },
    },
    "opengrove-desktop://ui/ui/rooms",
  );
  assert.equal(preventedNavigation, false, "the trusted desktop UI must keep its in-window navigation");
  willNavigateHandler(
    {
      preventDefault() {
        preventedNavigation = true;
      },
    },
    "opengrove-desktop://ui.evil/ui/",
  );
  assert.equal(preventedNavigation, true, "lookalike desktop origins must not bypass navigation blocking");
  preventedNavigation = false;
  willNavigateHandler(
    {
      preventDefault() {
        preventedNavigation = true;
      },
    },
    "https://example.com/contract",
  );
  assert.equal(preventedNavigation, true, "external in-window navigation must be blocked");
  assert.deepEqual(
    openedExternalUrls,
    ["https://example.com/sign", "https://example.com/contract"],
    "safe blocked navigation must be handed to the system browser",
  );

  let checkPermission;
  let requestPermission;
  installDesktopPermissionPolicy({
    setPermissionCheckHandler(handler) {
      checkPermission = handler;
    },
    setPermissionRequestHandler(handler) {
      requestPermission = handler;
    },
  });
  assert.ok(checkPermission);
  assert.ok(requestPermission);
  assert.equal(
    checkPermission(null, "media", "", {
      isMainFrame: true,
      mediaType: "audio",
      requestingUrl: "opengrove-desktop://ui/ui/",
    }),
    true,
  );
  assert.equal(
    checkPermission(null, "media", "", {
      isMainFrame: true,
      mediaType: "video",
      requestingUrl: "opengrove-desktop://ui/ui/",
    }),
    false,
  );
  assert.equal(
    checkPermission(null, "notifications", "", {
      isMainFrame: true,
      requestingUrl: "opengrove-desktop://ui/ui/",
    }),
    false,
  );

  assert.equal(
    requestPermissionResult(requestPermission, "media", {
      isMainFrame: true,
      mediaTypes: ["audio"],
      requestingUrl: "opengrove-desktop://ui/ui/",
    }),
    true,
  );
  assert.equal(
    requestPermissionResult(requestPermission, "media", {
      isMainFrame: true,
      mediaTypes: ["audio", "video"],
      requestingUrl: "opengrove-desktop://ui/ui/",
    }),
    false,
  );
  assert.equal(
    requestPermissionResult(requestPermission, "media", {
      isMainFrame: false,
      mediaTypes: ["audio"],
      requestingUrl: "opengrove-desktop://ui/ui/",
    }),
    false,
  );
  assert.equal(
    requestPermissionResult(requestPermission, "media", {
      isMainFrame: true,
      mediaTypes: ["audio"],
      requestingUrl: "https://attacker.invalid/",
    }),
    false,
  );

  console.log("desktop-security-policy harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function requestPermissionResult(handler, permission, details) {
  let result;
  handler(
    {},
    permission,
    (allowed) => {
      result = allowed;
    },
    details,
  );
  return result;
}

function authenticateProtocolRequest(listener, details) {
  let requestHeaders;
  listener(details, (result) => {
    requestHeaders = result.requestHeaders;
  });
  return requestHeaders;
}

function cspDirectiveSources(policy, name) {
  const directive = policy
    .split(";")
    .map((value) => value.trim())
    .find((value) => value === name || value.startsWith(`${name} `));
  assert.ok(directive, `missing CSP directive: ${name}`);
  return directive.split(/\s+/).slice(1);
}
