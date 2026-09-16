import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { compileHostProtocol } from "#protocol/compiler";
import {
  defineHostOperation,
  defineHostOperationGroup,
  defineHostOperationResource,
  hostProtocolToOpenApi,
  hostSchemaRegistry,
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
    body: z.object({ value: z.json(), enum: z.json() }),
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

test("OpenAPI reuses named Room, message and Employee records across operations", () => {
  const document = hostProtocolToOpenApi(hostProtocol);
  const schemas = document.components.schemas;
  assert.ok(schemas.Room, "Room must be a shared component");
  assert.ok(schemas.RoomMessage, "RoomMessage must be a shared component");
  assert.ok(schemas.Employee, "Employee must be a shared component");
  const response = (path: string, method: string) => {
    const operation = readRecord(document.paths[path]?.[method]);
    return readRecord(
      readRecord(readRecord(readRecord(readRecord(operation.responses)["200"]).content)["application/json"]).schema,
    );
  };
  const create = response("/rooms", "post");
  const read = response("/rooms/{roomId}/read", "post");
  assert.deepEqual(readRecord(create.properties).room, { $ref: "#/components/schemas/Room" });
  assert.deepEqual(readRecord(read.properties).room, { $ref: "#/components/schemas/Room" });
  const message = response("/rooms/{roomId}/messages", "post");
  assert.deepEqual(readRecord(message.properties).userMessage, { $ref: "#/components/schemas/RoomMessage" });
  assert.deepEqual(readRecord(readRecord(message.properties).assistantMessages).items, {
    $ref: "#/components/schemas/RoomMessage",
  });
  assert.deepEqual(readRecord(response("/rooms/{roomId}/members/{memberId}", "post").properties).member, {
    $ref: "#/components/schemas/Employee",
  });
});

test("shared OpenAPI schemas preserve every standalone request and response contract", () => {
  const document = hostProtocolToOpenApi(hostProtocol);
  for (const operation of hostProtocol.operations) {
    const projected = readRecord(document.paths[operation.path.template]?.[operation.method.toLowerCase()]);
    if (operation.input.body) {
      const schema = readRecord(readRecord(readRecord(projected.requestBody).content)["application/json"]).schema;
      assertSchemaEquivalent(operation.input.body.jsonSchema, operation.input.body.jsonSchema, schema, document);
    }
    for (const section of [operation.input.params, operation.input.query]) {
      if (!section) continue;
      const parameters = readArray(projected.parameters).map(readRecord);
      for (const field of section.fields) {
        const parameter = parameters.find((candidate) => candidate.name === field.name);
        assert.ok(parameter, `${operation.id}.${field.name}`);
        assertSchemaEquivalent(
          readRecord(section.jsonSchema.properties)[field.name],
          section.jsonSchema,
          parameter.schema,
          document,
        );
      }
    }
    for (const response of [operation.success, ...operation.additionalSuccesses, ...operation.errors]) {
      if (!response.jsonSchema) continue;
      const body = readRecord(
        readRecord(readRecord(readRecord(projected.responses)[String(response.status)]).content)["application/json"],
      );
      assertSchemaEquivalent(response.jsonSchema, response.jsonSchema, body.schema, document);
    }
  }
});

test("named shared records keep input defaults separate from output requirements", () => {
  const record = z
    .object({ name: z.string().default("Untitled"), data: z.json().optional() })
    .register(hostSchemaRegistry, { id: "ProjectionRecord" });
  const operation = defineHostOperation({
    id: "fixture.record.echo",
    summary: "Echo",
    description: "Named projection fixture.",
    method: "POST",
    path: "/fixture",
    risk: "write",
    body: z.object({ record }),
    success: { status: 200, body: z.object({ record }) },
  });
  const protocol = compileHostProtocol([
    {
      id: "fixture",
      title: "Fixture",
      description: "Projection fixtures.",
      resources: [{ id: "record", title: "Record", description: "Shared records.", operations: [operation] }],
    },
  ]);
  const document = hostProtocolToOpenApi(protocol);
  assert.equal(document.components.schemas.ProjectionRecordInput?.required, undefined);
  assert.deepEqual(document.components.schemas.ProjectionRecord?.required, ["name"]);
  assert.equal(document.components.schemas.ProjectionRecordInput?.additionalProperties, undefined);
  assert.equal(document.components.schemas.ProjectionRecord?.additionalProperties, false);
  assert.deepEqual(operation.body.parse({ record: {} }), { record: { name: "Untitled" } });
  assert.equal(protocol.operations[0]?.input.body?.jsonSchema.$ref, undefined, "CLI keeps a standalone object schema");
});

// Compare validation structure against the independent per-operation Zod projection.
// Follow refs as a graph, so recursive JSON values terminate without dropping constraints.
function assertSchemaEquivalent(left: unknown, leftDocument: unknown, right: unknown, rightDocument: unknown): void {
  const pairs = new WeakMap<object, WeakSet<object>>();
  const resolve = (input: unknown, document: unknown): unknown => {
    let schema = input;
    const seen = new Set<unknown>();
    while (schema && typeof schema === "object" && !Array.isArray(schema) && "$ref" in schema) {
      assert.ok(!seen.has(schema), "reference aliases must resolve to a concrete schema");
      seen.add(schema);
      const ref = (schema as { $ref: unknown }).$ref;
      assert.equal(typeof ref, "string");
      assert.ok((ref as string).startsWith("#"), `external ref in generated OpenAPI: ${ref}`);
      let target = document;
      for (const segment of (ref as string).slice(2).split("/")) {
        if (!segment) continue;
        target = readRecord(target)[segment.replace(/~1/gu, "/").replace(/~0/gu, "~")];
      }
      assert.ok(target, `unresolved ref: ${ref}`);
      const { $ref, $schema, $id, $defs, ...siblings } = readRecord(schema);
      schema = Object.keys(siblings).length ? { ...readRecord(target), ...siblings } : target;
    }
    return schema;
  };
  const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas"]);
  const schemaArrays = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
  const schemaSingles = new Set([
    "items",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "unevaluatedProperties",
  ]);
  const ignored = new Set(["$schema", "$id", "$defs", "$ref"]);
  const compare = (a: unknown, b: unknown): void => {
    a = resolve(a, leftDocument);
    b = resolve(b, rightDocument);
    if (!a || !b || typeof a !== "object" || typeof b !== "object") {
      assert.deepEqual(a, b);
      return;
    }
    const prior = pairs.get(a) ?? new WeakSet<object>();
    if (prior.has(b)) return;
    prior.add(b);
    pairs.set(a, prior);
    const lhs = readRecord(a),
      rhs = readRecord(b);
    const keys = Object.keys(lhs)
      .filter((key) => !ignored.has(key))
      .sort();
    assert.deepEqual(
      Object.keys(rhs)
        .filter((key) => !ignored.has(key))
        .sort(),
      keys,
    );
    for (const key of keys) {
      if (schemaMaps.has(key)) {
        const lm = readRecord(lhs[key]),
          rm = readRecord(rhs[key]);
        assert.deepEqual(Object.keys(rm).sort(), Object.keys(lm).sort());
        for (const name of Object.keys(lm)) compare(lm[name], rm[name]);
      } else if (schemaArrays.has(key)) {
        const la = readArray(lhs[key]),
          ra = readArray(rhs[key]);
        assert.equal(ra.length, la.length);
        la.forEach((item, index) => compare(item, ra[index]));
      } else if (schemaSingles.has(key)) compare(lhs[key], rhs[key]);
      else assert.deepEqual(rhs[key], lhs[key]);
    }
  };
  compare(left, right);
}

test("shared schema names cannot silently replace a different record", () => {
  const first = z.object({ id: z.string() }).register(hostSchemaRegistry, { id: "ConflictingRecord" });
  const second = z.object({ id: z.number() }).register(hostSchemaRegistry, { id: "ConflictingRecord" });
  assert.throws(
    () =>
      compileHostProtocol([
        {
          id: "fixture",
          title: "Fixture",
          description: "Naming conflicts.",
          resources: [
            {
              id: "record",
              title: "Record",
              description: "Records.",
              operations: [
                {
                  id: "fixture.record.get",
                  summary: "Get",
                  description: "Conflicting schemas.",
                  method: "GET",
                  path: "/fixture",
                  risk: "read",
                  success: { status: 200, body: z.object({ first, second }) },
                },
              ],
            },
          ],
        },
      ]),
    /Host schema name ConflictingRecord refers to different schemas/,
  );
});
