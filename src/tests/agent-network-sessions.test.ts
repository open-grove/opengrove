import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTask, taskStatusText, taskText } from "@agent-router/sdk";
import { AgentNetworkSessions } from "../server/remote-agents/client.js";

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

test("SDK sessions bootstrap once, renew with the same account and reject a changed sender", async () => {
  let now = Date.now();
  const exchanges: unknown[] = [];
  let senderId = "sender-a";
  const network = new AgentNetworkSessions({
    baseUrl: "https://agents.example/_agent-router/v1",
    provider: "opengrove",
    now: () => now,
    fetch: async (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      exchanges.push(JSON.parse(String(init?.body)));
      return Response.json({
        serviceUrl: "https://agents.example/_agent-router/v1",
        accessToken: `ars_${exchanges.length}`,
        expiresAt: new Date(now + 600_000).toISOString(),
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
  network.observe({ accountIssuer: "https://account.example", accountUserId: "user-a", accessToken: "product-a" });
  const [first, concurrent] = await Promise.all([network.connect(), network.connect()]);
  assert.equal(first.sender.id, "sender-a");
  assert.deepEqual(first.sender, concurrent.sender);
  assert.deepEqual(exchanges, [{ provider: "opengrove", accessToken: "product-a" }]);
  network.observe({
    accountIssuer: "https://account.example",
    accountUserId: "user-a",
    accessToken: "product-a-renewed",
  });
  now += 580_000;
  await network.connect(first.binding);
  assert.deepEqual(exchanges[1], { provider: "opengrove", accessToken: "product-a-renewed" });
  senderId = "sender-changed";
  now += 580_000;
  await assert.rejects(network.connect(first.binding), /remote_sender_changed/);
});

test("logout aborts bound requests and a late exchange cannot install credentials into another account", async () => {
  let resolveFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  let requests = 0;
  let revocations = 0;
  const network = new AgentNetworkSessions({
    baseUrl: "https://agents.example/_agent-router/v1",
    provider: "opengrove",
    fetch: async (_url, init) => {
      if (init?.method === "DELETE") {
        revocations++;
        return new Response(null, { status: 204 });
      }
      requests++;
      return requests === 1 ? firstResponse : Response.json(sessionResponse("b"));
    },
  });
  network.observe({ accountIssuer: "https://account.example", accountUserId: "a", accessToken: "product-a" });
  const generation = network.generation;
  const old = network.connect();
  const rejected = assert.rejects(old, /remote_account_changed/);
  await network.clear("remote_account_changed");
  network.observe({ accountIssuer: "https://account.example", accountUserId: "b", accessToken: "product-b" });
  resolveFirst(Response.json(sessionResponse("a")));
  await rejected;
  assert.equal(revocations, 1);
  assert.throws(
    () =>
      network.observe(
        { accountIssuer: "https://account.example", accountUserId: "a", accessToken: "product-a" },
        generation,
      ),
    /remote_account_changed/,
  );
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

test("SDK credential rejection renews once; uncertain submissions remain the Room ledger's responsibility", async () => {
  let exchanges = 0;
  let sends = 0;
  let directoryReads = 0;
  const network = new AgentNetworkSessions({
    baseUrl: "https://agents.example/_agent-router/v1",
    provider: "opengrove",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url).endsWith("/auth/exchange")) {
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
      assert.equal(headers.get("Authorization"), "Bearer ars_a");
      assert.equal(init?.redirect, "error");
      sends++;
      if (sends === 1) return Response.json({ error: "account_session_invalid" }, { status: 401 });
      throw new Error("uncertain delivery");
    },
  });
  network.observe({ accountIssuer: "https://account.example", accountUserId: "a", accessToken: "product-a" });
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
    accessToken: `ars_${account}`,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
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
