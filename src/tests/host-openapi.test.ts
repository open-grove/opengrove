import assert from "node:assert/strict";
import { test } from "node:test";
import { hostProtocolToOpenApi } from "#protocol";
import { hostProtocol } from "#protocol/compiled";

test("Host Protocol projects every operation into OpenAPI 3.1", () => {
  const document = hostProtocolToOpenApi(hostProtocol);
  const operation = readRecord(readRecord(document.paths["/rooms/{roomId}/messages"]).post);
  const parameters = readArray(operation.parameters).map(readRecord);
  const requestBody = readRecord(operation.requestBody);
  const requestContent = readRecord(readRecord(requestBody.content)["application/json"]);
  const responses = readRecord(operation.responses);

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(document.servers, [{ url: "/api", description: "OpenGrove Host Bridge API base path." }]);
  assert.deepEqual(
    hostProtocol.operations.map((candidate) => candidate.id),
    Object.values(document.paths).flatMap((pathItem) =>
      Object.values(pathItem).map((candidate) => readRecord(candidate).operationId),
    ),
  );
  assert.equal(operation.operationId, "room.message.create");
  assert.equal(operation["x-opengrove-risk"], "write");
  assert.deepEqual(parameters, [
    {
      name: "roomId",
      in: "path",
      required: true,
      description: "Room identifier; surrounding whitespace is ignored.",
      schema: {
        type: "string",
        minLength: 1,
        description: "Room identifier; surrounding whitespace is ignored.",
      },
    },
  ]);
  assert.equal(requestBody.required, true);
  const requestSchema = readRecord(requestContent.schema);
  assert.equal(requestSchema.type, "object");
  const requestProperties = readRecord(requestSchema.properties);
  assert.deepEqual(readRecord(requestProperties.targetIds).anyOf, [
    { type: "array", items: { type: "string" } },
    { type: "null" },
  ]);
  assert.deepEqual(readRecord(requestProperties.attachments).anyOf, [{ type: "array", items: {} }, { type: "null" }]);
  assert.deepEqual(Object.keys(responses), ["200", "400", "401", "403", "404", "503"]);
});

function readRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
