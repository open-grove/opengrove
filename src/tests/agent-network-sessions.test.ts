import { startRemoteAgentService } from "./fixtures/remote-agent-service.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTask, taskStatusText, taskText } from "@agent-router/sdk";
import { AgentNetworkSessions } from "../server/remote-agents/client.js";
import {
  credentialServiceUrl,
  issueNetworkSession,
  revokeNetworkSession,
} from "../server/remote-agents/credentials.js";

test("development credential endpoints accept the same loopback hosts as Router settings", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const url = `http://${host}:8080`;
    assert.equal(credentialServiceUrl(url, true).origin, url);
    assert.throws(() => credentialServiceUrl(url), /remote_authorization_unavailable/);
  }
  for (const url of ["http://example.com", "http://localhost.example", "http://192.168.1.1"]) {
    assert.throws(() => credentialServiceUrl(url, true), /remote_authorization_unavailable/);
  }
});

test("native logout uses the validated, normalized homeserver base URL", async () => {
  const session = await issueNetworkSession({
    accountIssuer: "https://accounts.example",
    serviceUrl: "https://agents.example/_agent-router/v1",
    accessToken: "oauth-credential",
    signal: new AbortController().signal,
    fetch: async () => Response.json({ ...sessionResponse("a"), homeserverUrl: "https://MATRIX.example:443/proxy/" }),
  });
  let logoutUrl: string | undefined;
  await revokeNetworkSession(session, async (url) => {
    logoutUrl = String(url);
    return new Response(null, { status: 204 });
  });
  assert.equal(logoutUrl, "https://matrix.example/proxy/_matrix/client/v3/logout");
});

test("native credential renewal tolerates host clock skew without extending the two-minute lifetime", async (t) => {
  const fixture = await startRemoteAgentService();
  t.after(() => fixture.close());
  for (const offset of [-300_000, -6000, 6000, 300_000]) {
    await t.test(`host clock offset ${offset}ms`, async () => {
      let now = Date.now() + offset;
      let exchanges = 0;
      const network = new AgentNetworkSessions({
        baseUrl: "https://agents.example/_agent-router/v1",
        provider: "opengrove",
        allowLocalHTTP: true,
        now: () => now,
        fetch: async (url) => {
          if (String(url).endsWith("/_matrix/client/v3/logout")) return new Response(null, { status: 204 });
          exchanges++;
          return Response.json({ ...sessionResponse("a"), expiresIn: 120 });
        },
      });
      network.observe({ accountIssuer: fixture.baseUrl, accountUserId: "a" });
      await fixture.oauth.authorize(await network.beginAuthorization(), "a");
      await network.connect();
      now += 89_000;
      await network.connect();
      assert.equal(exchanges, 1, "clock skew must not force early renewal");
      now += 2000;
      await network.connect();
      assert.equal(exchanges, 2, "renew before the original credential expires");
      await network.clear();
    });
  }
});

test("credential responses cannot extend their lifetime through network delay or invalid TTLs", async (t) => {
  for (const expiresIn of [0, 121, "120", null]) {
    await assert.rejects(
      issueNetworkSession({
        accountIssuer: "https://accounts.example",
        serviceUrl: "https://agents.example/_agent-router/v1",
        accessToken: "oauth-credential",
        signal: new AbortController().signal,
        fetch: async () => Response.json({ ...sessionResponse("a"), expiresIn }),
      }),
      /invalid_response/,
    );
  }
  const fixture = await startRemoteAgentService();
  t.after(() => fixture.close());
  let now = 0;
  let revocations = 0;
  const network = new AgentNetworkSessions({
    baseUrl: "https://agents.example/_agent-router/v1",
    provider: "opengrove",
    allowLocalHTTP: true,
    now: () => now,
    fetch: async (url) => {
      if (String(url).endsWith("/_matrix/client/v3/logout")) {
        revocations++;
        return new Response(null, { status: 204 });
      }
      now += 35_000;
      return Response.json({ ...sessionResponse("a"), expiresIn: 60 });
    },
  });
  network.observe({ accountIssuer: fixture.baseUrl, accountUserId: "a" });
  await fixture.oauth.authorize(await network.beginAuthorization(), "a");
  await assert.rejects(network.connect(), /remote_session_unavailable/);
  assert.equal(revocations, 1, "a delayed credential is revoked rather than installed");
  await network.clear();
});

