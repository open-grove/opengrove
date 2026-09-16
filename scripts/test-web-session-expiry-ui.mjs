import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "opengrove-session-expiry-ui-"));
try {
  await verifyBrowserRecovery();
  console.log(
    "web-session-expiry browser ok: gateway sign-in, Bridge revalidation, resumed Rooms, and transient retry",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function verifyBrowserRecovery() {
  const entry = join(temporary, "browser.tsx");
  const output = join(temporary, "browser.js");
  await writeFile(
    entry,
    `
    import React, { useMemo, useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
    import { fetchJson } from ${JSON.stringify(join(root, "web/src/bridge-client.ts"))};
    import { useBridgeAuthGate } from ${JSON.stringify(join(root, "web/src/app-auth-gate.ts"))};
    import { useRoomsServerSync } from ${JSON.stringify(join(root, "web/src/components/rooms/rooms-server-sync.ts"))};
    import { markAuthSessionAuthenticated } from ${JSON.stringify(join(root, "web/src/app-auth-model.ts"))};
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = { userId: "test-user", email: "user@example.test" };
    function App() {
      const healthQuery = useQuery({ queryKey: ["health"], queryFn: async () => ({}),
        initialData: { auth: { mode: "session" } }, staleTime: Infinity });
      const sessionQuery = useQuery({ queryKey: ["auth-session"], queryFn: () => fetchJson("/auth/session"),
        initialData: { status: "authenticated", authenticated: true, user }, staleTime: Infinity });
      const gate = useBridgeAuthGate({ queryClient: client, healthQuery, sessionQuery,
        desktopSavedSession: false, desktopBridgeReady: false,
        desktopAccountOnboardingCompleted: false, languagePreference: "en" });
      const roomsRef = useRef([]), membersRef = useRef([]), deletedMemberIdsRef = useRef([]), serverRoomsEventSeqRef = useRef(0);
      const [, setRooms] = useState([]), [, setMembers] = useState([]), [, setDeletedMemberIds] = useState([]);
      const [, setActiveRoomId] = useState(""), [, setRoomsHydrated] = useState(false);
      const input = useMemo(() => ({ roomsRef, membersRef, deletedMemberIdsRef, serverRoomsEventSeqRef,
        setRooms, setMembers, setDeletedMemberIds, setActiveRoomId, setRoomsHydrated,
        enabled: gate.bridgeProtectedQueriesEnabled, onSessionRequired: gate.requestAuthSessionRevalidation }),
        [gate.bridgeProtectedQueriesEnabled, gate.requestAuthSessionRevalidation]);
      useRoomsServerSync(input, sessionQuery.data.user?.userId ?? "anonymous");
      return <main><p data-testid="session">{sessionQuery.data.status}</p>
        <button onClick={() => markAuthSessionAuthenticated(client, user)}>Restore Bridge login</button></main>;
    }
    createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  `,
  );
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: "browser",
    format: "esm",
    nodePaths: [join(root, "node_modules")],
    jsx: "automatic",
    define: { __OPENGROVE_DEV_FIXTURE_ACCOUNTS__: "false", "process.env.NODE_ENV": '"production"' },
  });
  const javascript = await readFile(output);
  let mode = "portal";
  let events = 0;
  let successfulEvents = 0;
  let sessionChecks = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<h1>Portal sign-in</h1><a href="/instances/test/ui/?signedIn=1">Sign in</a>');
    } else if (url.pathname === "/browser.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(javascript);
    } else if (url.pathname.endsWith("/ui/")) {
      if (url.searchParams.has("signedIn")) mode = "healthy";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<div id="root"></div><script>globalThis.__OPENGROVE_API_BASE__="/instances/test/api"</script><script type="module" src="/browser.js"></script>',
      );
    } else if (url.pathname.endsWith("/rooms")) {
      if (mode === "portal-init") json(401, { error: "authentication_required" });
      else json(200, { ok: true, rooms: [], members: [], messages: [], deletedMemberIds: [], currentEventSeq: 10 });
    } else if (url.pathname.endsWith("/rooms/events")) {
      events += 1;
      if (mode === "portal") json(401, { error: "authentication_required" });
      else if (mode === "bridge") json(401, { ok: false, error: "session_required" });
      else if (mode === "transient" && events === 1) json(503, { ok: false, error: "session_temporarily_unavailable" });
      else {
        successfulEvents += 1;
        json(200, {
          ok: true,
          events: [],
          currentEventSeq: 10,
          oldestAvailableEventSeq: 1,
          longPollSupported: true,
          hasMore: false,
          resetRequired: false,
        });
      }
    } else if (url.pathname.endsWith("/auth/session")) {
      sessionChecks += 1;
      if (mode === "portal") json(401, { error: "authentication_required" });
      else json(200, { status: "unauthenticated", authenticated: false });
    } else if (url.pathname.endsWith("/auth/team-gate")) {
      json(200, { required: false, satisfied: true });
    } else json(404, { error: "not_found" });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      if (!/Executable doesn't exist|Looks like Playwright/u.test(String(error))) throw error;
      browser = await chromium.launch({ channel: "chrome", headless: true });
    }
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/instances/test/ui/`);
    await page.waitForURL(`${origin}/`, { timeout: 5000 });
    assert.equal(events, 1, "gateway expiry must leave the unauthorized Rooms page");
    assert.equal(sessionChecks, 0, "do not attempt Bridge login behind an expired gateway session");
    await page.waitForTimeout(1200);
    assert.equal(events, 1, "the signed-out page must stop polling Rooms");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await waitUntil(() => successfulEvents > 0);
    assert.equal(await page.getByTestId("session").textContent(), "authenticated");

    mode = "bridge";
    events = 0;
    sessionChecks = 0;
    await page.goto(`${origin}/instances/test/ui/`);
    await page.getByTestId("session").filter({ hasText: "unauthenticated" }).waitFor();
    assert.equal(sessionChecks, 1, "ordinary Bridge expiry must revalidate its own session");
    await page.waitForTimeout(1200);
    assert.equal(events, 1, "Bridge logout must disable Rooms polling");
    mode = "healthy";
    successfulEvents = 0;
    await page.getByRole("button", { name: "Restore Bridge login" }).click();
    await waitUntil(() => successfulEvents > 0);

    mode = "transient";
    events = 0;
    successfulEvents = 0;
    sessionChecks = 0;
    await page.goto(`${origin}/instances/test/ui/`);
    await waitUntil(() => successfulEvents > 0);
    assert.equal(sessionChecks, 0, "temporary failures must retry without signing out");
    assert.equal(page.url(), `${origin}/instances/test/ui/`);

    mode = "portal-init";
    events = 0;
    await page.goto(`${origin}/instances/test/ui/`);
    await page.waitForURL(`${origin}/`, { timeout: 5000 });
    assert.equal(events, 0, "expiry while loading the Rooms snapshot must also return to sign-in");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, "Rooms synchronization did not recover");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}
