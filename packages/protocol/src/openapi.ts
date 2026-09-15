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
  components: Readonly<{
    schemas: Readonly<Record<string, JsonSchema>>;
  }>;
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
  const schemas: Record<string, JsonSchema> = {};

  for (const operation of protocol.operations) {
    const method = operation.method.toLowerCase();
    const pathItem = paths[operation.path.template] ?? {};
    if (pathItem[method]) {
      throw new Error(`Host operations collide at ${operation.method} ${operation.path.template}.`);
    }
    pathItem[method] = openApiOperation(operation, schemas);
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
    components: { schemas },
  };
}

/** JSON Schema refs are rooted at their schema document; OpenAPI embeds those documents. */
function embedSchema(schema: JsonSchema, id: string, schemas: Record<string, JsonSchema>, force = false): JsonSchema {
  const pointer = componentPointer(id);
  const { $defs, ...root } = schema;
  const definitions = $defs && typeof $defs === "object" && !Array.isArray($defs) ? Object.entries($defs) : [];
  const definitionPointers = new Map(
    definitions.map(([name]) => [
      `#/$defs/${name.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
      componentPointer(`${id}.definition.${encodeURIComponent(name)}`),
    ]),
  );
  let hasLocalReference = false;
  const rewrite = (reference: string): string => {
    if (!reference.startsWith("#")) return reference;
    hasLocalReference = true;
    for (const [source, destination] of definitionPointers) {
      if (reference === source || reference.startsWith(`${source}/`))
        return destination + reference.slice(source.length);
    }
    return `${pointer}${reference.slice(1)}`;
  };
  const rebased = mapSchemaReferences(root, rewrite) as JsonSchema;
  if (!force && !hasLocalReference) return schema;
  registerComponent(id, rebased, schemas);
  for (const [name, definition] of definitions) {
    registerComponent(
      `${id}.definition.${encodeURIComponent(name)}`,
      mapSchemaReferences(definition, rewrite) as JsonSchema,
      schemas,
    );
  }
  return { $ref: pointer };
}

function componentPointer(id: string): string {
  return `#/components/schemas/${id.replace(/~/gu, "~0").replace(/\//gu, "~1")}`;
}

function registerComponent(id: string, schema: JsonSchema, schemas: Record<string, JsonSchema>): void {
  const existing = schemas[id];
  if (existing && JSON.stringify(existing) !== JSON.stringify(schema)) {
    throw new Error(`Host response schemaId ${id} refers to more than one JSON Schema.`);
  }
  schemas[id] = schema;
}

function mapSchemaReferences(value: unknown, rewrite: (reference: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapSchemaReferences(item, rewrite));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "$ref" && typeof child === "string"
        ? rewrite(child)
        : ["default", "examples", "const", "enum"].includes(key)
          ? child
          : mapSchemaReferences(child, rewrite),
    ]),
  );
}

function openApiOperation(
  operation: CompiledHostOperation,
  schemas: Record<string, JsonSchema>,
): Readonly<Record<string, unknown>> {
  const parameters = [
    ...openApiParameters(operation, operation.input.params, "path", schemas),
    ...openApiParameters(operation, operation.input.query, "query", schemas),
  ];
  const responses = Object.fromEntries([
    [String(operation.success.status), openApiResponse(operation.success, true, operation.id, schemas)],
    ...operation.additionalSuccesses.map(
      (response) => [String(response.status), openApiResponse(response, true, operation.id, schemas)] as const,
    ),
    ...operation.errors.map(
      (response) => [String(response.status), openApiResponse(response, false, operation.id, schemas)] as const,
    ),
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
            content: {
              "application/json": {
                schema: embedSchema(operation.input.body.jsonSchema, `${operation.id}.body`, schemas),
              },
            },
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
  schemas: Record<string, JsonSchema>,
): readonly Readonly<Record<string, unknown>>[] {
  if (!section) return [];
  const id = `${operation.id}.${section.name}`;
  const embedded = embedSchema(section.jsonSchema, id, schemas);
  const properties = schemaProperties(operation.id, schemas[id] ?? embedded);
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

function openApiResponse(
  response: CompiledHostResponse,
  success: boolean,
  operationId: string,
  schemas: Record<string, JsonSchema>,
): Readonly<Record<string, unknown>> {
  return {
    description: response.description ?? (success ? "Successful response." : "Error response."),
    ...(response.jsonSchema
      ? {
          content: {
            "application/json": {
              schema: embedSchema(
                response.jsonSchema,
                response.schemaId ?? `${operationId}.response.${response.status}`,
                schemas,
                Boolean(response.schemaId),
              ),
            },
          },
        }
      : {}),
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
