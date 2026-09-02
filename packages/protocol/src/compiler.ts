import { z } from "zod";
import type { HostOperation, HostOperationGroup, HostOperationResponse } from "./operation.js";

export type HostOperationInputSectionName = "params" | "query" | "body";

export type CompiledHostSchemaField = Readonly<{
  name: string;
  required: boolean;
}>;

export type CompiledHostInputSection = Readonly<{
  name: HostOperationInputSectionName;
  fields: readonly CompiledHostSchemaField[];
  jsonSchema: Readonly<Record<string, unknown>>;
}>;

export type CompiledHostResponse = Readonly<{
  status: number;
  description?: string;
  schemaId?: string;
  jsonSchema?: Readonly<Record<string, unknown>>;
}>;

export type CompiledHostOperation<TOperation extends HostOperation = HostOperation> = Readonly<{
  id: TOperation["id"];
  groupId: string;
  resourceId: string;
  methodName: string;
  summary: string;
  description: string;
  method: TOperation["method"];
  risk: TOperation["risk"];
  path: Readonly<{
    template: string;
    parameterNames: readonly string[];
    regexpSource: string;
  }>;
  input: Readonly<{
    mode: "none" | "flat";
    optional: boolean;
    params?: CompiledHostInputSection;
    query?: CompiledHostInputSection;
    body?: CompiledHostInputSection;
  }>;
  success: CompiledHostResponse;
  errors: readonly CompiledHostResponse[];
  operation: TOperation;
}>;

export type CompiledHostOperationResource = Readonly<{
  id: string;
  title: string;
  description: string;
  operations: readonly CompiledHostOperation[];
}>;

export type CompiledHostOperationGroup = Readonly<{
  id: string;
  title: string;
  description: string;
  resources: readonly CompiledHostOperationResource[];
}>;

export type HostOperationFromGroups<TGroups extends readonly HostOperationGroup[]> =
  TGroups[number]["resources"][number]["operations"][number];

export type CompiledHostOperationById<TOperation extends HostOperation> = {
  readonly [TId in TOperation["id"]]: CompiledHostOperation<Extract<TOperation, { id: TId }>>;
};

export type CompiledHostProtocol<TGroups extends readonly HostOperationGroup[]> = Readonly<{
  groups: readonly CompiledHostOperationGroup[];
  operations: readonly CompiledHostOperation<HostOperationFromGroups<TGroups>>[];
  operationById: CompiledHostOperationById<HostOperationFromGroups<TGroups>>;
}>;

export function compileHostProtocol<const TGroups extends readonly HostOperationGroup[]>(
  groups: TGroups,
): CompiledHostProtocol<TGroups> {
  const groupIds = new Set<string>();
  const operationIds = new Set<string>();
  const compiledOperations: CompiledHostOperation[] = [];
  const compiledGroups = groups.map((group) => {
    assertMetadata(`Host operation group ${group.id}`, group.id, group.title, group.description);
    assertCatalogSegment("Host operation group", group.id);
    if (groupIds.has(group.id)) throw new Error(`Duplicate Host operation group id: ${group.id}`);
    groupIds.add(group.id);
    const resourceIds = new Set<string>();
    return {
      id: group.id,
      title: group.title,
      description: group.description,
      resources: group.resources.map((resource) => {
        assertMetadata(
          `Host operation resource ${group.id}.${resource.id}`,
          resource.id,
          resource.title,
          resource.description,
        );
        assertCatalogSegment(`Host operation resource in ${group.id}`, resource.id);
        if (resourceIds.has(resource.id)) {
          throw new Error(`Duplicate Host operation resource id: ${group.id}.${resource.id}`);
        }
        resourceIds.add(resource.id);
        const prefix = `${group.id}.${resource.id}.`;
        return {
          id: resource.id,
          title: resource.title,
          description: resource.description,
          operations: resource.operations.map((operation) => {
            if (!operation.id.startsWith(prefix) || operation.id.length === prefix.length) {
              throw new Error(`Host operation ${operation.id} must start with ${prefix} and include a method name.`);
            }
            if (operationIds.has(operation.id)) throw new Error(`Duplicate Host operation id: ${operation.id}`);
            operationIds.add(operation.id);
            const compiled = compileOperation(group.id, resource.id, operation);
            compiledOperations.push(compiled);
            return compiled;
          }),
        };
      }),
    };
  });
  const operationById = Object.fromEntries(
    compiledOperations.map((operation) => [operation.id, operation]),
  ) as CompiledHostOperationById<HostOperationFromGroups<TGroups>>;
  return {
    groups: compiledGroups,
    operations: compiledOperations as readonly CompiledHostOperation<HostOperationFromGroups<TGroups>>[],
    operationById,
  };
}

