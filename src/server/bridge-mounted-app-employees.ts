import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { JsonObject } from "../core.js";
import { resolveAppManifestPresentation, type AppManifestPresentation } from "../app-builder/manifest-localization.js";
import { isBridgeKernelId, type RoomChannelMember } from "../rooms/channel-store.js";
import {
  OPENGROVE_PM_MEMBER_ID,
  PM_AGENT_SKILL_NAME,
  mountedAppMemberId,
  mountedAppMemberSlug,
  pmAgentMemberId,
} from "../rooms/room-pm.js";
import { LEGACY_NATIVE_MODEL_ID, type BridgeKernelId, type BridgeSettings } from "./bridge-types.js";
import {
  APP_BUILDER_BUSINESS_ROLE_LINES,
  appBuilderEnglishPresentation,
  appBuilderPublicProfile,
} from "./app-builder-employee-contract.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { readMountedAppManifest, resolveMountedAppWorkspaceRoot } from "./mounted-apps.js";
import {
  PRODUCT_DEFAULT_KERNEL_ID,
  PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS,
  productDefaultModelForKernel,
} from "./product-employee-defaults.js";
import { safeResolveInside } from "./workspace-store.js";
import { localizedValue, type SupportedLocale } from "../localization/locale-registry.js";
import { normalizeRequiredKernelCapabilities } from "../kernel/capabilities/requirements.js";
import type { KernelCapabilityId } from "../kernel/capabilities/types.js";

export interface MountedAppEmployeeSummary {
  id: string;
  employeeDefinitionId?: string;
  name: string;
  displayName?: string;
  kernel: string;
  model: string;
  role: string;
  displayRole?: string;
  availableSkillIds?: string[];
  defaultSkillIds?: string[];
  requiredKernelCapabilities?: KernelCapabilityId[];
  appId?: string;
  color?: string;
  accessMode?: RoomChannelMember["accessMode"];
  reasoningEffort?: RoomChannelMember["reasoningEffort"];
  contextTokenBudget?: number;
  sourceLabel?: string;
  visibility?: "private" | "public";
  publicDescription?: string;
  displayPublicDescription?: string;
  publicSkills?: string[];
  displayPublicSkills?: string[];
  inputSpec?: string;
  displayInputSpec?: string;
  outputSpec?: string;
  displayOutputSpec?: string;
}

export function mountedAppDefaultEmployees(settings: BridgeSettings): RoomChannelMember[] {
  const members: RoomChannelMember[] = [];
  for (const mountedApp of settings.mountedApps ?? []) {
    if (mountedApp.enabled === false || !mountedApp.path?.trim()) continue;
    const appRoot = resolvePathLike(mountedApp.path);
    if (!existsSync(appRoot)) continue;
    const manifest = readMountedAppManifest(appRoot).manifest;
    if (!manifest) continue;
    const appId =
      stringOrUndefined(manifest.id) ?? stringOrUndefined(manifest.name) ?? mountedApp.id ?? basename(appRoot);
    const title = stringOrUndefined(manifest.title) ?? mountedApp.title ?? appId;
    const presentation = resolveAppManifestPresentation(manifest, resolveHostLanguageSettings(settings));
    const workspaceRoot = resolveMountedAppWorkspaceRoot(appRoot, manifest, mountedApp.workspacePath);
    members.push(
      ...manifestDefaultEmployees(
        settings,
        appRoot,
        workspaceRoot,
        appId,
        title,
        presentation,
        manifest,
        mountedApp.appBuilderEnabled === true,
      ),
    );
  }
  return dedupeMembers(members);
}

export function mountedAppEmployeeSummaries(settings: BridgeSettings): MountedAppEmployeeSummary[] {
  return mountedAppDefaultEmployees(settings).map((member) => ({
    id: member.id,
    employeeDefinitionId: member.employeeDefinitionId,
    name: member.name,
    displayName: member.displayName,
    kernel: member.kernel,
    model: member.model,
    role: publicEmployeeRole(member.role),
    displayRole: member.displayRole,
    availableSkillIds: member.availableSkillIds?.length ? [...member.availableSkillIds] : undefined,
    defaultSkillIds: member.defaultSkillIds?.length ? [...member.defaultSkillIds] : undefined,
    requiredKernelCapabilities: member.requiredKernelCapabilities?.length
      ? [...member.requiredKernelCapabilities]
      : undefined,
    appId: member.appId,
    color: member.color,
    accessMode: member.accessMode,
    reasoningEffort: member.reasoningEffort,
    contextTokenBudget: member.contextTokenBudget,
    sourceLabel: member.sourceLabel,
    visibility: member.visibility,
    publicDescription: member.publicDescription,
    displayPublicDescription: member.displayPublicDescription,
    publicSkills: member.publicSkills?.length ? [...member.publicSkills] : undefined,
    displayPublicSkills: member.displayPublicSkills?.length ? [...member.displayPublicSkills] : undefined,
    inputSpec: member.inputSpec,
    displayInputSpec: member.displayInputSpec,
    outputSpec: member.outputSpec,
    displayOutputSpec: member.displayOutputSpec,
  }));
}