test("SDK progress and completion labels never become an Agent reply", () => {
  for (const state of ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]) {
    const task = parseTask({
      id: "task-progress",
      contextId: "context-progress",
      status: { state, message: { role: "ROLE_AGENT", parts: [{ text: "Connecting to the remote worker…" }] } },
      history: [{ role: "ROLE_USER", parts: [{ text: "My actual question" }] }],
    });
    assert.equal(taskText(task), "", `${state} is execution status, not a reply`);
    assert.equal(taskStatusText(task), "Connecting to the remote worker…");
    task.artifacts = [{ parts: [{ text: "The actual reply" }] }];
    assert.equal(taskText(task), "The actual reply");
  }
  for (const state of ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]) {
    const question = parseTask({
      id: "question",
      contextId: "context",
      status: { state, message: { parts: [{ text: "Please confirm the target." }] } },
      artifacts: [{ parts: [{ text: "Prior work" }] }],
    });
    assert.equal(taskText(question), "Please confirm the target.");
  }
});

test("SDK input and auth questions fall back to artifact or Agent history content", () => {
  for (const state of ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]) {
    const task = parseTask({
      id: "question",
      contextId: "context",
      status: { state },
      artifacts: [{ parts: [{ text: "Confirm the deployment target." }] }],
    });
    assert.equal(taskText(task), "Confirm the deployment target.");
    task.artifacts = [];
    task.history = [{ role: "ROLE_AGENT", parts: [{ text: "Sign in to continue." }] }];
    assert.equal(taskText(task), "Sign in to continue.");
    assert.equal(taskStatusText(task), "");
  }
});

test("SDK sessions bootstrap once, renew with the same account and reject a changed sender", async (t) => {
  const fixture = await startRemoteAgentService();
  t.after(() => fixture.close());
  let now = Date.now();
  const exchanges: unknown[] = [];
  let senderId = "sender-a";
  const network = new AgentNetworkSessions({
    baseUrl: "https://agents.example/_agent-router/v1",
    provider: "opengrove",
    allowLocalHTTP: true,
    now: () => now,
    fetch: async (_url, init) => {
      if (String(_url).endsWith("/_matrix/client/v3/logout")) return new Response(null, { status: 204 });
      assert.equal(String(_url), `${fixture.baseUrl}/v1/network/sessions`);
      assert.match(new Headers(init?.headers).get("Authorization")!, /^Bearer oauth-/);
      exchanges.push(JSON.parse(String(init?.body)));
      return Response.json({
        serviceUrl: "https://agents.example/_agent-router/v1",
        homeserverUrl: "https://matrix.example",
        accessToken: `matrix_${exchanges.length}`,
        expiresAt: new Date(now + 120_000).toISOString(),
        expiresIn: 120,
        owner: "@owner-a:agents.example",
        agent: {
          id: senderId,
          owner: "@owner-a:agents.example",
          name: "client",
          address: "owner-a/client@agents.example",
          matrixId: "@sender-a:agents.example",
        },
      });
    },
  });
  network.observe({ accountIssuer: fixture.baseUrl, accountUserId: "user-a" });
  await fixture.oauth.authorize(await network.beginAuthorization(), "user-a");
  const [first, concurrent] = await Promise.all([network.connect(), network.connect()]);
  assert.equal(first.sender.id, "sender-a");
  assert.deepEqual(first.sender, concurrent.sender);
  assert.deepEqual(exchanges, [{ serviceUrl: "https://agents.example/_agent-router/v1" }]);
  network.observe({
    accountIssuer: fixture.baseUrl,
    accountUserId: "user-a",
  });
  now += 100_000;
  await network.connect(first.binding);
  assert.deepEqual(exchanges[1], { serviceUrl: "https://agents.example/_agent-router/v1" });
  senderId = "sender-changed";
  now += 100_000;
  await assert.rejects(network.connect(first.binding), /remote_sender_changed/);
});

