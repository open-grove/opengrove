import { z } from "zod";
import { activitySpaceSchema, jsonObjectSchema } from "./run-records.js";

export const sourceRefSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  locator: z.string().optional(),
  quote: z.string().optional(),
});
export const diagnosticProblemRefSchema = z.object({ incidentId: z.string(), code: z.string() });
export const toolResultSchema = z.object({
  ok: z.boolean(),
  value: z.json().optional(),
  error: z.string().optional(),
  problem: diagnosticProblemRefSchema.optional(),
  sources: z.array(sourceRefSchema).optional(),
});
export const artifactAssetSchema = z.object({
  kind: z.enum(["image", "audio", "video", "file", "url", "text"]),
  uri: z.string().optional(),
  path: z.string().optional(),
  title: z.string().optional(),
  mimeType: z.string().optional(),
  metadata: jsonObjectSchema.optional(),
});
export const artifactPreviewSchema = z.object({
  title: z.string().optional(),
  text: z.string().optional(),
  imageUri: z.string().optional(),
  mimeType: z.string().optional(),
  status: z.string().optional(),
});
export const artifactRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  version: z.number().optional(),
  tags: z.array(z.string()),
  data: jsonObjectSchema,
  assets: z.array(artifactAssetSchema).optional(),
  preview: artifactPreviewSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceRefs: z.array(sourceRefSchema).optional(),
  parentId: z.string().optional(),
  variantOf: z.string().optional(),
  derivedFrom: z.array(z.string()).optional(),
  lineage: z.array(z.string()).optional(),
  provenance: jsonObjectSchema.optional(),
});
export const skillSourceSchema = z.enum(["bundled", "project", "user", "pack"]);
export const skillTrustSchema = z.enum(["trusted", "untrusted"]);
export const skillExecutionContextSchema = z.enum(["inline", "fork"]);
export const invokedSkillRecordSchema = z.object({
  skillId: z.string(),
  skillName: z.string(),
  title: z.string(),
  content: z.string(),
  contentPreview: z.string(),
  sourcePath: z.string(),
  source: skillSourceSchema,
  trust: skillTrustSchema,
  context: skillExecutionContextSchema,
  args: z.string().optional(),
  allowedTools: z.array(z.string()),
  model: z.string().optional(),
  effort: z.string().optional(),
  packId: z.string().optional(),
  capabilityId: z.string().optional(),
  invokedAt: z.string(),
  origin: z.enum(["user", "model"]),
});
export const workingStateRecordSchema = z.object({
  sessionId: z.string().optional(),
  taskSummary: z.string().optional(),
  activeGoal: z.string().optional(),
  selectedModel: z.string().optional(),
  activePackId: z.string().optional(),
  activeSkillId: z.string().optional(),
  pinnedArtifactIds: z.array(z.string()),
  workingArtifactIds: z.array(z.string()),
  pendingApprovalIds: z.array(z.string()),
  pendingQuestionIds: z.array(z.string()),
  activeToolCallIds: z.array(z.string()),
  discoveredSkillIds: z.array(z.string()),
  discoveredSkillNames: z.array(z.string()),
  expandedSkillIds: z.array(z.string()),
  invokedSkills: z.array(invokedSkillRecordSchema),
  loadedNestedMemoryPaths: z.array(z.string()),
  toolSchemaCache: z.record(z.string(), z.string()),
  updatedAt: z.string(),
});
export const memoryScopeSchema = z.enum(["user", "workspace", "page", "session"]);
export const memoryRecordSchema = z.object({
  id: z.string(),
  scope: memoryScopeSchema,
  kind: z.string(),
  text: z.string(),
  confidence: z.enum(["asserted", "observed", "inferred"]),
  source: z.object({ kind: z.enum(["user", "agent", "tool", "skill"]), ref: sourceRefSchema.optional() }),
  tags: z.array(z.string()),
  data: jsonObjectSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().optional(),
});
export const memoryHookSchema = z.object({
  kind: z.string(),
  mode: z.enum(["direct", "propose", "ask"]),
  reason: z.string(),
});
export const skillManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  title: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  format: z.enum(["markdown-v1", "markdown-v2"]),
  entry: z.string(),
  skillRoot: z.string(),
  activities: z.array(activitySpaceSchema),
  toolIds: z.array(z.string()),
  memoryHooks: z.array(memoryHookSchema),
  allowedTools: z.array(z.string()),
  argumentHint: z.string().optional(),
  arguments: z.array(z.string()).optional(),
  userInvocable: z.boolean(),
  disableModelInvocation: z.boolean(),
  model: z.string().optional(),
  effort: z.string().optional(),
  context: skillExecutionContextSchema,
  shell: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  hooks: jsonObjectSchema.optional(),
  source: skillSourceSchema,
  trust: skillTrustSchema,
  packId: z.string().optional(),
  capabilityId: z.string().optional(),
  contentLength: z.number().optional(),
  tags: z.array(z.string()).optional(),
});
export const packManifestSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  source: skillSourceSchema,
  trust: skillTrustSchema,
  rootDir: z.string(),
  skillIds: z.array(z.string()),
  toolIds: z.array(z.string()),
  capabilityIds: z.array(z.string()),
  artifactTypes: z.array(z.string()),
  referenceAssetDirs: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export const permissionRequirementSchema = z.object({ mode: z.enum(["allow", "ask", "deny"]), reason: z.string() });
export const toolRiskSchema = z.enum(["read", "write", "send", "spend", "delete"]);
export const schemaSpecSchema = z.object({ type: z.literal("json-schema"), schema: jsonObjectSchema });
export const toolSpecSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  activity: activitySpaceSchema,
  risk: toolRiskSchema,
  input: schemaSpecSchema,
  output: schemaSpecSchema.optional(),
  permission: permissionRequirementSchema,
  liveness: z
    .object({
      cancellation: z.enum(["run-signal", "none"]),
      deadlineSource: z.enum(["kernel-native", "upstream-service", "business-rule", "none"]),
      abandonOutcome: z.literal("outcome-unknown"),
      terminalConfirmation: z.literal("tool-result"),
      cancellationGraceMs: z.number().optional(),
    })
    .optional(),
});
export const policyRuleSchema = permissionRequirementSchema.extend({
  id: z.string().optional(),
  toolId: z.string().optional(),
  capabilityId: z.string().optional(),
  risk: toolRiskSchema.optional(),
});
export const capabilityManifestSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.string(),
  description: z.string(),
  source: z
    .object({
      kind: z.enum(["native", "wrapped-open-source", "mcp", "external-api", "user-routine"]),
      project: z.string().optional(),
      url: z.string().optional(),
      license: z.string().optional(),
    })
    .optional(),
  activities: z.array(activitySpaceSchema),
  triggers: z.array(jsonObjectSchema).optional(),
  tools: z.array(toolSpecSchema),
  skills: z.array(skillManifestSchema),
  memoryHooks: z.array(memoryHookSchema),
  policy: z.array(policyRuleSchema),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  evals: z
    .array(z.object({ id: z.string(), description: z.string(), input: z.string(), expectedBehavior: z.string() }))
    .optional(),
});