function manifestDefaultEmployees(
  settings: BridgeSettings,
  appRoot: string,
  workspaceRoot: string,
  appId: string,
  appTitle: string,
  presentation: AppManifestPresentation,
  manifest: JsonObject,
  appBuilderEnabled: boolean,
): RoomChannelMember[] {
  const appAgentContext = collectMountedAppAgentContext(appRoot, workspaceRoot, appId, manifest);
  const employeeInputs = manifestEmployeeInputs(manifest);
  const appBuilderId = appBuilderMemberId(appId);
  const pmId = pmAgentMemberId(appId);
  const appEmployees = employeeInputs
    .map((employee, index) =>
      normalizeManifestEmployee(
        employee,
        index,
        appRoot,
        workspaceRoot,
        appId,
        appTitle,
        presentation,
        appAgentContext,
      ),
    )
    .filter((member): member is RoomChannelMember =>
      Boolean(member && member.id !== appBuilderId && member.id !== pmId),
    );
  // app-builder and pm are reserved Host Employee ids. Manifest entries cannot
  // shadow either generated binding.
  if (appBuilderEnabled) {
    appEmployees.push(
      createAppBuilderMember({
        appId,
        appDisplayTitle: presentation.title || appTitle,
        workspaceRoot: appRoot,
        language: presentation.locale,
      }),
    );
  }
  const disablePmAgent = manifest.disablePmAgent === true || record(manifest.agent).disablePmAgent === true;
  if (!disablePmAgent) {
    appEmployees.push(
      createPmAgentMember({
        appId,
        appTitle,
        appDisplayTitle: presentation.title || appTitle,
        appRoot,
        workspaceRoot,
        appAgentContext,
        appEmployees,
        hasDeclaredEmployees: employeeInputs.length > 0,
        settings,
      }),
    );
  }
  return applyStoreEmployeeDefaults(appEmployees, manifest);
}

function applyStoreEmployeeDefaults(members: RoomChannelMember[], manifest: JsonObject): RoomChannelMember[] {
  const defaults = recordArray(record(record(manifest).store).employeeDefaults);
  if (!defaults.length) return members;
  const byMemberId = new Map(defaults.map((item) => [stringOrUndefined(item.memberId), item]));
  return members.map((member) => {
    // PM is one product Employee with App-scoped runtime bindings. An App
    // package must not fork its avatar/model/permission defaults per App.
    if (member.employeeDefinitionId === OPENGROVE_PM_MEMBER_ID) return member;
    const override = byMemberId.get(member.id);
    if (!override) return member;
    const roleLead = typeof override.role === "string" ? override.role.trim() : undefined;
    const reasoningEffort = normalizeReasoningEffort(override.reasoningEffort);
    const contextTokenBudget = positiveInteger(override.contextTokenBudget);
    const accessMode = normalizeAccessMode(override.accessMode);
    const configuredKernel = stringOrUndefined(override.kernel) ?? member.kernel;
    const configuredModel = stringOrUndefined(override.model);
    const configured: RoomChannelMember = {
      ...member,
      name: stringOrUndefined(override.name) ?? member.name,
      avatarMode: normalizeAvatarMode(override.avatarMode),
      avatarSeed: stringOrUndefined(override.avatarSeed),
      avatarDataUrl: stringOrUndefined(override.avatarDataUrl),
      role: roleLead !== undefined ? replaceEmployeeRoleLead(member.role, roleLead) : member.role,
      kernel: configuredKernel,
      model:
        configuredModel === LEGACY_NATIVE_MODEL_ID
          ? isBridgeKernelId(configuredKernel)
            ? productDefaultModelForKernel(configuredKernel)
            : member.model
          : (configuredModel ?? member.model),
      reasoningEffort,
      contextTokenBudget,
      accessMode,
      color: stringOrUndefined(override.color) ?? member.color,
      availableSkillIds: stringArray(override.availableSkillIds),
      defaultSkillIds: stringArray(override.defaultSkillIds),
      requiredKernelCapabilities: normalizeRequiredKernelCapabilities(override.requiredKernelCapabilities),
      visibility: normalizeVisibility(override.visibility) ?? member.visibility,
      publicDescription: stringOrUndefined(override.publicDescription),
      publicSkills: stringArray(override.publicSkills),
      inputSpec: stringOrUndefined(override.inputSpec),
      outputSpec: stringOrUndefined(override.outputSpec),
    };
    return {
      ...configured,
      manifestDefaults: {
        name: configured.name,
        avatarMode: configured.avatarMode,
        avatarSeed: configured.avatarSeed,
        avatarDataUrl: configured.avatarDataUrl,
        role: publicEmployeeRole(configured.role),
        kernel: configured.kernel,
        model: configured.model,
        color: configured.color,
        availableSkillIds: configured.availableSkillIds,
        defaultSkillIds: configured.defaultSkillIds,
        requiredKernelCapabilities: configured.requiredKernelCapabilities,
        reasoningEffort: configured.reasoningEffort,
        contextTokenBudget: configured.contextTokenBudget,
        accessMode: configured.accessMode,
        visibility: configured.visibility,
        publicDescription: configured.publicDescription,
        publicSkills: configured.publicSkills,
        inputSpec: configured.inputSpec,
        outputSpec: configured.outputSpec,
      },
    };
  });
}