function compileOperation<TOperation extends HostOperation>(
  groupId: string,
  resourceId: string,
  operation: TOperation,
): CompiledHostOperation<TOperation> {
  assertMetadata(`Host operation ${operation.id}`, operation.id, operation.summary, operation.description);
  for (const segment of operation.id.split(".")) assertCatalogSegment(`Host operation ${operation.id}`, segment);
  const path = compilePath(operation);
  const params = operation.params ? compileInputSection(operation, "params", operation.params) : undefined;
  const query = operation.query ? compileInputSection(operation, "query", operation.query) : undefined;
  const body = operation.body ? compileInputSection(operation, "body", operation.body) : undefined;
  if (operation.method === "GET" && body)
    throw new Error(`Host operation ${operation.id} GET must not declare a body.`);
  assertPathParameters(operation.id, path.parameterNames, params?.fields.map((field) => field.name) ?? []);
  assertDisjointInputFields(operation.id, { params, query, body });
  const sections = [params, query, body].filter((section): section is CompiledHostInputSection => Boolean(section));
  const success = compileResponse(operation.id, "success", operation.success);
  if (success.status < 200 || success.status >= 300) {
    throw new Error(`Host operation ${operation.id} success status must be in the 2xx range.`);
  }
  const responseStatuses = new Set([success.status]);
  const errors = (operation.errors ?? []).map((response) => {
    const compiled = compileResponse(operation.id, "error", response);
    if (compiled.status >= 200 && compiled.status < 300) {
      throw new Error(`Host operation ${operation.id} error status must not be in the 2xx range.`);
    }
    if (responseStatuses.has(compiled.status)) {
      throw new Error(`Host operation ${operation.id} declares response status ${compiled.status} more than once.`);
    }
    responseStatuses.add(compiled.status);
    return compiled;
  });
  return {
    id: operation.id,
    groupId,
    resourceId,
    methodName: operation.id.slice(`${groupId}.${resourceId}.`.length),
    summary: operation.summary,
    description: operation.description,
    method: operation.method,
    risk: operation.risk,
    path,
    input: {
      mode: sections.length ? "flat" : "none",
      optional: sections.length > 0 && sections.every((section) => section.fields.every((field) => !field.required)),
      ...(params ? { params } : {}),
      ...(query ? { query } : {}),
      ...(body ? { body } : {}),
    },
    success,
    errors,
    operation,
  };
}

function compileInputSection(
  operation: HostOperation,
  name: HostOperationInputSectionName,
  schema: z.ZodObject,
): CompiledHostInputSection {
  const jsonSchema = compileJsonSchema(operation.id, name, schema, "input");
  if (jsonSchema.type !== "object" || !isRecord(jsonSchema.properties)) {
    throw new Error(`Host operation ${operation.id} ${name} must compile to a top-level object schema.`);
  }
  const required = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required.filter(isString) : []);
  return {
    name,
    fields: Object.keys(jsonSchema.properties)
      .sort()
      .map((fieldName) => ({ name: fieldName, required: required.has(fieldName) })),
    jsonSchema,
  };
}

