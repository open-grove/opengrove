import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openGroveClientOperationIds } from "#client";
import { hostProtocol } from "#protocol/compiled";
import { runHostOperationCommand } from "../cli/host-operation-command.js";
import { packageRoot } from "../package-root.js";
import { createBridgeRoutes } from "../server/routes/bridge-registry.js";

test("every Host contract reaches OpenAPI, Server, generated Client, and CLI", async () => {
  const expected: string[] = hostProtocol.operations.map((operation) => operation.id).sort();
  const openApi = readRecord(
    JSON.parse(await readFile(join(packageRoot(), "packages", "protocol", "openapi.json"), "utf8")) as unknown,
  );
  const openApiIds = Object.values(readRecord(openApi.paths))
    .flatMap((pathItem) => Object.values(readRecord(pathItem)))
    .map((operation) => readRecord(operation).operationId)
    .filter((operationId): operationId is string => typeof operationId === "string")
    .sort();
  const serverIds = createBridgeRoutes()
    .filter((route) => expected.includes(route.id) && route.contract?.id === route.id)
    .map((route) => route.id)
    .sort();
  const cliIds: string[] = [];
  for (const operation of hostProtocol.operations) {
    const result = await runHostOperationCommand([...operation.id.split("."), "--help"]);
    if (result.handled && result.exitCode === 0) cliIds.push(operation.id);
  }

  assert.deepEqual(openApiIds, expected, "OpenAPI must contain every Host Protocol operation exactly once");
  assert.deepEqual(serverIds, expected, "Server routes must register every Host Protocol operation exactly once");
  assert.deepEqual(
    [...openGroveClientOperationIds].sort(),
    expected,
    "generated Client must contain every Host Protocol operation exactly once",
  );
  assert.deepEqual(cliIds.sort(), expected, "CLI must expose every Host Protocol operation exactly once");
});

function readRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