test("logout aborts bound requests and a late exchange cannot install credentials into another account", async (t) => {
  const fixture = await startRemoteAgentService();
  t.after(() => fixture.close());
  let resolveFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  let requests = 0;
  let revocations = 0;
  const network = new AgentNetworkSessions({
    baseUrl: "https://agents.example/_agent-router/v1",
    provider: "opengrove",
    allowLocalHTTP: true,
    fetch: async (_url) => {
      if (String(_url).endsWith("/_matrix/client/v3/logout")) {
        revocations++;
        return new Response(null, { status: 204 });
      }
      requests++;
      return requests === 1 ? firstResponse : Response.json(sessionResponse("b"));
    },
  });
  network.observe({ accountIssuer: fixture.baseUrl, accountUserId: "a" });
  await fixture.oauth.authorize(await network.beginAuthorization(), "a");
  const generation = network.generation;
  const old = network.connect();
  const rejected = assert.rejects(old, /remote_account_changed/);
  await new Promise((resolve) => setImmediate(resolve));
  await network.clear("remote_account_changed");
  network.observe({ accountIssuer: fixture.baseUrl, accountUserId: "b" });
  resolveFirst(Response.json(sessionResponse("a")));
  await rejected;
  assert.equal(revocations, 1);
  assert.throws(
    () => network.observe({ accountIssuer: fixture.baseUrl, accountUserId: "a" }, generation),
    /remote_account_changed/,
  );
  await fixture.oauth.authorize(await network.beginAuthorization(), "b");
  const current = await network.connect();
  assert.equal(current.sender.id, "sender-b");
  await assert.rejects(network.connect({ ...current.binding, accountUserId: "a" }), /remote_account_changed/);
  await network.clear();
  assert.equal(current.signal.aborted, true);
  await assert.rejects(
    current.request(async () => {
      throw new Error("must not execute");
    }),
    /not_authenticated/,
  );
  assert.equal(requests, 2);
});

test("SDK credential rejection renews once; uncertain submissions remain the Room ledger's responsibility", async (t) => {
  const fixture = await startRemoteAgentService();
  t.after(() => fixture.close());
  let exchanges = 0;
  let sends = 0;
  let directoryReads = 0;
  const network = new AgentNetworkSessions({
    baseUrl: "https://agents.example/_agent-router/v1",
    provider: "opengrove",
    allowLocalHTTP: true,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url).endsWith("/_matrix/client/v3/logout")) return new Response(null, { status: 204 });
      if (String(url).endsWith("/v1/network/sessions")) {
        exchanges++;
        return Response.json(sessionResponse("a"));
      }
      if (String(url).includes("/directory?")) {
        directoryReads++;
        assert.equal(headers.has("Authorization"), false);
        assert.equal(new URL(String(url)).hostname, "recipient.example");
        return Response.json({
          id: "remote",
          name: "agent",
          owner: "@owner:recipient.example",
          address: "owner/agent@recipient.example",
          matrixId: "@remote:recipient.example",
        });
      }
      assert.equal(new URL(String(url)).hostname, "agents.example");
      assert.equal(headers.get("Authorization"), "Bearer matrix_a");
      assert.equal(init?.redirect, "error");
      sends++;
      if (sends === 1) return Response.json({ error: "account_session_invalid" }, { status: 401 });
      throw new Error("uncertain delivery");
    },
  });
  network.observe({ accountIssuer: fixture.baseUrl, accountUserId: "a" });
  await fixture.oauth.authorize(await network.beginAuthorization(), "a");
  const connection = await network.connect();
  await assert.rejects(
    connection.request(({ client, sender, signal }) =>
      client.send({
        agentId: sender.id,
        address: "owner/agent@recipient.example",
        text: "hello",
        messageId: "stable-id",
        signal,
      }),
    ),
    /connection_unavailable/,
  );
  assert.equal(exchanges, 2);
  assert.equal(sends, 2, "only the rejected credential is retried, never the uncertain send");
  assert.equal(directoryReads, 2);
});

function sessionResponse(account: string) {
  return {
    serviceUrl: "https://agents.example/_agent-router/v1",
    homeserverUrl: "https://matrix.example",
    accessToken: `matrix_${account}`,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    expiresIn: 120,
    owner: `@${account}:agents.example`,
    agent: {
      id: `sender-${account}`,
      owner: `@${account}:agents.example`,
      name: "client",
      address: `${account}/client@agents.example`,
      matrixId: `@sender-${account}:agents.example`,
    },
  };
}
