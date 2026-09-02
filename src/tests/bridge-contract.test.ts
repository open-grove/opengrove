import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import { askCancelContract, askCompactContract, askGuideContract, clientBootstrapContract } from "#agent-protocol";
import {
  createRoomMessageOperation,
  defineHostOperation,
  defineHostOperationGroup,
  defineHostOperationResource,
  findHostOperation,
  type HostOperation,
  hostOperations,
} from "#protocol";
import { hostContractById } from "#protocol/compiled";
import { compileHostProtocol, type CompiledHostOperation } from "#protocol/compiler";
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

  const registered = operationRoute(hostContractById["room.message.create"], () => true);
  const matchingContext = contractTestContext({ body: {} });
  matchingContext.url = new URL("http://127.0.0.1/rooms/room-1/messages");
  assert.equal(registered.path instanceof RegExp && registered.path.test(matchingContext.url.pathname), true);
  assert.equal(registered.method, "POST");
  assert.equal(registered.contract, createRoomMessageOperation);
});

test("room-message operation normalizes legacy nullable values and identifiers", () => {
  assert.deepEqual(createRoomMessageOperation.params.parse({ roomId: "  room-1  " }), { roomId: "room-1" });
  assert.deepEqual(
    createRoomMessageOperation.body.parse({
      text: "  hello  ",
      targetIds: [" employee-1 ", "", "employee-1", "  employee-2"],
      attachments: null,
      selectedFile: null,
      userMessageId: " user-message-1 ",
      assistantMessageIds: [" assistant-1 ", "", "assistant-1"],
      inReplyToMessageId: " parent-message-1 ",
    }),
    {
      text: "  hello  ",
      targetIds: ["employee-1", "employee-2"],
      attachments: [],
      selectedFile: undefined,
      userMessageId: "user-message-1",
      assistantMessageIds: ["assistant-1"],
      inReplyToMessageId: "parent-message-1",
    },
  );
  assert.equal(createRoomMessageOperation.body.safeParse({ userMessageId: " " }).success, false);
});

test("Host operation catalog has stable unique ids", () => {
  assert.equal(new Set(hostOperations.map((operation) => operation.id)).size, hostOperations.length);
  assert.equal(findHostOperation("room.message.create"), createRoomMessageOperation);
  assert.equal(findHostOperation("missing.operation"), undefined);
});

test("Host operation routes validate path parameters and declared error responses", async () => {
  const sent: Array<{ status: number; data: unknown }> = [];
  const context = contractTestContext({
    body: {
      text: "hello",
      targetIds: [" agent-1 ", "", "agent-1"],
      attachments: null,
      selectedFile: null,
    },
    onSend: (status, data) => sent.push({ status, data }),
  });
  context.url = new URL("http://127.0.0.1/rooms/%20room-1%20/messages");

  assert.equal(
    await dispatchBridgeRoutes(
      [
        operationRoute(hostContractById["room.message.create"], (routeContext) => {
          assert.deepEqual(routeContext.input.params, { roomId: "room-1" });
          assert.deepEqual(routeContext.input.body, {
            text: "hello",
            targetIds: ["agent-1"],
            attachments: [],
            selectedFile: undefined,
            assistantMessageIds: [],
          });
          routeContext.sendJson(routeContext.response, 404, { ok: false, error: "reply_message_not_found" });
        }),
      ],
      context,
    ),
    true,
  );
  assert.deepEqual(sent, [{ status: 404, data: { ok: false, error: "reply_message_not_found" } }]);
});

test("Host protocol compiler creates stable input IR without executing transforms", () => {
  let transformCalls = 0;
  const operation = defineHostOperation({
    id: "test.item.create",
    summary: "Create test item",
    description: "Exercise compilation without running request-time behavior.",
    method: "POST",
    path: "/test/{itemId}",
    risk: "write",
    params: z.object({
      itemId: z.string().transform((value) => {
        transformCalls += 1;
        return value.toUpperCase();
      }),
    }),
    query: z.object({ page: z.coerce.number().int().positive().default(1) }),
    body: z.object({
      label: z.string().transform((value) => {
        transformCalls += 1;
        return value.trim();
      }),
      count: z.coerce.number().int().default(2),
    }),
    success: { status: 201, body: z.object({ ok: z.literal(true) }) },
  });
  const protocol = compileHostProtocol([
    defineHostOperationGroup({
      id: "test",
      title: "Test",
      description: "Test operations.",
      resources: [
        defineHostOperationResource({
          id: "item",
          title: "Items",
          description: "Test items.",
          operations: [operation],
        }),
      ],
    }),
  ] as const);
  const compiled = protocol.operationById["test.item.create"];

  assert.equal(transformCalls, 0);
  assert.deepEqual(compiled.path.parameterNames, ["itemId"]);
  assert.equal(compiled.input.mode, "flat");
  assert.equal(compiled.input.optional, false);
  assert.deepEqual(compiled.input.params?.fields, [{ name: "itemId", required: true }]);
  assert.deepEqual(compiled.input.query?.fields, [{ name: "page", required: false }]);
  assert.deepEqual(compiled.input.body?.fields, [
    { name: "count", required: false },
    { name: "label", required: true },
  ]);
});