export function replaceEmployeeRoleLead(role: string, replacement: string): string {
  const lines = role.split(/\r?\n/g);
  const leadIndex = lines.findIndex((line) => line.trim());
  if (leadIndex < 0) return replacement;
  lines.splice(leadIndex, 1, ...(replacement ? replacement.split(/\r?\n/g) : []));
  return lines.join("\n").trim();
}

export function providerOnlyUserOverrides(member: RoomChannelMember): RoomChannelMember["userOverrides"] {
  return member.userOverrides?.includes("providerId") ? ["providerId"] : undefined;
}

export function employeeManifestDefaultsPatch(
  member: RoomChannelMember,
  defaults: NonNullable<RoomChannelMember["manifestDefaults"]>,
): Partial<RoomChannelMember> {
  return {
    name: defaults.name ?? member.name,
    avatarMode: defaults.avatarMode,
    avatarSeed: defaults.avatarSeed,
    avatarDataUrl: defaults.avatarDataUrl,
    role: defaults.role === undefined ? member.role : replaceEmployeeRoleLead(member.role, defaults.role),
    kernel: defaults.kernel ?? member.kernel,
    model: defaults.model ?? member.model,
    color: defaults.color ?? member.color,
    availableSkillIds: defaults.availableSkillIds,
    defaultSkillIds: defaults.defaultSkillIds,
    requiredKernelCapabilities: defaults.requiredKernelCapabilities,
    reasoningEffort: defaults.reasoningEffort,
    contextTokenBudget: defaults.contextTokenBudget,
    accessMode: defaults.accessMode,
    visibility: defaults.visibility ?? member.visibility,
    publicDescription: defaults.publicDescription,
    publicSkills: defaults.publicSkills,
    inputSpec: defaults.inputSpec,
    outputSpec: defaults.outputSpec,
    manifestDefaults: { ...defaults },
    userOverrides: providerOnlyUserOverrides(member),
  };
}

function manifestEmployeeInputs(manifest: JsonObject): Record<string, unknown>[] {
  return [
    ...recordArray(record(manifest).employees),
    ...recordArray(record(manifest).agents),
    ...recordArray(record(record(manifest).rooms).employees),
    ...recordArray(record(record(manifest).rooms).agents),
    ...recordArray(record(record(manifest).capabilities).employees),
    ...recordArray(record(record(manifest).capabilities).agents),
    ...recordArray(record(record(manifest).agentPack).employees),
    ...recordArray(record(record(manifest).agentPack).agents),
  ];
}

