import type {
  CompiledHostInputSection,
  CompiledHostOperation,
  CompiledHostProtocol,
  CompiledHostResponse,
} from "./compiler.js";
import type { HostOperationGroup } from "./operation.js";
import type { HostSchemaDocuments } from "./schema-documents.js";

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
  const { schemas, roots } = embedSchemaDocuments(protocol.schemaDocuments);

  for (const operation of protocol.operations) {
    const method = operation.method.toLowerCase();
    const pathItem = paths[operation.path.template] ?? {};
    if (pathItem[method]) {
      throw new Error(`Host operations collide at ${operation.method} ${operation.path.template}.`);
    }
    pathItem[method] = openApiOperation(operation, schemas, roots);
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

/** Keep named records and recursive definitions shared across the whole document. */
function embedSchemaDocuments(documents: HostSchemaDocuments) {
  const schemas: Record<string, JsonSchema> = {};
  const rewrite = (reference: string): string => {
    if (!reference.startsWith("opengrove-schema:")) return reference;
    const [id, fragment = ""] = reference.slice("opengrove-schema:".length).split("#");
    if (fragment.startsWith("/$defs/")) {
      const [name, ...rest] = fragment.slice("/$defs/".length).split("/");
      return componentPointer(`${id}.definition.${name}`) + (rest.length ? `/${rest.join("/")}` : "");
    }
    return componentPointer(id!) + fragment;
  };
  for (const [id, document] of Object.entries(documents.schemas)) {
    const { $id, $schema, $defs, ...root } = document;
    registerComponent(id, mapSchemaReferences(root, rewrite) as JsonSchema, schemas);
    if ($defs && typeof $defs === "object" && !Array.isArray($defs)) {
      for (const [name, definition] of Object.entries($defs)) {
        registerComponent(`${id}.definition.${name}`, mapSchemaReferences(definition, rewrite) as JsonSchema, schemas);
      }
    }
  }
  const roots = Object.fromEntries(
    Object.entries(documents.roots).map(([key, root]) => [
      key,
      root.reference ? { $ref: componentPointer(root.id) } : schemas[root.id]!,
    ]),
  );
  // Wrapper documents are kept inline; publish only components reachable from them.
  const reachable = new Set<string>();
  const visit = (schema: JsonSchema): void => {
    mapSchemaReferences(schema, (reference) => {
      const prefix = "#/components/schemas/";
      if (!reference.startsWith(prefix)) return reference;
      const id = reference.slice(prefix.length).split("/")[0]!.replace(/~1/gu, "/").replace(/~0/gu, "~");
      if (reachable.has(id)) return reference;
      const target = schemas[id];
      if (!target) throw new Error(`Unresolved Host schema reference: ${reference}`);
      reachable.add(id);
      visit(target);
      return reference;
    });
  };
  for (const root of Object.values(roots)) visit(root);
  return { schemas: Object.fromEntries(Object.entries(schemas).filter(([id]) => reachable.has(id))), roots };
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

const SINGLE_SCHEMA_KEYS = new Set([
  "not",
  "if",
  "then",
  "else",
  "contains",
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "contentSchema",
]);
const ARRAY_SCHEMA_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const MAP_SCHEMA_KEYS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]);

function mapSchemaReferences(value: unknown, rewrite: (reference: string) => string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string") return [key, rewrite(child)];
      if (SINGLE_SCHEMA_KEYS.has(key)) return [key, mapSchemaReferences(child, rewrite)];
      if (ARRAY_SCHEMA_KEYS.has(key) && Array.isArray(child)) {
        return [key, child.map((schema) => mapSchemaReferences(schema, rewrite))];
      }
      if (MAP_SCHEMA_KEYS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(child).map(([name, schema]) => [name, mapSchemaReferences(schema, rewrite)]),
          ),
        ];
      }
      // Names inside properties are data keys; defaults, examples, const, and enum values are data too.
      return [key, child];
    }),
  );
}

function openApiOperation(
  operation: CompiledHostOperation,
  schemas: Record<string, JsonSchema>,
  roots: Record<string, JsonSchema>,
): Readonly<Record<string, unknown>> {
  const parameters = [
    ...openApiParameters(operation, operation.input.params, "path", schemas, roots),
    ...openApiParameters(operation, operation.input.query, "query", schemas, roots),
  ];
  const responses = Object.fromEntries([
    [String(operation.success.status), openApiResponse(operation.success, true, operation.id, roots)],
    ...operation.additionalSuccesses.map(
      (response) => [String(response.status), openApiResponse(response, true, operation.id, roots)] as const,
    ),
    ...operation.errors.map(
      (response) => [String(response.status), openApiResponse(response, false, operation.id, roots)] as const,
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
                schema: roots[`${operation.id}.body`],
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
  roots: Record<string, JsonSchema>,
): readonly Readonly<Record<string, unknown>>[] {
  if (!section) return [];
  const id = `${operation.id}.${section.name}`;
  const embedded = roots[id]!;
  const resolved =
    typeof embedded.$ref === "string" ? schemas[embedded.$ref.slice("#/components/schemas/".length)]! : embedded;
  const properties = schemaProperties(operation.id, resolved);
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
  roots: Record<string, JsonSchema>,
): Readonly<Record<string, unknown>> {
  return {
    description: response.description ?? (success ? "Successful response." : "Error response."),
    ...(response.jsonSchema
      ? {
          content: {
            "application/json": {
              schema: roots[`${operationId}.response.${response.status}`],
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
