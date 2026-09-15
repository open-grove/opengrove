import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { compileHostProtocol } from "#protocol/compiler";
import {
  defineHostOperation,
  defineHostOperationGroup,
  defineHostOperationResource,
  hostProtocolToOpenApi,
} from "#protocol";
import { hostProtocol } from "#protocol/compiled";

test("Host Protocol projects every operation into OpenAPI 3.1", () => {
  const document = hostProtocolToOpenApi(hostProtocol);
  const operation = readRecord(readRecord(document.paths["/rooms/{roomId}/messages"]).post);
  const parameters = readArray(operation.parameters).map(readRecord);
  const requestBody = readRecord(operation.requestBody);
  const requestContent = readRecord(readRecord(requestBody.content)["application/json"]);
  const responses = readRecord(operation.responses);

  assert.equal(document.openapi, "3.1.0");
  const schemas = readRecord(readRecord(document).components).schemas;
  assert.deepEqual(readRecord(readRecord(schemas).AuthError).properties, {
    ok: { type: "boolean", const: false },
    error: { type: "string" },
    code: { type: "string" },
    requestId: { type: "string" },
    incidentId: { type: "string" },
    traceId: { type: "string" },
    retryAfter: { type: "number", minimum: 0 },
  });
  const authLogin = readRecord(readRecord(document.paths["/auth/login"]).post);
  const authResponses = readRecord(authLogin.responses);
  assert.deepEqual(
    readRecord(readRecord(readRecord(readRecord(authResponses["400"]).content)["application/json"]).schema),
    { $ref: "#/components/schemas/AuthError" },
  );
  assert.deepEqual(document.servers, [{ url: "/api", description: "OpenGrove Host Bridge API base path." }]);
  assert.deepEqual(
    hostProtocol.operations.map((candidate) => candidate.id).sort(),
    Object.values(document.paths)
      .flatMap((pathItem) => Object.values(pathItem).map((candidate) => readRecord(candidate).operationId))
      .sort(),
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
  assert.deepEqual(Object.keys(responses), ["200", "400", "401", "403", "404", "409", "503"]);

  const publish = readRecord(readRecord(document.paths["/apps/{appId}/publish"]).post);
  assert.deepEqual(Object.keys(readRecord(publish.responses)).slice(0, 2), ["200", "202"]);
});

function readRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

test("OpenAPI keeps recursive JSON references resolvable after embedding schemas", () => {
  const fixture = defineHostOperation({
    id: "fixture.json.echo",
    summary: "Echo JSON",
    description: "Recursive JSON contract fixture.",
    method: "POST",
    path: "/fixture",
    risk: "write",
    query: z.object({ filter: z.json().optional() }),
    body: z.object({ value: z.json() }),
    success: { status: 200, body: z.object({ value: z.json() }) },
  });
  const catalog = compileHostProtocol([
    defineHostOperationGroup({
      id: "fixture",
      title: "Fixture",
      description: "OpenAPI fixtures.",
      resources: [
        defineHostOperationResource({
          id: "json",
          title: "JSON",
          description: "Recursive values.",
          operations: [fixture] as const,
        }),
      ] as const,
    }),
  ] as const);
  const document = hostProtocolToOpenApi(catalog);
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#")) {
      let target: unknown = document;
      for (const segment of record.$ref.slice(2).split("/")) {
        const name = segment.replace(/~1/g, "/").replace(/~0/g, "~");
        assert.ok(target && typeof target === "object" && name in target, `Unresolved reference: ${record.$ref}`);
        target = (target as Record<string, unknown>)[name];
      }
    }
    Object.values(record).forEach(inspect);
  }
  inspect(document);
});
