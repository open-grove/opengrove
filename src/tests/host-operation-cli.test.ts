import assert from "node:assert/strict";
import { test } from "node:test";
import { compileHostProtocol } from "#protocol/compiler";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "#protocol";
import { z } from "zod";
import {
  assertHostOperationCliCatalog,
  HOST_OPERATION_CLI_EXIT,
  isHostOperationCommand,
  runHostOperationCommand,
  type HostOperationCliResult,
} from "../cli/host-operation-command.js";

const messageResponse = {
  ok: true as const,
  room: {
    id: "room / one",
    kind: "group" as const,
    title: "Architecture",
    badge: "AR",
    memberIds: [],
    adminMemberIds: [],
    updatedAt: "2026-09-01T00:00:00.000Z",
    unread: 0,
  },
  userMessage: {
    id: "message-1",
    roomId: "room / one",
    channelSeq: 1,
    senderId: "user",
    senderName: "You",
    senderType: "user" as const,
    text: "hello",
    targetIds: ["employee-1", "employee-2"],
    status: "done" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  assistantMessages: [],
  currentEventSeq: 1,
};

test("Host CLI help is projected from the compiled Protocol catalog", async () => {
  const result = await runHostOperationCommand(["room", "message", "create", "--help"]);

  assert.equal(result.exitCode, HOST_OPERATION_CLI_EXIT.success);
  assert.match(result.stdout ?? "", /Send a Room message/u);
  assert.match(result.stdout ?? "", /--room-id <string>.*Room identifier.*Required/u);
  assert.match(result.stdout ?? "", /--target-ids <string\.\.\.>/u);
  assert.match(result.stdout ?? "", /OPENGROVE_BRIDGE_URL/u);
  assert.match(result.stdout ?? "", /Risk: write/u);
});

test("Host CLI leaves unrelated handwritten commands available when a Protocol group shares their root", () => {
  const appReleaseOperation = defineHostOperation({
    id: "app.release.list",
    summary: "List App releases",
    description: "List test App releases.",
    method: "GET",
    path: "/apps/{appId}/releases",
    risk: "read",
    params: z.object({ appId: z.string() }),
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  });
  const catalog = compileHostProtocol([
    defineHostOperationGroup({
      id: "app",
      title: "Apps",
      description: "Apps test catalog.",
      resources: [
        defineHostOperationResource({
          id: "release",
          title: "Releases",
          description: "App releases.",
          operations: [appReleaseOperation] as const,
        }),
      ] as const,
    }),
  ] as const);

  assert.equal(isHostOperationCommand(["app", "release", "list"], catalog), true);
  assert.equal(isHostOperationCommand(["app", "inspect", "."], catalog), false);
});

test("Host CLI catalog rejects Protocol fields that collide with common options", () => {
  const collisionOperation = defineHostOperation({
    id: "room.message.collision-test",
    summary: "Test a CLI option collision",
    description: "Compiler fixture for a CLI option collision.",
    method: "POST",
    path: "/rooms/collision-test",
    risk: "write",
    body: z.object({ dryRun: z.boolean() }),
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  });
  const catalog = compileHostProtocol([
    defineHostOperationGroup({
      id: "room",
      title: "Rooms",
      description: "Rooms test catalog.",
      resources: [
        defineHostOperationResource({
          id: "message",
          title: "Messages",
          description: "Room messages.",
          operations: [collisionOperation] as const,
        }),
      ] as const,
    }),
  ] as const);

  assert.throws(() => assertHostOperationCliCatalog(catalog), /field dryRun conflicts with common option --dry-run/u);
});

test("Host CLI dry-run validates input, applies defaults, and never sends a request", async () => {
  let requestCount = 0;
  const result = await runHostOperationCommand(
    [
      "room",
      "message",
      "create",
      "--room-id",
      "room / one",
      "--target-ids",
      "employee-1",
      "--target-ids=employee-2",
      "--selected-file",
      '{"path":"notes/plan.md"}',
      "--dry-run",
    ],
    {
      fetch: (async () => {
        requestCount += 1;
        return new Response();
      }) as typeof fetch,
    },
  );

  assert.equal(result.exitCode, HOST_OPERATION_CLI_EXIT.success);
  assert.equal(requestCount, 0);
  const payload = readOutput(result);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.operation, "room.message.create");
  assert.deepEqual(payload.request, {
    method: "POST",
    path: "/rooms/{roomId}/messages",
    params: { roomId: "room / one" },
    body: {
      text: "",
      targetIds: ["employee-1", "employee-2"],
      attachments: [],
      selectedFile: { path: "notes/plan.md" },
      assistantMessageIds: [],
    },
  });
});

test("Host CLI dry-run shows the Protocol-normalized room message request", async () => {
  const result = await runHostOperationCommand([
    "room",
    "message",
    "create",
    "--input",
    '{"roomId":"  room-1  ","text":"hello","targetIds":[" employee-1 ","","employee-1"],"attachments":null,"selectedFile":null}',
    "--dry-run",
  ]);

  assert.equal(result.exitCode, HOST_OPERATION_CLI_EXIT.success, result.stderr);
  assert.deepEqual(readOutput(result).request, {
    method: "POST",
    path: "/rooms/{roomId}/messages",
    params: { roomId: "room-1" },
    body: {
      text: "hello",
      targetIds: ["employee-1"],
      attachments: [],
      assistantMessageIds: [],
    },
  });
});

