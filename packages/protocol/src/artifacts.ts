import { hostQueryString, stateQueryLimit } from "./compat/host-http.js";
import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostRequestErrors, hostErrorSchema } from "./host-errors.js";
import { artifactRecordSchema } from "./workspace-records.js";

export const createArtifactOperation = defineHostOperation({
  id: "artifact.artifact.create",
  summary: "Create an artifact",
  description:
    "Save a typed artifact with structured data, sources, and media metadata. An explicit existing ID replaces that artifact. The response contains bounded summaries; use artifact get for the full data.",
  method: "POST",
  path: "/artifacts",
  risk: "write",
  body: artifactRecordSchema
    .omit({ createdAt: true, updatedAt: true })
    .partial()
    .extend({
      id: z.string().min(1).optional(),
      type: z.string().min(1).default("note"),
    }),
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), artifact: artifactRecordSchema, artifacts: z.array(artifactRecordSchema) }),
    schemaId: "ArtifactMutation",
  },
  errors: hostRequestErrors,
});
export type CreateArtifactOperation = typeof createArtifactOperation;
export const getArtifactOperation = defineHostOperation({
  id: "artifact.artifact.get",
  summary: "Read an artifact",
  description:
    "Read the complete artifact record, including structured data, media references, provenance, and lineage.",
  method: "GET",
  path: "/artifacts/{artifactId}",
  risk: "read",
  params: z.object({ artifactId: z.string().min(1) }),
  success: { status: 200, body: z.object({ ok: z.literal(true), artifact: artifactRecordSchema }) },
  errors: [...hostRequestErrors, { status: 404, body: hostErrorSchema, description: "The artifact does not exist." }],
});
export type GetArtifactOperation = typeof getArtifactOperation;
export const listArtifactsOperation = defineHostOperation({
  id: "artifact.artifact.list",
  summary: "List artifacts",
  description: "Read bounded artifact summaries. Use get for full data.",
  method: "GET",
  path: "/artifacts",
  risk: "read",
  query: z.object({
    type: hostQueryString,
    id: z.array(z.string()).optional(),
    tag: z.array(z.string()).optional(),
    limit: stateQueryLimit(100, 500),
  }),
  success: { status: 200, body: z.object({ ok: z.literal(true), artifacts: z.array(artifactRecordSchema) }) },
  errors: hostRequestErrors,
});
export const updateArtifactOperation = defineHostOperation({
  id: "artifact.artifact.update",
  summary: "Update an artifact",
  description: "Update saved artifact metadata and structured data.",
  method: "PATCH",
  path: "/artifacts/{artifactId}",
  risk: "write",
  params: getArtifactOperation.params,
  body: artifactRecordSchema
    .omit({ id: true, createdAt: true, updatedAt: true, assets: true, preview: true })
    .partial(),
  success: createArtifactOperation.success,
  errors: getArtifactOperation.errors,
});
export const deleteArtifactOperation = defineHostOperation({
  id: "artifact.artifact.delete",
  summary: "Delete an artifact",
  description: "Delete a saved artifact record.",
  method: "DELETE",
  path: "/artifacts/{artifactId}",
  risk: "high-risk-write",
  params: getArtifactOperation.params,
  success: {
    status: 200,
    body: z.object({ ok: z.literal(true), deleted: z.boolean(), artifacts: z.array(artifactRecordSchema) }),
  },
  errors: hostRequestErrors,
});
export const artifactOperationGroup = defineHostOperationGroup({
  id: "artifact",
  title: "Artifacts",
  description: "Saved outputs, annotations, and media records.",
  resources: [
    defineHostOperationResource({
      id: "artifact",
      title: "Artifacts",
      description: "Manage saved artifact records.",
      operations: [
        createArtifactOperation,
        getArtifactOperation,
        listArtifactsOperation,
        updateArtifactOperation,
        deleteArtifactOperation,
      ] as const,
    }),
  ] as const,
});