function compileResponse(operationId: string, kind: "success" | "error", response: HostOperationResponse) {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new Error(`Host operation ${operationId} ${kind} status must be an HTTP status code.`);
  }
  if (response.schemaId && !/^[A-Z][A-Za-z0-9]*$/u.test(response.schemaId)) {
    throw new Error(
      `Host operation ${operationId} ${kind} schemaId ${response.schemaId} must use PascalCase identifier syntax.`,
    );
  }
  if (response.schemaId && !response.body) {
    throw new Error(`Host operation ${operationId} ${kind} schemaId requires a response body.`);
  }
  return {
    status: response.status,
    ...(response.description ? { description: response.description } : {}),
    ...(response.schemaId ? { schemaId: response.schemaId } : {}),
    ...(response.body
      ? { jsonSchema: compileJsonSchema(operationId, `${kind} response`, response.body, "output") }
      : {}),
  };
}

function compileJsonSchema(
  operationId: string,
  owner: string,
  schema: z.ZodType,
  io: "input" | "output",
): Readonly<Record<string, unknown>> {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Host operation ${operationId} ${owner} cannot compile to JSON Schema: ${detail}`);
  }
}

function compilePath(operation: HostOperation): CompiledHostOperation["path"] {
  if (!operation.path.startsWith("/")) throw new Error(`Host operation ${operation.id} path must start with /.`);
  if (operation.path.includes("?") || operation.path.includes("#")) {
    throw new Error(`Host operation ${operation.id} path must not include a query string or fragment.`);
  }
  const parameterNames: string[] = [];
  const expression = operation.path
    .split(/(\{[^/{}]+\})/u)
    .map((part) => {
      const match = part.match(/^\{([^/{}]+)\}$/u);
      if (!match) return escapeRegExp(part);
      const parameterName = match[1]!;
      if (parameterNames.includes(parameterName)) {
        throw new Error(`Host operation ${operation.id} path parameter ${parameterName} appears more than once.`);
      }
      parameterNames.push(parameterName);
      return "([^/]+)";
    })
    .join("");
  if (/[{}]/u.test(operation.path.replace(/\{[^/{}]+\}/gu, ""))) {
    throw new Error(`Host operation ${operation.id} path contains an invalid parameter placeholder.`);
  }
  return { template: operation.path, parameterNames, regexpSource: `^${expression}$` };
}

function assertPathParameters(operationId: string, pathNames: readonly string[], paramNames: readonly string[]): void {
  const missing = pathNames.filter((name) => !paramNames.includes(name));
  const unused = paramNames.filter((name) => !pathNames.includes(name));
  if (missing.length || unused.length) {
    const details = [
      ...(missing.length ? [`missing params schema fields: ${missing.join(", ")}`] : []),
      ...(unused.length ? [`unused params schema fields: ${unused.join(", ")}`] : []),
    ].join("; ");
    throw new Error(`Host operation ${operationId} path parameters do not match params schema (${details}).`);
  }
}

function assertDisjointInputFields(
  operationId: string,
  sections: Partial<Record<HostOperationInputSectionName, CompiledHostInputSection>>,
): void {
  const owners = new Map<string, HostOperationInputSectionName>();
  for (const name of ["params", "query", "body"] as const) {
    for (const field of sections[name]?.fields ?? []) {
      const previous = owners.get(field.name);
      if (previous) {
        throw new Error(`Host operation ${operationId} field ${field.name} appears in both ${previous} and ${name}.`);
      }
      owners.set(field.name, name);
    }
  }
}

function assertMetadata(owner: string, id: string, title: string, description: string): void {
  if (!id.trim()) throw new Error(`${owner} id must not be empty.`);
  if (!title.trim()) throw new Error(`${owner} title or summary must not be empty.`);
  if (!description.trim()) throw new Error(`${owner} description must not be empty.`);
}

function assertCatalogSegment(owner: string, value: string): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new Error(`${owner} id segment ${value} must use lower-case kebab syntax.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