test("Host CLI sends validated commands through OpenGrove Client", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const result = await runHostOperationCommand(
    [
      "room",
      "message",
      "create",
      "--input",
      '{"roomId":"room / one","text":"from input","targetIds":["ignored"]}',
      "--text",
      "hello",
      "--target-ids",
      '["employee-1","employee-2"]',
      "--base-url",
      "https://host.example.test/api/",
      "--token",
      "bridge-token",
    ],
    {
      fetch: (async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify(messageResponse), { status: 200 });
      }) as typeof fetch,
    },
  );

  assert.equal(result.exitCode, HOST_OPERATION_CLI_EXIT.success, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://host.example.test/api/rooms/room%20%2F%20one/messages");
  assert.equal(new Headers(requests[0]?.init?.headers).get("x-opengrove-token"), "bridge-token");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    text: "hello",
    targetIds: ["employee-1", "employee-2"],
    attachments: [],
    assistantMessageIds: [],
  });
  assert.equal(readOutput(result).operation, "room.message.create");
});

test("Host CLI rejects invalid input before calling OpenGrove Client", async () => {
  let requestCount = 0;
  const result = await runHostOperationCommand(["room", "message", "create", "--room-id", ""], {
    fetch: (async () => {
      requestCount += 1;
      return new Response();
    }) as typeof fetch,
  });

  assert.equal(result.exitCode, HOST_OPERATION_CLI_EXIT.validation);
  assert.equal(requestCount, 0);
  const payload = readError(result);
  assert.deepEqual(readRecord(payload.error), {
    type: "validation",
    subtype: "input_invalid",
    message: "Input does not satisfy room.message.create.",
  });
  assert.deepEqual(payload.issues, [{ path: "params.roomId", code: "too_small" }]);
});

test("Host CLI reports unknown operation input fields as usage errors", async () => {
  const result = await runHostOperationCommand([
    "room",
    "message",
    "create",
    "--input",
    '{"roomId":"room-1","unexpectedField":"value"}',
    "--dry-run",
  ]);

  assert.equal(result.exitCode, HOST_OPERATION_CLI_EXIT.validation);
  assert.equal(readRecord(readError(result).error).subtype, "unknown_input_field");
});

test("Host CLI requires --yes for high-risk writes after allowing dry-run", async () => {
  const removeOperation = defineHostOperation({
    id: "app.release.remove",
    summary: "Remove an App release",
    description: "Remove one test App release.",
    method: "DELETE",
    path: "/apps/{appId}/releases/{releaseId}",
    risk: "high-risk-write",
    params: z.object({ appId: z.string().min(1), releaseId: z.string().min(1) }),
    success: { status: 200, body: z.object({ ok: z.literal(true) }) },
  });
  const catalog = compileHostProtocol([
    defineHostOperationGroup({
      id: "app",
      title: "Apps",
      description: "Apps test catalog.",
      resources: [
        defineHostOperationResource({
          id: "release",
          title: "Releases",
          description: "App releases.",
          operations: [removeOperation] as const,
        }),
      ] as const,
    }),
  ] as const);
  let requestCount = 0;
  const fetchImplementation = (async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const command = ["app", "release", "remove", "--app-id", "app-1", "--release-id", "release-1"];

  const blocked = await runHostOperationCommand(command, { catalog, fetch: fetchImplementation });
  assert.equal(blocked.exitCode, HOST_OPERATION_CLI_EXIT.confirmationRequired);
  assert.equal(blocked.exitCode, 10);
  assert.deepEqual(readRecord(readError(blocked).error), {
    type: "confirmation",
    subtype: "confirmation_required",
    message: "Operation app.release.remove is high-risk. Re-run with --yes after reviewing --dry-run.",
  });
  assert.equal(requestCount, 0);

  const dryRun = await runHostOperationCommand([...command, "--dry-run"], { catalog, fetch: fetchImplementation });
  assert.equal(dryRun.exitCode, HOST_OPERATION_CLI_EXIT.success);
  assert.equal(readOutput(dryRun).dryRun, true);
  assert.equal(requestCount, 0);

  const confirmed = await runHostOperationCommand([...command, "--yes"], { catalog, fetch: fetchImplementation });
  assert.equal(confirmed.exitCode, HOST_OPERATION_CLI_EXIT.success, confirmed.stderr);
  assert.equal(requestCount, 1);
});

test("App release publish CLI is generated from Protocol and activates the published artifact by default", async () => {
  const result = await runHostOperationCommand([
    "app",
    "release",
    "publish",
    "--app-id",
    "sample-app",
    "--version",
    "1.2.3",
    "--release-notes",
    "First release",
    "--visibility",
    "public",
    "--dry-run",
  ]);

  assert.equal(result.exitCode, HOST_OPERATION_CLI_EXIT.success, result.stderr);
  assert.deepEqual(readOutput(result).request, {
    method: "POST",
    path: "/apps/{appId}/publish",
    params: { appId: "sample-app" },
    body: {
      version: "1.2.3",
      releaseNotes: "First release",
      visibility: "public",
      applyToCurrentApp: true,
    },
  });

  const keepLocal = await runHostOperationCommand([
    "app",
    "release",
    "publish",
    "--app-id",
    "sample-app",
    "--version",
    "1.2.3",
    "--no-apply-to-current-app",
    "--dry-run",
  ]);
  assert.equal(keepLocal.exitCode, HOST_OPERATION_CLI_EXIT.success, keepLocal.stderr);
  assert.deepEqual(readRecord(readOutput(keepLocal).request).body, { version: "1.2.3", applyToCurrentApp: false });
});

function readOutput(result: HostOperationCliResult): Record<string, unknown> {
  assert.ok(result.stdout);
  return readRecord(JSON.parse(result.stdout) as unknown);
}

function readError(result: HostOperationCliResult): Record<string, unknown> {
  assert.ok(result.stderr);
  return readRecord(JSON.parse(result.stderr) as unknown);
}

function readRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
