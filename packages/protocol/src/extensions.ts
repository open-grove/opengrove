import { z } from "zod";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostErrorSchema, hostRequestErrors } from "./host-errors.js";
import { jsonObjectSchema } from "./run-records.js";

const kind = z.enum(["app", "skill", "mcp", "plugin", "hook", "tool", "cli"]);
const kernel = z.enum(["codex", "claude-code", "hermes", "pi", "openclaw", "opencode", "kimi"]);
const source = z.object({
  origin: z.enum(["opengrove", "kernel", "plugin", "registry", "git", "local", "system", "unknown"]),
  kernelId: kernel.optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  packageId: z.string().optional(),
  readonly: z.boolean().optional(),
  system: z.boolean().optional(),
});
export const extensionDeploymentSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  kind,
  kernelId: kernel.optional(),
  scope: z.enum(["user", "project", "workspace", "system", "managed", "external"]),
  status: z.enum(["enabled", "disabled", "unpublished", "missing", "unsupported"]),
  enabled: z.boolean(),
  managedByOpenGrove: z.boolean(),
  readonly: z.boolean(),
  system: z.boolean(),
  sourcePath: z.string().optional(),
  targetPath: z.string().optional(),
  configPath: z.string().optional(),
  configFormat: z.string().optional(),
  markerPath: z.string().optional(),
  reason: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  envKeys: z.array(z.string()).optional(),
  metadata: jsonObjectSchema.optional(),
});
const commandUsage = z.object({
  command: z.string(),
  args: z.array(z.string()),
  envKeys: z.array(z.string()),
  parentKind: kind,
  parentId: z.string(),
  kernelId: kernel.optional(),
  configPath: z.string().optional(),
  resolvedPath: z.string().optional(),
  risk: z.enum(["low", "medium", "high"]),
});
export const extensionInventorySchema = z.object({
  scannedAt: z.string(),
  workspaceRoot: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      kind,
      name: z.string(),
      title: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      managedByOpenGrove: z.boolean(),
      readonly: z.boolean(),
      system: z.boolean(),
      source,
      deployments: z.array(extensionDeploymentSchema),
      permissions: z.array(
        z.object({
          type: z.enum(["filesystem", "network", "shell", "env", "model", "unknown"]),
          values: z.array(z.string()),
        }),
      ),
      commandUsages: z.array(commandUsage),
      parentId: z.string().optional(),
      childIds: z.array(z.string()),
      tags: z.array(z.string()),
      metadata: jsonObjectSchema.optional(),
    }),
  ),
  deployments: z.array(extensionDeploymentSchema),
  commandUsages: z.array(commandUsage),
  summary: z.object({
    itemCount: z.number(),
    deploymentCount: z.number(),
    byKind: z.record(z.string(), z.number()),
    byKernel: z.record(z.string(), z.number()),
    managedCount: z.number(),
    systemCount: z.number(),
  }),
});
const resultSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  records: z.array(extensionDeploymentSchema),
  warnings: z.array(z.string()),
});
const mutationSchema = z.object({ ok: z.boolean(), result: resultSchema, extensions: extensionInventorySchema });
const query = z.object({ includeSystem: z.boolean().optional() });
const selector = z.object({
  sourcePath: z.string().optional(),
  deploymentId: z.string().optional(),
  itemId: z.string().optional(),
  name: z.string().optional(),
  replace: z.boolean().optional(),
});
const deploymentSelector = z.object({
  deploymentIds: z.array(z.string()).optional(),
  itemId: z.string().optional(),
  kind: kind.optional(),
  forceExternal: z.boolean().optional(),
  reason: z.string().optional(),
});
const errors = [
  {
    status: 400,
    body: z.union([mutationSchema, hostErrorSchema]),
    description: "Extension action rejected; inspect result warnings.",
  },
  ...hostRequestErrors.filter((error) => error.status !== 400),
] as const;
export const listExtensionsOperation = defineHostOperation({
  id: "extension.extension.list",
  summary: "Inspect skills and extensions",
  description: "Discover local Skills, MCP configurations, hooks, tools and their actual deployments.",
  method: "GET",
  path: "/extensions",
  risk: "read",
  query,
  success: { status: 200, body: z.object({ ok: z.literal(true), extensions: extensionInventorySchema }) },
  errors: hostRequestErrors,
});
export const importSkillOperation = defineHostOperation({
  id: "extension.skill.import",
  summary: "Import a Skill",
  description: "Copy a local Skill into the Host-managed library.",
  method: "POST",
  path: "/extensions/skills/import",
  risk: "write",
  query,
  body: selector,
  success: { status: 200, body: mutationSchema },
  errors,
});
export const publishSkillOperation = defineHostOperation({
  id: "extension.skill.publish",
  summary: "Make a Skill available to Kernels",
  description: "Deploy a Skill to explicit Kernel configuration roots, retaining ownership and collision checks.",
  method: "POST",
  path: "/extensions/skills/publish",
  risk: "high-risk-write",
  query,
  body: selector.extend({
    librarySkillId: z.string().optional(),
    targetKernelIds: z.array(kernel).optional(),
    scope: z.enum(["project", "user"]).default("user"),
  }),
  success: { status: 200, body: mutationSchema },
  errors,
});
export const republishSkillOperation = defineHostOperation({
  id: "extension.skill.republish",
  summary: "Refresh Skill deployments",
  description: "Update existing managed Skill deployments.",
  method: "POST",
  path: "/extensions/skills/republish",
  risk: "high-risk-write",
  query,
  body: z.object({
    deploymentIds: z.array(z.string()).optional(),
    itemId: z.string().optional(),
    name: z.string().optional(),
    targetKernelIds: z.array(kernel).optional(),
  }),
  success: { status: 200, body: mutationSchema },
  errors,
});
export const unpublishSkillOperation = defineHostOperation({
  id: "extension.skill.unpublish",
  summary: "Remove Skill deployments",
  description: "Remove selected managed deployments, preserving source library files.",
  method: "POST",
  path: "/extensions/skills/unpublish",
  risk: "high-risk-write",
  query,
  body: z.object({
    deploymentIds: z.array(z.string()).optional(),
    itemId: z.string().optional(),
    name: z.string().optional(),
    targetKernelIds: z.array(kernel).optional(),
    forceExternal: z.boolean().optional(),
    deleteLibrary: z.boolean().optional(),
  }),
  success: { status: 200, body: mutationSchema },
  errors,
});
export const enableDeploymentOperation = defineHostOperation({
  id: "extension.deployment.enable",
  summary: "Enable an extension deployment",
  description: "Enable selected deployments according to their ownership and Kernel support.",
  method: "POST",
  path: "/extensions/deployments/enable",
  risk: "high-risk-write",
  query,
  body: deploymentSelector.extend({ enabled: z.boolean().optional() }),
  success: { status: 200, body: mutationSchema },
  errors,
});
export const disableDeploymentOperation = defineHostOperation({
  id: "extension.deployment.disable",
  summary: "Disable an extension deployment",
  description: "Disable selected deployments without deleting their source.",
  method: "POST",
  path: "/extensions/deployments/disable",
  risk: "high-risk-write",
  query,
  body: deploymentSelector,
  success: { status: 200, body: mutationSchema },
  errors,
});
export const deleteDeploymentOperation = defineHostOperation({
  id: "extension.deployment.delete",
  summary: "Delete extension deployments",
  description: "Remove selected deployments. Deleting a library requires deleteLibrary=true.",
  method: "POST",
  path: "/extensions/deployments/delete",
  risk: "high-risk-write",
  query,
  body: deploymentSelector.extend({ deleteLibrary: z.boolean().optional() }),
  success: { status: 200, body: mutationSchema },
  errors,
});
export const extensionOperationGroup = defineHostOperationGroup({
  id: "extension",
  title: "Skills and extensions",
  description: "Manage optional local runtime extensions.",
  resources: [
    defineHostOperationResource({
      id: "extension",
      title: "Inventory",
      description: "Extension inventory.",
      operations: [listExtensionsOperation] as const,
    }),
    defineHostOperationResource({
      id: "skill",
      title: "Skills",
      description: "Skill library and native deployments.",
      operations: [
        importSkillOperation,
        publishSkillOperation,
        republishSkillOperation,
        unpublishSkillOperation,
      ] as const,
    }),
    defineHostOperationResource({
      id: "deployment",
      title: "Deployments",
      description: "Enable and remove deployed extensions.",
      operations: [enableDeploymentOperation, disableDeploymentOperation, deleteDeploymentOperation] as const,
    }),
  ] as const,
});