test("Host operation handlers receive decoded params, query, and body exactly once", async () => {
  const operation = defineHostOperation({
    id: "test.item.update",
    summary: "Update test item",
    description: "Exercise typed route input decoding.",
    method: "POST",
    path: "/test/{itemId}",
    risk: "write",
    params: z.object({ itemId: z.string().transform((value) => value.toUpperCase()) }),
    query: z.object({ page: z.coerce.number().int().default(1) }),
    body: z.object({ label: z.string().transform((value) => value.trim()), count: z.coerce.number().default(2) }),
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  });
  const compiled = compileTestOperation(operation);
  let reads = 0;
  const sent: unknown[] = [];
  const context = contractTestContext({
    body: { label: "  Grove  ", count: "3" },
    onSend: (_status, data) => sent.push(data),
  });
  context.url = new URL("http://127.0.0.1/test/room%201?page=4");
  const originalReadJsonBody = context.readJsonBody;
  context.readJsonBody = async (request, maxBytes) => {
    reads += 1;
    return originalReadJsonBody(request, maxBytes);
  };

  await dispatchBridgeRoutes(
    [
      operationRoute(compiled, (routeContext) => {
        assert.deepEqual(routeContext.input, {
          params: { itemId: "ROOM 1" },
          query: { page: 4 },
          body: { label: "Grove", count: 3 },
        });
        routeContext.sendJson(routeContext.response, 200, { ok: true });
      }),
    ],
    context,
  );

  assert.equal(reads, 1);
  assert.deepEqual(sent, [{ ok: true }]);
});

test("Host operation query arrays keep their declared shape", async () => {
  const operation = defineHostOperation({
    id: "test.item.list",
    summary: "List test items",
    description: "Exercise query array decoding with one value.",
    method: "POST",
    path: "/test",
    risk: "read",
    query: z.object({ tags: z.array(z.string()) }),
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  });
  const compiled = compileTestOperation(operation);
  const receivedQueries: unknown[] = [];
  const route = operationRoute(compiled, (routeContext) => {
    receivedQueries.push(routeContext.input.query);
  });
  for (const query of ["tags=one", "tags=one&tags=two"]) {
    const context = contractTestContext({ body: {} });
    context.url = new URL(`http://127.0.0.1/test?${query}`);
    await dispatchBridgeRoutes([route], context);
  }

  assert.deepEqual(receivedQueries, [{ tags: ["one"] }, { tags: ["one", "two"] }]);
});

test("Host operation query scalars reject repeated values", async () => {
  const operation = defineHostOperation({
    id: "test.item.list",
    summary: "List test items",
    description: "Reject repeated values for a scalar query field.",
    method: "POST",
    path: "/test",
    risk: "read",
    query: z.object({ page: z.coerce.number().int() }),
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  });
  const compiled = compileTestOperation(operation);
  const context = contractTestContext({ body: {} });
  context.url = new URL("http://127.0.0.1/test?page=1&page=2");

  await assert.rejects(
    dispatchBridgeRoutes(
      [
        operationRoute(compiled, () => {
          throw new Error("handler_must_not_run");
        }),
      ],
      context,
    ),
    (error) =>
      error instanceof BridgeContractViolation &&
      error.contractId === operation.id &&
      error.issues.some((issue) => issue.path === "query.page" && issue.code === "query_parameter_repeated"),
  );
});

test("Host protocol compiler rejects ambiguous or incomplete operations", () => {
  const base = {
    summary: "Invalid test",
    description: "Invalid operation used to exercise compiler checks.",
    method: "POST" as const,
    risk: "write" as const,
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  };
  assert.throws(
    () =>
      compileTestOperation(
        defineHostOperation({
          ...base,
          id: "test.item.missing-param",
          path: "/test/{itemId}",
          body: z.object({ label: z.string() }),
        }),
      ),
    /path parameters do not match params schema/u,
  );
  assert.throws(
    () =>
      compileTestOperation(
        defineHostOperation({
          ...base,
          id: "test.item.collision",
          path: "/test/{itemId}",
          params: z.object({ itemId: z.string() }),
          body: z.object({ itemId: z.string() }),
        }),
      ),
    /appears in both params and body/u,
  );
  assert.throws(
    () =>
      compileTestOperation(
        defineHostOperation({
          ...base,
          id: "test.item.duplicate-status",
          path: "/test",
          errors: [
            { status: 400, body: z.object({ error: z.string() }) },
            { status: 400, body: z.object({ error: z.string() }) },
          ],
        }),
      ),
    /declares response status 400 more than once/u,
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

function compileTestOperation<const TOperation extends HostOperation>(
  operation: TOperation,
): CompiledHostOperation<TOperation> {
  const protocol = compileHostProtocol([
    defineHostOperationGroup({
      id: "test",
      title: "Test",
      description: "Test operations.",
      resources: [
        defineHostOperationResource({
          id: "item",
          title: "Items",
          description: "Test items.",
          operations: [operation],
        }),
      ],
    }),
  ] as const);
  return protocol.operations[0] as CompiledHostOperation<TOperation>;
}

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