function normalizeManifestEmployee(
  input: Record<string, unknown>,
  index: number,
  appRoot: string,
  workspaceRoot: string,
  appId: string,
  appTitle: string,
  presentation: AppManifestPresentation,
  appAgentContext: MountedAppAgentContext,
): RoomChannelMember | undefined {
  const employeeId = stringOrUndefined(input.id) ?? stringOrUndefined(input.name) ?? `employee-${index + 1}`;
  const kernel = normalizeEmployeeKernel(input.kernel);
  const employeeWorkspaceRoot = resolveEmployeeWorkspaceRoot(appRoot, workspaceRoot, input);
  const name = stringOrUndefined(input.name) ?? stringOrUndefined(input.title) ?? titleFromSlug(employeeId);
  const manifestEmployeeId = stringOrUndefined(input.id);
  const localized = manifestEmployeeId ? presentation.employees[manifestEmployeeId] : undefined;
  const localizedName = localized?.name;
  const localizedRole = localized?.role;
  const localizedPublicDescription = localized?.publicDescription;
  const localizedPublicSkills = localized?.publicSkills ?? [];
  const localizedInputSpec = localized?.inputSpec;
  const localizedOutputSpec = localized?.outputSpec;
  const displayName = localizedName;
  const description = stringOrUndefined(input.role) ?? stringOrUndefined(input.description);
  const publicDescription = stringOrUndefined(input.publicDescription) ?? stringOrUndefined(input.description);
  const publicSkills = stringArray(input.publicSkills);
  const inputSpec = stringOrUndefined(input.inputSpec);
  const outputSpec = stringOrUndefined(input.outputSpec);
  const role = [
    description,
    ...stringArray(input.instructions),
    appAgentContext.instructions ? `App instructions:\n${appAgentContext.instructions}` : "",
    `App ID: ${appId}`,
    `Workspace scope: ${workspaceScopeLabel(appRoot, employeeWorkspaceRoot)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const declaredDefaultSkillIds = stringArray(input.defaultSkillIds);
  const employeeDefaultSkillIds = qualifyMountedAppSkillIds(
    declaredDefaultSkillIds,
    appId,
    appAgentContext.appSkillNames,
  );
  const defaultSkillIds = employeeDefaultSkillIds.length
    ? uniqueStrings(employeeDefaultSkillIds)
    : appAgentContext.defaultSkillIds;
  const declaredAvailableSkillIds = qualifyMountedAppSkillIds(
    stringArray(input.availableSkillIds),
    appId,
    appAgentContext.appSkillNames,
  );
  const availableSkillIds = uniqueStrings([
    ...(declaredAvailableSkillIds.length ? declaredAvailableSkillIds : appAgentContext.availableSkillIds),
    ...defaultSkillIds,
  ]);
  return {
    id: mountedAppMemberId(appId, employeeId),
    name,
    ...(displayName ? { displayName } : {}),
    kernel,
    model: declaredEmployeeModel(input.model, kernel),
    avatarMode: normalizeAvatarMode(input.avatarMode),
    avatarSeed: stringOrUndefined(input.avatarSeed),
    avatarDataUrl: stringOrUndefined(input.avatarDataUrl),
    role,
    ...(localizedRole ? { displayRole: localizedRole } : {}),
    status: "idle",
    color: stringOrUndefined(input.color) ?? defaultEmployeeColor(index),
    lastActive: stringOrUndefined(input.lastActive) ?? "已配置",
    availableSkillIds,
    defaultSkillIds,
    requiredKernelCapabilities: normalizeRequiredKernelCapabilities(input.requiredKernelCapabilities),
    appId,
    workspaceRoot: employeeWorkspaceRoot,
    accessMode: normalizeAccessMode(input.accessMode),
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort) ?? defaultEmployeeReasoningEffort(),
    contextTokenBudget: positiveInteger(input.contextTokenBudget),
    source: "local",
    sourceLabel: `${presentation.title || appTitle} App`,
    visibility: normalizeVisibility(input.visibility),
    publicDescription,
    ...(localizedPublicDescription ? { displayPublicDescription: localizedPublicDescription } : {}),
    publicSkills,
    ...(localizedPublicSkills.length ? { displayPublicSkills: localizedPublicSkills } : {}),
    inputSpec,
    ...(localizedInputSpec ? { displayInputSpec: localizedInputSpec } : {}),
    outputSpec,
    ...(localizedOutputSpec ? { displayOutputSpec: localizedOutputSpec } : {}),
  };
}

function normalizeAvatarMode(value: unknown): RoomChannelMember["avatarMode"] {
  return value === "generated" || value === "initials" || value === "upload" ? value : undefined;
}

interface MountedAppAgentContext {
  instructions: string;
  availableSkillIds: string[];
  defaultSkillIds: string[];
  appSkillNames: string[];
}

export const OPENGROVE_APP_BUILDER_SKILL_NAME = "opengrove-app-builder";
export const OPENGROVE_APP_WORKSPACE_GUARD_SKILL_NAME = "opengrove-developer-mode-guard";
export const OPENGROVE_APP_BUILDER_MEMBER_ID = "app-builder";

export function appBuilderMemberId(appId: string): string {
  return mountedAppMemberId(appId, OPENGROVE_APP_BUILDER_MEMBER_ID);
}

const APP_BUILDER_PRESENTATION: Record<SupportedLocale, (appTitle: string) => Partial<RoomChannelMember>> = {
  "zh-CN": () => ({}),
  en: (appTitle: string) =>
    appBuilderEnglishPresentation(
      `Helps business users change ${appTitle}, verifies what its current capabilities support, continues deliverable work when backend data is missing, and prepares a backend handoff.`,
    ),
};

const PM_PRESENTATION: Record<SupportedLocale, (appTitle: string) => Partial<RoomChannelMember>> = {
  "zh-CN": () => ({}),
  en: (appTitle: string) => ({
    displayRole: `Understands goals, coordinates employees in ${appTitle}, and creates workflows when explicitly requested.`,
    displayPublicDescription: `Coordinates employees and workflows for ${appTitle}.`,
    displayPublicSkills: ["Task planning", "Employee coordination", "Workflow orchestration"],
    displayInputSpec: `A goal or coordination request within ${appTitle}.`,
    displayOutputSpec: "A clear execution plan, employee assignments, or a runnable workflow.",
  }),
};

function createAppBuilderMember(input: {
  appId: string;
  appDisplayTitle: string;
  workspaceRoot: string;
  language: SupportedLocale;
}): RoomChannelMember {
  const skillIds = [OPENGROVE_APP_BUILDER_SKILL_NAME, OPENGROVE_APP_WORKSPACE_GUARD_SKILL_NAME];
  const runtime = PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS[OPENGROVE_APP_BUILDER_MEMBER_ID];
  return {
    id: appBuilderMemberId(input.appId),
    employeeDefinitionId: OPENGROVE_APP_BUILDER_MEMBER_ID,
    name: "App 构建师",
    ...localizedValue(APP_BUILDER_PRESENTATION, input.language)(input.appDisplayTitle),
    kernel: runtime.kernel,
    model: runtime.model,
    role: [
      `你是 appId="${input.appId}" 的 OpenGrove App 构建师。`,
      ...APP_BUILDER_BUSINESS_ROLE_LINES,
      "负责创建、导入、调整和验证这个 OpenGrove App。",
      "业务专属 UI 留在 App 包内；需要保留文件工作台时，使用 file-workbench 的 App-owned MCP View Tab。",
      `App workspace: ${input.workspaceRoot}`,
    ].join("\n"),
    status: "idle",
    color: "#7c3aed",
    lastActive: "已配置",
    availableSkillIds: skillIds,
    defaultSkillIds: skillIds,
    appId: input.appId,
    workspaceRoot: input.workspaceRoot,
    accessMode: "default",
    reasoningEffort: defaultEmployeeReasoningEffort(),
    source: "local",
    sourceLabel: `${input.appDisplayTitle} App`,
    visibility: "private",
    ...appBuilderPublicProfile(),
  };
}

// ===== PM 规划 agent(P3):全局员工定义 + 每 App 轻量运行绑定 =====
export { OPENGROVE_PM_MEMBER_ID, PM_AGENT_SKILL_NAME, mountedAppMemberId, mountedAppMemberSlug, pmAgentMemberId };
/**
 * 构造某 App 的 PM 运行绑定。全局 PM 员工持有头像、模型、思考等级和权限；
 * 这里保留稳定的 App 作用域 id、role、workspace 与员工名单，避免打断旧群聊
 * 和历史记录。
 */
function createPmAgentMember(input: {
  appId: string;
  appTitle: string;
  appDisplayTitle: string;
  appRoot: string;
  workspaceRoot: string;
  appAgentContext: MountedAppAgentContext;
  appEmployees: RoomChannelMember[];
  hasDeclaredEmployees: boolean;
  settings: BridgeSettings;
}): RoomChannelMember {
  const {
    appId,
    appTitle,
    appDisplayTitle,
    appRoot,
    workspaceRoot,
    appAgentContext,
    appEmployees,
    hasDeclaredEmployees,
    settings,
  } = input;
  const { kernel, model } = PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS[OPENGROVE_PM_MEMBER_ID];
  const pmId = pmAgentMemberId(appId);
  const employeeRoster = appEmployees
    .filter((member) => member.id !== pmId)
    .map((member) => `- ${member.id}: ${publicEmployeeRole(member.role).slice(0, 120)}`)
    .join("\n");
  const availableSkillIds = hasDeclaredEmployees
    ? [PM_AGENT_SKILL_NAME]
    : uniqueStrings([PM_AGENT_SKILL_NAME, ...appAgentContext.availableSkillIds]);
  const defaultSkillIds = hasDeclaredEmployees
    ? [PM_AGENT_SKILL_NAME]
    : uniqueStrings([PM_AGENT_SKILL_NAME, ...appAgentContext.defaultSkillIds]);
  const role = [
    `你是 appId="${appId}" 的 OpenGrove App PM Agent。`,
    "只有用户直接要求你规划或编排工作流时，才执行下面的工作流职责。",
    "把用户目标拆成有顺序、可执行的步骤；员工步骤用 memberId，Host 工具步骤用 toolId。",
    `调用 workflow.create，并使用 appId="${appId}" 生成 .routine.md；只编排属于本 App 的员工。`,
    "如果步骤要读取特定房间账本，在 step.input 或 step.roomId 中写 roomId。本 App 默认群聊可由 workflow.create 根据 appId 推断，不要向用户索要内部 roomId。",
    "workflow.create 成功后，用当前内核原生的用户提问工具询问是否立即运行，答案会回到同一轮；只有用户确认后，才用返回的 knowledgeId 调用 workflow.activate。内核没有原生提问工具时，改用普通文字询问并等待下一轮。",
    "workflow.create 失败、被拒或超时时，本轮不要重复调用；如实报告并询问用户是否重试。",
    "广告创建、预算扩量、短剧运营执行等高风险动作之前，必须单独插入带 flowApproval 的审批步骤；引擎审批不能替代这道业务安全门。",
    employeeRoster
      ? "有合适的 App 员工时，优先把实际业务工作交给员工；PM 负责理解目标、协调和必要的工作流编排。"
      : "当前没有可委派员工。如果任务在当前 App 范围内、风险可控且你具备所需能力，就自己完成；否则说明缺少的职责或能力，提示用户新增员工。",
    "",
    `appId="${appId}" 中可编排的员工：`,
    employeeRoster || "（暂无；请先向用户确认由哪些 App 员工参与）",
    "",
    appAgentContext.instructions ? `App 指令：\n${appAgentContext.instructions}` : "",
    `App 根目录：${appRoot}`,
    `App 工作区：${workspaceRoot}`,
  ].join("\n");
  return {
    id: pmId,
    employeeDefinitionId: OPENGROVE_PM_MEMBER_ID,
    name: `${appTitle} PM`,
    ...(appDisplayTitle !== appTitle ? { displayName: `${appDisplayTitle} PM` } : {}),
    ...localizedValue(PM_PRESENTATION, resolveHostLanguageSettings(settings))(appDisplayTitle),
    kernel,
    model,
    role,
    status: "idle",
    color: "#1d4ed8",
    lastActive: "已配置",
    availableSkillIds,
    defaultSkillIds,
    appId,
    workspaceRoot,
    reasoningEffort: defaultEmployeeReasoningEffort(),
    source: "local",
    sourceLabel: `${appDisplayTitle} App`,
    visibility: "private",
  };
}

function collectMountedAppAgentContext(
  appRoot: string,
  workspaceRoot: string,
  appId: string,
  manifest: JsonObject,
): MountedAppAgentContext {
  const ui = record(record(manifest).ui);
  const agent = record(record(manifest).agent);
  const instructionBlocks = [
    ...stringArray(ui.agentContext),
    ...stringArray(agent.instructions),
    ...readMountedAppAgentsFiles(appRoot, workspaceRoot),
  ];
  const appSkillNames = collectMountedAppSkillNames(appRoot, manifest);
  return {
    instructions: instructionBlocks.join("\n\n"),
    availableSkillIds: qualifyMountedAppSkillIds(
      collectMountedAppAvailableSkillIds(appRoot, manifest),
      appId,
      appSkillNames,
    ),
    defaultSkillIds: qualifyMountedAppSkillIds(
      collectMountedAppDefaultSkillIds(appRoot, manifest),
      appId,
      appSkillNames,
    ),
    appSkillNames,
  };
}

function qualifyMountedAppSkillIds(values: string[], appId: string, appSkillNames: string[]): string[] {
  const localNames = new Set(appSkillNames);
  return uniqueStrings(values.map((value) => (localNames.has(value) ? `app:${appId}/${value}` : value)));
}

function readMountedAppAgentsFiles(appRoot: string, workspaceRoot: string): string[] {
  const candidates = uniqueStrings([
    join(appRoot, "AGENTS.md"),
    join(appRoot, "agents.md"),
    join(appRoot, "Agents.md"),
    join(workspaceRoot, "AGENTS.md"),
    join(workspaceRoot, "agents.md"),
    join(workspaceRoot, "Agents.md"),
  ]);
  const blocks: string[] = [];
  const seenFileKeys = new Set<string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const fileKey = mountedAppAgentsFileKey(path);
    if (seenFileKeys.has(fileKey)) continue;
    seenFileKeys.add(fileKey);
    const text = readFileSync(path, "utf8").trim();
    if (text)
      blocks.push(`From ${displayInstructionPath(appRoot, workspaceRoot, path)}:\n${truncateInstructionText(text)}`);
  }
  return blocks;
}

function mountedAppAgentsFileKey(path: string): string {
  try {
    const stat = statSync(path);
    return `inode:${stat.dev}:${stat.ino}`;
  } catch {
    try {
      return `realpath:${realpathSync.native(path)}`;
    } catch {
      return `path:${path}`;
    }
  }
}

function resolveEmployeeWorkspaceRoot(
  appRoot: string,
  defaultWorkspaceRoot: string,
  input: Record<string, unknown>,
): string {
  const workspace = input.workspace;
  const workspacePath =
    stringOrUndefined(input.workspaceRoot) ?? stringOrUndefined(workspace) ?? stringOrUndefined(record(workspace).path);
  if (!workspacePath) return defaultWorkspaceRoot;
  return safeResolveInside(appRoot, workspacePath) ?? defaultWorkspaceRoot;
}

function workspaceScopeLabel(appRoot: string, workspaceRoot: string): string {
  if (workspaceRoot === appRoot) return "app root";
  const rel = relative(appRoot, workspaceRoot).split(sep).join("/");
  return rel && !rel.startsWith("..") ? rel : "declared workspace";
}

function displayInstructionPath(appRoot: string, workspaceRoot: string, path: string): string {
  const appRelative = relative(appRoot, path).split(sep).join("/");
  if (appRelative && !appRelative.startsWith("..")) return `app/${appRelative}`;
  const workspaceRelative = relative(workspaceRoot, path).split(sep).join("/");
  if (workspaceRelative && !workspaceRelative.startsWith("..")) return `workspace/${workspaceRelative}`;
  return basename(path);
}

export function publicEmployeeRole(role: string): string {
  const lines = role.split(/\r?\n/g);
  const hasInternalBlock = lines.some((line) => isInternalEmployeeRoleLine(line, { includeAppLine: false }));
  const firstInternalIndex = lines.findIndex((line) =>
    isInternalEmployeeRoleLine(line, { includeAppLine: hasInternalBlock }),
  );
  if (firstInternalIndex >= 0) {
    return publicRoleLeadBlock(lines.slice(0, firstInternalIndex));
  }
  return lines
    .filter((line) => !isInternalEmployeeRoleLine(line, { includeAppLine: false }))
    .join("\n")
    .trim();
}

function publicRoleLeadBlock(lines: string[]): string {
  return lines.map((line) => line.trim()).find(Boolean) ?? "";
}

function isInternalEmployeeRoleLine(line: string, options: { includeAppLine: boolean }): boolean {
  const trimmed = line.trim();
  // Keep recognizing legacy `App:` lines when a preceding internal block proves
  // they came from an older persisted role. Current generated roles use `App ID:`
  // and can always be filtered without hiding an ordinary user-authored `App:` line.
  return (
    /^App instructions:/i.test(trimmed) ||
    /^App 指令[：:]/i.test(trimmed) ||
    (options.includeAppLine && /^App:/i.test(trimmed)) ||
    /^App ID:/i.test(trimmed) ||
    /^Workspace scope:/i.test(trimmed) ||
    /^App root:/i.test(trimmed) ||
    /^App workspace:/i.test(trimmed) ||
    /^App 根目录[：:]/i.test(trimmed) ||
    /^App 工作区[：:]/i.test(trimmed)
  );
}

function truncateInstructionText(text: string): string {
  const limit = 12_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[truncated to ${limit} characters]`;
}

function collectMountedAppDefaultSkillIds(_appRoot: string, manifest: JsonObject): string[] {
  const skills = record(record(manifest).skills);
  const agent = record(record(manifest).agent);
  return uniqueStrings([
    ...stringArray(record(manifest).defaultSkillIds),
    ...stringArray(skills.defaultSkillIds),
    ...stringArray(skills.default),
    ...stringArray(agent.defaultSkillIds),
  ]);
}

function collectMountedAppAvailableSkillIds(appRoot: string, manifest: JsonObject): string[] {
  const skills = record(record(manifest).skills);
  const capabilities = record(record(manifest).capabilities);
  const agent = record(record(manifest).agent);
  return uniqueStrings([
    ...stringArray(record(manifest).availableSkillIds),
    ...stringArray(record(manifest).skillIds),
    ...stringArray(skills.availableSkillIds),
    ...stringArray(skills.ids),
    ...stringArray(capabilities.skills),
    ...stringArray(agent.availableSkillIds),
    ...stringArray(agent.skills),
    ...collectMountedAppDefaultSkillIds(appRoot, manifest),
    ...collectMountedAppSkillNames(appRoot, manifest),
  ]);
}

function collectMountedAppSkillNames(appRoot: string, manifest: JsonObject): string[] {
  const skills = record(record(manifest).skills);
  const capabilities = record(record(manifest).capabilities);
  const declaredRoots = [
    ...stringArray(skills.roots),
    ...stringArray(capabilities.skillRoots),
    ...stringArray(record(manifest).skillRoots),
  ];
  const roots = declaredRoots.length ? declaredRoots.map((root) => resolve(appRoot, root)) : [join(appRoot, "skills")];
  const names: string[] = [];
  for (const root of roots) {
    names.push(...collectSkillNamesFromRoot(root));
  }
  return uniqueStrings(names);
}

export function mountedAppSkillNames(appRoot: string, manifest: JsonObject): string[] {
  return collectMountedAppSkillNames(appRoot, manifest);
}

function collectSkillNamesFromRoot(root: string): string[] {
  if (!existsSync(root)) return [];
  const directSkillPath = join(root, "SKILL.md");
  if (existsSync(directSkillPath)) {
    return [readSkillManifestName(directSkillPath) ?? basename(root)];
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(root, entry.name, "SKILL.md");
    if (existsSync(skillPath)) names.push(readSkillManifestName(skillPath) ?? entry.name);
  }
  return uniqueStrings(names);
}

function readSkillManifestName(skillPath: string): string | undefined {
  try {
    const header = readFileSync(skillPath, "utf8").slice(0, 2_000);
    const match = header.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function declaredEmployeeModel(value: unknown, kernel: BridgeKernelId): string {
  const model = stringOrUndefined(value);
  return model && model !== LEGACY_NATIVE_MODEL_ID ? model : productDefaultModelForKernel(kernel);
}

function normalizeEmployeeKernel(value: unknown): BridgeKernelId {
  const kernel = stringOrUndefined(value);
  return kernel && isBridgeKernelId(kernel) ? kernel : PRODUCT_DEFAULT_KERNEL_ID;
}

function defaultEmployeeReasoningEffort(): RoomChannelMember["reasoningEffort"] {
  return "medium";
}

function defaultEmployeeColor(index: number): string {
  const colors = ["#2563eb", "#0f766e", "#7c3aed", "#be123c", "#b45309", "#047857"];
  return colors[index % colors.length] ?? "#2563eb";
}

function titleFromSlug(value: string): string {
  return (
    value
      .split(/[-_.]+/g)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ") || "App Employee"
  );
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => record(item)).filter((item) => Object.keys(item).length > 0) : [];
}

function dedupeMembers(members: RoomChannelMember[]): RoomChannelMember[] {
  const seen = new Set<string>();
  const output: RoomChannelMember[] = [];
  for (const member of members) {
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    output.push(member);
  }
  return output;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((item) => String(item || "").trim()).filter(Boolean));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(process.env.HOME || "");
  if (path.startsWith("~/")) return resolve(process.env.HOME || "", path.slice(2));
  return resolve(path);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeVisibility(value: unknown): "private" | "public" | undefined {
  return value === "public" || value === "private" ? value : undefined;
}

function normalizeAccessMode(value: unknown): RoomChannelMember["accessMode"] {
  return value === "default" || value === "auto-review" || value === "full-access" ? value : undefined;
}

function normalizeReasoningEffort(value: unknown): RoomChannelMember["reasoningEffort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
