import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { askCancelContract, askCompactContract, askGuideContract, clientBootstrapContract } from "#agent-protocol";
import { createRoomMessageOperation, findHostOperation, hostOperations } from "#protocol";
import { BridgeContractViolation, dispatchBridgeRoutes, type BridgeRouteContext } from "../server/router.js";
import { operationRoute } from "../server/routes/registry-utils.js";

test("shared Bridge contracts accept their documented payloads", () => {
  assert.equal(askCancelContract.request.safeParse({ threadId: "thread-1" }).success, true);
  assert.equal(askCancelContract.response.safeParse({ ok: true, cancelled: false }).success, true);
  assert.equal(
    askGuideContract.request.safeParse({
      runId: "run-1",
      instruction: "Focus on the failing assertion.",
    }).success,
    true,
  );
  assert.equal(
    askCompactContract.response.safeParse({
      ok: false,
      compacted: false,
      error: "thread_id_required",
    }).success,
    true,
  );
  assert.equal(
    clientBootstrapContract.response.safeParse({
      environment: {
        preset: "local-single",
        profile: "local",
        tenancy: "single-principal",
        execution: "local-process",
        workspace: "host-local",
        stateStore: "sqlite",
        blobStore: "filesystem",
        auth: "bridge-token",
      },
      auth: { mode: "bridge-token", tokenRequired: true },
      hostId: "0123456789abcdef",
      mcpApps: {},
    }).success,
    true,
  );
});

test("shared Bridge contracts reject missing or mistyped fields", () => {
  assert.equal(askGuideContract.request.safeParse({ runId: "run-1" }).success, false);
  assert.equal(askCancelContract.response.safeParse({ ok: true, cancelled: "yes" }).success, false);
  assert.equal(
    clientBootstrapContract.response.safeParse({
      environment: { preset: "local-single" },
    }).success,
    false,
  );
});

test("room-message operation owns method, path, risk, and JSON contracts", () => {
  assert.equal(createRoomMessageOperation.id, "room.message.create");
  assert.equal(createRoomMessageOperation.method, "POST");
  assert.equal(createRoomMessageOperation.path, "/rooms/{roomId}/messages");
  assert.equal(createRoomMessageOperation.risk, "write");
  assert.equal(createRoomMessageOperation.params.safeParse({ roomId: "room-1" }).success, true);
  assert.equal(createRoomMessageOperation.body.safeParse({ text: "hello" }).success, true);
  assert.equal(createRoomMessageOperation.body.safeParse({ text: 42 }).success, false);
  assert.equal(createRoomMessageOperation.success.status, 200);

  const registered = operationRoute(createRoomMessageOperation, () => true);
  const matchingContext = contractTestContext({ body: {} });
  matchingContext.url = new URL("http://127.0.0.1/rooms/room-1/messages");
  assert.equal(registered.path instanceof RegExp && registered.path.test(matchingContext.url.pathname), true);
  assert.equal(registered.method, "POST");
  assert.equal(registered.contract, createRoomMessageOperation);
});

test("Host operation catalog has stable unique ids", () => {
  assert.equal(new Set(hostOperations.map((operation) => operation.id)).size, hostOperations.length);
  assert.equal(findHostOperation("room.message.create"), createRoomMessageOperation);
  assert.equal(findHostOperation("missing.operation"), undefined);
});

test("Host operation routes validate path parameters and declared error responses", async () => {
  const sent: Array<{ status: number; data: unknown }> = [];
  const context = contractTestContext({
    body: { text: "hello" },
    onSend: (status, data) => sent.push({ status, data }),
  });
  context.url = new URL("http://127.0.0.1/rooms/room-1/messages");

  assert.equal(
    await dispatchBridgeRoutes(
      [
        operationRoute(createRoomMessageOperation, (routeContext) => {
          routeContext.sendJson(routeContext.response, 404, { ok: false, error: "reply_message_not_found" });
          return true;
        }),
      ],
      context,
    ),
    true,
  );
  assert.deepEqual(sent, [{ status: 404, data: { ok: false, error: "reply_message_not_found" } }]);
});

test("route contracts reject invalid request bodies before handlers receive them", async () => {
  const context = contractTestContext({
    body: { threadId: 42 },
  });
  await assert.rejects(
    dispatchBridgeRoutes(
      [
        {
          id: "ask-cancel",
          method: "POST",
          path: "/ask/cancel",
          contract: askCancelContract,
          async handle(routeContext) {
            await routeContext.readJsonBody(routeContext.request);
            return true;
          },
        },
      ],
      context,
    ),
    (error) =>
      error instanceof BridgeContractViolation &&
      error.direction === "request" &&
      error.contractId === "ask.cancel" &&
      error.issues.some((issue) => issue.path === "threadId"),
  );
});

test("route contracts turn invalid successful responses into explicit failures", async () => {
  const sent: Array<{ status: number; data: unknown }> = [];
  const violations: BridgeContractViolation[] = [];
  const context = contractTestContext({
    body: {},
    onSend: (status, data) => sent.push({ status, data }),
    onViolation: (violation) => violations.push(violation),
  });
  const payload = { ok: true };
  assert.equal(
    await dispatchBridgeRoutes(
      [
        {
          id: "ask-cancel",
          method: "POST",
          path: "/ask/cancel",
          contract: askCancelContract,
          handle(routeContext) {
            routeContext.sendJson(routeContext.response, 200, payload);
            return true;
          },
        },
      ],
      context,
    ),
    true,
  );
  assert.deepEqual(sent, [
    {
      status: 500,
      data: { ok: false, error: "bridge_response_contract_violation", contractId: "ask.cancel" },
    },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.direction, "response");
  assert.equal(violations[0]?.contractId, "ask.cancel");
  assert.equal(
    violations[0]?.issues.some((issue) => issue.path === "cancelled"),
    true,
  );
});

test("route contracts serialize only documented response fields", async () => {
  const sent: unknown[] = [];
  const payload = { ok: true, cancelled: false, futureField: "not-in-contract" };
  const context = contractTestContext({
    body: {},
    onSend: (_status, data) => sent.push(data),
  });
  await dispatchBridgeRoutes(
    [
      {
        id: "ask-cancel",
        method: "POST",
        path: "/ask/cancel",
        contract: askCancelContract,
        handle(routeContext) {
          routeContext.sendJson(routeContext.response, 200, payload);
          return true;
        },
      },
    ],
    context,
  );
  assert.deepEqual(sent, [{ ok: true, cancelled: false }]);
});

function contractTestContext(input: {
  body: unknown;
  onSend?(status: number, data: unknown): void;
  onViolation?(violation: BridgeContractViolation): void;
}): BridgeRouteContext {
  return {
    request: { method: "POST" } as IncomingMessage,
    response: {} as ServerResponse,
    url: new URL("http://127.0.0.1/ask/cancel"),
    traceId: "trace-contract-test",
    state: {} as BridgeRouteContext["state"],
    security: {} as BridgeRouteContext["security"],
    sendJson(_response, status, data) {
      if (!input.onSend) throw new Error("unexpected_send");
      input.onSend(status, data);
    },
    async readJsonBody() {
      return input.body;
    },
    reportContractViolation: input.onViolation,
  };
}
