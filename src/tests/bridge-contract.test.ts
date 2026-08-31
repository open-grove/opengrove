import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { askCancelContract, askCompactContract, askGuideContract, clientBootstrapContract } from "#agent-protocol";
import { BridgeContractViolation, dispatchBridgeRoutes, type BridgeRouteContext } from "../server/router.js";

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
