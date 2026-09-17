import { hostSchemaRegistry } from "./schema-registry.js";
import { z } from "zod";
import { STANDARD_KERNEL_CAPABILITY_IDS } from "./kernel-capability-ids.js";
import { remoteAgentBindingSchema } from "./remote-agent.js";

const memberRuntimeFields = {
  name: z.string(),
  role: z.string(),
  kernel: z.string(),
  model: z.string(),
  color: z.string(),
  availableSkillIds: z.array(z.string()).optional(),
  defaultSkillIds: z.array(z.string()).optional(),
  requiredKernelCapabilities: z.array(z.enum(STANDARD_KERNEL_CAPABILITY_IDS)).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  contextTokenBudget: z.number().optional(),
  accessMode: z.enum(["default", "auto-review", "full-access"]).optional(),
  avatarMode: z.enum(["generated", "initials", "upload"]).optional(),
  avatarSeed: z.string().optional(),
  avatarDataUrl: z.string().optional(),
  visibility: z.enum(["private", "public"]).optional(),
  publicDescription: z.string().optional(),
  publicSkills: z.array(z.string()).optional(),
  inputSpec: z.string().optional(),
  outputSpec: z.string().optional(),
};

export const roomMemberSchema = z
  .object({
    ...memberRuntimeFields,
    id: z.string(),
    employeeDefinitionId: z.string().optional(),
    displayName: z.string().optional(),
    providerId: z.string().optional(),
    displayRole: z.string().optional(),
    status: z.enum(["idle", "running", "done", "waiting", "offline"]),
    lastActive: z.string(),
    appId: z.string().optional(),
    workspaceRoot: z.string().optional(),
    storePackageId: z.string().optional(),
    toolIds: z.array(z.string()).optional(),
    source: z.enum(["local", "human", "remote"]).optional(),
    remoteAgent: remoteAgentBindingSchema.optional(),
    sourceLabel: z.string().optional(),
    displayPublicDescription: z.string().optional(),
    displayPublicSkills: z.array(z.string()).optional(),
    displayInputSpec: z.string().optional(),
    displayOutputSpec: z.string().optional(),
    userOverrides: z.array(z.string()).optional(),
    manifestDefaults: z.object(memberRuntimeFields).partial().optional(),
    disabled: z.boolean().optional(),
  })
  .register(hostSchemaRegistry, { id: "Employee" });

// Writable Employee metadata excludes server-owned defaults and remote bindings.
export const roomMemberInputSchema = roomMemberSchema
  .omit({
    remoteAgent: true,
    userOverrides: true,
    manifestDefaults: true,
    displayName: true,
    displayRole: true,
    displayPublicDescription: true,
    displayPublicSkills: true,
    displayInputSpec: true,
    displayOutputSpec: true,
    requiredKernelCapabilities: true,
  })
  .partial()
  .extend({
    id: z.string().trim().min(1),
    source: z.enum(["local", "human"]).optional(),
  })
  .register(hostSchemaRegistry, { id: "EmployeeWrite" });

// Explicit null clears a preference; an omitted field leaves it unchanged.
const memberInput = roomMemberInputSchema.shape;
export const roomMemberPatchSchema = z.object({
  name: memberInput.name.nullable(),
  kernel: memberInput.kernel.nullable(),
  model: memberInput.model.nullable(),
  providerId: memberInput.providerId.nullable(),
  role: memberInput.role.nullable(),
  status: memberInput.status.nullable(),
  color: memberInput.color.nullable(),
  lastActive: memberInput.lastActive.nullable(),
  availableSkillIds: memberInput.availableSkillIds.nullable(),
  defaultSkillIds: memberInput.defaultSkillIds.nullable(),
  appId: memberInput.appId.nullable(),
  workspaceRoot: memberInput.workspaceRoot.nullable(),
  storePackageId: memberInput.storePackageId.nullable(),
  toolIds: memberInput.toolIds.nullable(),
  accessMode: memberInput.accessMode.nullable(),
  reasoningEffort: memberInput.reasoningEffort.nullable(),
  contextTokenBudget: memberInput.contextTokenBudget.nullable(),
  avatarMode: memberInput.avatarMode.nullable(),
  avatarSeed: memberInput.avatarSeed.nullable(),
  avatarDataUrl: memberInput.avatarDataUrl.nullable(),
  source: memberInput.source.nullable(),
  sourceLabel: memberInput.sourceLabel.nullable(),
  visibility: memberInput.visibility.nullable(),
  publicDescription: memberInput.publicDescription.nullable(),
  publicSkills: memberInput.publicSkills.nullable(),
  inputSpec: memberInput.inputSpec.nullable(),
  outputSpec: memberInput.outputSpec.nullable(),
  disabled: memberInput.disabled.nullable(),
});
