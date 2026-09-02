import type {
  CompiledHostInputSection,
  CompiledHostOperation,
  CompiledHostProtocol,
  CompiledHostResponse,
} from "./compiler.js";
import type { HostOperationGroup } from "./operation.js";

type JsonSchema = Readonly<Record<string, unknown>>;

export type HostOpenApiDocument = Readonly<{
  openapi: "3.1.0";
  info: Readonly<{
    title: string;
    version: string;
    description: string;
  }>;
  servers: readonly Readonly<{ url: string; description: string }>[];
  tags: readonly Readonly<{ name: string; description: string }>[];
  paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

export type HostOpenApiOptions = Readonly<{
  title?: string;
  version?: string;
  serverUrl?: string;
}>;

export function hostProtocolToOpenApi(
  protocol: CompiledHostProtocol<readonly HostOperationGroup[]>,
  options: HostOpenApiOptions = {},
): HostOpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of protocol.operations) {
    const method = operation.method.toLowerCase();
    const pathItem = paths[operation.path.template] ?? {};
    if (pathItem[method]) {
      throw new Error(`Host operations collide at ${operation.method} ${operation.path.template}.`);
    }
    pathItem[method] = openApiOperation(operation);
    paths[operation.path.template] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "OpenGrove Host API",
      version: options.version ?? "0.1.0",
      description: "Operations exposed through the local OpenGrove Host Protocol catalog.",
    },
    servers: [
      {
        url: options.serverUrl ?? "/api",
        description: "OpenGrove Host Bridge API base path.",
      },
    ],
    tags: protocol.groups.map((group) => ({ name: group.id, description: group.description })),
    paths,
  };
}

function openApiOperation(operation: CompiledHostOperation): Readonly<Record<string, unknown>> {
  const parameters = [
    ...openApiParameters(operation, operation.input.params, "path"),
    ...openApiParameters(operation, operation.input.query, "query"),
  ];
  const responses = Object.fromEntries([
    [String(operation.success.status), openApiResponse(operation.success, true)],
    ...operation.errors.map((response) => [String(response.status), openApiResponse(response, false)] as const),
  ]);

  return {
    operationId: operation.id,
    summary: operation.summary,
    description: operation.description,
    tags: [operation.groupId],
    "x-opengrove-group": operation.groupId,
    "x-opengrove-resource": operation.resourceId,
    "x-opengrove-risk": operation.risk,
    ...(parameters.length ? { parameters } : {}),
    ...(operation.input.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: operation.input.body.jsonSchema } },
          },
        }
      : {}),
    responses,
  };
}

function openApiParameters(
  operation: CompiledHostOperation,
  section: CompiledHostInputSection | undefined,
  location: "path" | "query",
): readonly Readonly<Record<string, unknown>>[] {
  if (!section) return [];
  const properties = schemaProperties(operation.id, section.jsonSchema);
  return section.fields.map((field) => {
    const schema = properties[field.name];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`Host operation ${operation.id} ${section.name}.${field.name} is missing its JSON Schema.`);
    }
    return {
      name: field.name,
      in: location,
      required: location === "path" || field.required,
      ...(readString((schema as JsonSchema).description)
        ? { description: readString((schema as JsonSchema).description) }
        : {}),
      schema,
    };
  });
}

function openApiResponse(response: CompiledHostResponse, success: boolean): Readonly<Record<string, unknown>> {
  return {
    description: response.description ?? (success ? "Successful response." : "Error response."),
    ...(response.jsonSchema ? { content: { "application/json": { schema: response.jsonSchema } } } : {}),
  };
}

function schemaProperties(operationId: string, schema: JsonSchema): Readonly<Record<string, unknown>> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error(`Host operation ${operationId} input JSON Schema has no object properties.`);
  }
  return properties as Readonly<Record<string, unknown>>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
