import { z } from "zod";
import type { HostOperation } from "./operation.js";
import { hostSchemaRegistry } from "./schema-registry.js";

type JsonSchema = Readonly<Record<string, unknown>>;
export type HostSchemaDocuments = Readonly<{
  schemas: Readonly<Record<string, JsonSchema>>;
  roots: Readonly<Record<string, Readonly<{ id: string; reference: boolean }>>>;
}>;

type SchemaRoot = { key: string; schema: z.ZodType; io: "input" | "output"; schemaId?: string };

/** Project the complete graph so Zod retains schema identity across HTTP operations. */
export function compileHostSchemaDocuments(operations: readonly HostOperation[]): HostSchemaDocuments {
  const roots: SchemaRoot[] = operations.flatMap((operation) => [
    ...(["params", "query", "body"] as const).flatMap((section) => {
      const schema = operation[section];
      return schema ? [{ key: `${operation.id}.${section}`, schema, io: "input" as const }] : [];
    }),
    ...[operation.success, ...(operation.additionalSuccesses ?? []), ...(operation.errors ?? [])].flatMap((response) =>
      response.body
        ? [
            {
              key: `${operation.id}.response.${response.status}`,
              schema: response.body,
              io: "output" as const,
              schemaId: response.schemaId,
            },
          ]
        : [],
    ),
  ]);
  const schemas: Record<string, JsonSchema> = {};
  const rootDocuments: Record<string, { id: string; reference: boolean }> = {};
  // Defaults/transforms and unknown-key behavior can differ between input and output.
  for (const io of ["input", "output"] as const) {
    const selected = roots.filter((root) => root.io === io);
    const registry = z.registry<{ id: string }>();
    const names = new Map<string, z.core.$ZodType>();
    const add = (schema: z.core.$ZodType, id: string) => {
      const existing = names.get(id);
      if (existing && existing !== schema) throw new Error(`Host schema name ${id} refers to different schemas.`);
      names.set(id, schema);
      registry.add(schema, { id });
    };
    // Public traversal hook discovers only named records reachable from this catalog.
    for (const root of selected) {
      z.toJSONSchema(root.schema, {
        io,
        unrepresentable: "any",
        override: ({ zodSchema }) => {
          const name = hostSchemaRegistry.get(zodSchema)?.id;
          if (!name) return;
          if (!/^[A-Z][A-Za-z0-9]*$/u.test(name)) throw new Error(`Host schema name ${name} must use PascalCase.`);
          add(zodSchema, io === "input" ? `${name}Input` : name);
        },
      });
    }
    for (const root of selected) {
      const named = registry.get(root.schema)?.id;
      const id = named ?? root.schemaId ?? root.key;
      if (!named) add(root.schema, id);
      rootDocuments[root.key] = { id, reference: Boolean(hostSchemaRegistry.get(root.schema) || root.schemaId) };
    }
    const sharedId = io === "input" ? "HostInputShared" : "HostOutputShared";
    const documents = z.toJSONSchema(registry, {
      io,
      unrepresentable: "any",
      uri: (id) => `opengrove-schema:${id === "__shared" ? sharedId : id}`,
    });
    for (const [name, schema] of Object.entries(documents.schemas)) {
      const id = name === "__shared" ? sharedId : name;
      if (schemas[id]) throw new Error(`Host schema name ${id} collides between input and output.`);
      schemas[id] = schema;
    }
  }
  return { schemas, roots: rootDocuments };
}
