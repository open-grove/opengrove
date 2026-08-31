import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  ROOM_MEMBER_AVATAR_DATA_URL_MAX_LENGTH,
  ROOM_MEMBER_AVATAR_DATA_URL_PATTERN,
  isSupportedRoomMemberAvatarDataUrl,
} from "../rooms/avatar-data-url.js";
import { isSafeAppCliTargetPath } from "./cli-targets.js";
import { normalizeMcpAppView } from "./ui-runtime.js";
import { legacyAppUiKind, normalizeCompatibleAppUi, retiredWebAppUiIssue } from "./compat/legacy-app-ui.compat.js";
import { isRetiredKnowledgeVaultPackage } from "../retired-app-identity.js";

const cliTargetPathSchema = z
  .string()
  .min(1)
  .refine(isSafeAppCliTargetPath, "target must be a relative path contained by the App root");

const cliDeclarationSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      command: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      bin: z.string().min(1).optional(),
      targets: z
        .object({
          "darwin-arm64": cliTargetPathSchema.optional(),
          "darwin-x64": cliTargetPathSchema.optional(),
          "win32-arm64": cliTargetPathSchema.optional(),
          "win32-x64": cliTargetPathSchema.optional(),
          "linux-arm64": cliTargetPathSchema.optional(),
          "linux-x64": cliTargetPathSchema.optional(),
        })
        .strict()
        .refine((targets) => Object.keys(targets).length > 0, "targets cannot be empty")
        .optional(),
      args: z.array(z.string()).optional(),
      doctor: z.union([z.string(), z.array(z.string())]).optional(),
      smoke: z.union([z.string(), z.array(z.string())]).optional(),
      env: z.array(z.string()).optional(),
      envKeys: z.array(z.string()).optional(),
      artifacts: z.array(z.string()).optional(),
      outputs: z.array(z.string()).optional(),
      allowNativeBash: z.boolean().optional(),
    })
    .passthrough(),
]);

const providerEnvSchema = z
  .object({
    providerId: z.string().min(1),
    env: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    required: z.boolean().optional(),
  })
  .passthrough();

const runtimeRequirementSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      version: z.string().optional(),
      manager: z.string().optional(),
      requirements: z.array(z.string()).optional(),
      packageFiles: z.array(z.string()).optional(),
      binEnv: z.string().optional(),
    })
    .passthrough(),
]);

const appStoreEmployeeDefaultsSchema = z
  .object({
    memberId: z.string().min(1).max(240),
    name: z.string().min(1).max(120),
    avatarMode: z.enum(["generated", "initials", "upload"]).optional(),
    avatarSeed: z.string().max(512).optional(),
    avatarDataUrl: z
      .string()
      .max(ROOM_MEMBER_AVATAR_DATA_URL_MAX_LENGTH)
      .regex(ROOM_MEMBER_AVATAR_DATA_URL_PATTERN)
      .refine(isSupportedRoomMemberAvatarDataUrl)
      .optional(),
    role: z.string().max(40_000).optional(),
    kernel: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    contextTokenBudget: z.number().int().positive().optional(),
    accessMode: z.enum(["default", "auto-review", "full-access"]).optional(),
    color: z.string().max(64).optional(),
    availableSkillIds: z.array(z.string().min(1).max(240)).max(256).optional(),
    defaultSkillIds: z.array(z.string().min(1).max(240)).max(256).optional(),
    visibility: z.enum(["private", "public"]).optional(),
    publicDescription: z.string().max(4_000).optional(),
    publicSkills: z.array(z.string().min(1).max(240)).max(256).optional(),
    inputSpec: z.string().max(8_000).optional(),
    outputSpec: z.string().max(8_000).optional(),
  })
  .passthrough();

export function validateAppStoreEmployeeDefaults(value: unknown): string[] {
  const result = z
    .array(appStoreEmployeeDefaultsSchema)
    .max(256)
    .safeParse(value ?? []);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".") || "employeeDefaults"}: ${issue.message}`);
}

const appStoreManifestSchema = z
  .object({
    packageKey: z.string().min(1).optional(),
    minHostReleaseNumber: z.number().int().positive().optional(),
    visibility: z.enum(["public", "restricted"]).optional(),
    packExclude: z.array(z.string()).optional(),
    releaseNotes: z.string().optional(),
    employeeDefaults: z.array(appStoreEmployeeDefaultsSchema).max(256).optional(),
    requirements: z
      .object({
        env: z.array(z.string()).optional(),
        system: z.array(z.string()).optional(),
        runtimes: z.array(runtimeRequirementSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const assetDeclarationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    kind: z.enum(["directory", "file"]).optional(),
    required: z.boolean().optional(),
    accept: z.array(z.string()).optional(),
    mountEnv: z.string().optional(),
    preferredMountPath: z.string().optional(),
    validation: z
      .object({
        minFiles: z.number().int().nonnegative().optional(),
        glob: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const mcpAppCspSchema = z
  .object({
    connectDomains: z.array(z.string().min(1)).optional(),
    resourceDomains: z.array(z.string().min(1)).optional(),
    frameDomains: z.array(z.string().min(1)).optional(),
    baseUriDomains: z.array(z.string().min(1)).optional(),
  })
  .strict();

const mcpAppPermissionsSchema = z
  .object({
    camera: z.object({}).strict().optional(),
    microphone: z.object({}).strict().optional(),
    geolocation: z.object({}).strict().optional(),
    clipboardWrite: z.object({}).strict().optional(),
  })
  .strict();

const mcpAppViewSchema = z
  .object({
    protocol: z.literal("mcp-app"),
    entry: z.string().optional(),
    tools: z.array(z.string().min(1)).optional(),
    csp: mcpAppCspSchema.optional(),
    permissions: mcpAppPermissionsSchema.optional(),
  })
  .passthrough();

const uiTabSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/i, "id must be URL-safe")
      .optional(),
    component: z.string().min(1),
    label: z.string().min(1).optional(),
    source: z
      .object({
        type: z.string().min(1).optional(),
        endpoint: z.string().min(1).optional(),
        refreshEndpoint: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    view: mcpAppViewSchema.optional(),
  })
  .passthrough();

const localizedUiTabSchema = z
  .object({
    label: z.string().min(1),
  })
  .strict();

const workbenchLayoutSchema = z
  .object({
    filesWidth: z.number().finite().positive().optional(),
    chatWidth: z.number().finite().positive().optional(),
  })
  .strict();

const localizedEmployeeSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    publicDescription: z.string().min(1).optional(),
    publicSkills: z.array(z.string().min(1)).optional(),
    inputSpec: z.string().min(1).optional(),
    outputSpec: z.string().min(1).optional(),
  })
  .strict();

const localizedCliSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

const manifestWelcomeSchema = z
  .object({
    message: z.string().min(1),
  })
  .strict();

const localizedManifestSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    ui: z
      .object({
        tabs: z.record(z.string().min(1), localizedUiTabSchema).optional(),
      })
      .strict()
      .optional(),
    employees: z.record(z.string().min(1), localizedEmployeeSchema).optional(),
    capabilities: z
      .object({
        cli: z.record(z.string().min(1), localizedCliSchema).optional(),
      })
      .strict()
      .optional(),
    welcome: manifestWelcomeSchema.optional(),
  })
  .strict();

export const employeeDeclarationSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/, "id must be lowercase and URL-safe")
      .optional(),
    name: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    avatarMode: z.enum(["generated", "initials", "upload"]).optional(),
    avatarSeed: z.string().max(512).optional(),
    avatarDataUrl: z
      .string()
      .max(ROOM_MEMBER_AVATAR_DATA_URL_MAX_LENGTH)
      .regex(ROOM_MEMBER_AVATAR_DATA_URL_PATTERN)
      .refine(isSupportedRoomMemberAvatarDataUrl)
      .optional(),
    role: z.string().optional(),
    description: z.string().optional(),
    instructions: z.union([z.string(), z.array(z.string())]).optional(),
    kernel: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    contextTokenBudget: z.number().int().positive().optional(),
    defaultSkillIds: z.array(z.string()).optional(),
    availableSkillIds: z.array(z.string()).optional(),
    color: z.string().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    publicDescription: z.string().optional(),
    publicSkills: z.array(z.string()).optional(),
    inputSpec: z.string().optional(),
    outputSpec: z.string().optional(),
    workspace: z.union([z.string().min(1), z.object({ path: z.string().min(1).optional() }).passthrough()]).optional(),
    workspaceRoot: z.string().min(1).optional(),
  })
  .passthrough();

const employeePackToolSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    source: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const employeePackSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    source: z.string().optional(),
    bundled: z.boolean().optional(),
    path: z.string().optional(),
    toolIds: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
  })
  .passthrough();

const employeePackDependencySchema = z
  .object({
    kernels: z.array(z.string()).optional(),
    providers: z.array(z.string()).optional(),
    runtimes: z.array(z.string()).optional(),
    skills: z.array(employeePackSkillSchema).optional(),
    tools: z.array(employeePackToolSchema).optional(),
    cli: z.array(cliDeclarationSchema).optional(),
    mcp: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const opengroveAppManifestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/, "id must be lowercase and URL-safe"),
    name: z.string().min(1).optional(),
    title: z.string().min(1),
    icon: z.string().min(1).optional(),
    description: z.string().optional(),
    defaultLocale: z.string().min(1).optional(),
    locales: z.record(z.string().min(1), localizedManifestSchema).optional(),
    welcome: manifestWelcomeSchema.optional(),
    version: z.string().min(1).optional(),
    ui: z
      .object({
        surface: z.enum(["setup", "file-workbench", "view", "none"]).optional(),
        view: mcpAppViewSchema.optional(),
        kind: z.enum(["file-workbench", "mcp-app", "web-app", "web", "native", "custom"]).optional(),
        entry: z.string().optional(),
        workspace: z.string().optional(),
        workbenchLayout: workbenchLayoutSchema.optional(),
        devCommand: z.union([z.string(), z.array(z.string())]).optional(),
        tabs: z.array(uiTabSchema).optional(),
        tools: z.array(z.string().min(1)).optional(),
        csp: mcpAppCspSchema.optional(),
        permissions: mcpAppPermissionsSchema.optional(),
      })
      .passthrough()
      .optional(),
    workspace: z
      .object({
        path: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    skills: z
      .object({
        roots: z.array(z.string()).optional(),
        default: z.array(z.string()).optional(),
        defaultSkillIds: z.array(z.string()).optional(),
        availableSkillIds: z.array(z.string()).optional(),
        ids: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    employees: z.array(employeeDeclarationSchema).optional(),
    agents: z.array(employeeDeclarationSchema).optional(),
    rooms: z
      .object({
        employees: z.array(employeeDeclarationSchema).optional(),
        agents: z.array(employeeDeclarationSchema).optional(),
      })
      .passthrough()
      .optional(),
    capabilities: z
      .object({
        cli: z.array(cliDeclarationSchema).optional(),
        skillRoots: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
        employees: z.array(employeeDeclarationSchema).optional(),
        agents: z.array(employeeDeclarationSchema).optional(),
        mcp: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    runtimeEnv: z
      .object({
        providerKeys: z.array(providerEnvSchema).optional(),
      })
      .passthrough()
      .optional(),
    assets: z.array(assetDeclarationSchema).optional(),
    store: appStoreManifestSchema.optional(),
    agent: employeeDeclarationSchema.optional(),
    agentPack: z
      .object({
        employees: z.array(employeeDeclarationSchema).optional(),
        agents: z.array(employeeDeclarationSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type OpenGroveAppManifest = z.infer<typeof opengroveAppManifestSchema>;

export const MCP_APP_BRIDGE_TOOL_IDS = [
  "opengrove.app.workspace.list",
  "opengrove.app.workspace.read",
  "opengrove.app.workspace.write",
  "opengrove.app.media.cache",
  "opengrove.app.flows.list",
  "opengrove.app.command.run",
] as const;

export const employeePackManifestSchema = z
  .object({
    publishKind: z.literal("employee"),
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/i, "id must be URL-safe"),
    title: z.string().min(1),
    summary: z.string().optional(),
    description: z.string().optional(),
    version: z.string().min(1).optional(),
    publisher: z.string().optional(),
    employee: employeeDeclarationSchema
      .extend({
        id: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][a-z0-9._:-]*$/, "id must be lowercase and URL-safe"),
        name: z.string().min(1),
      })
      .passthrough(),
    dependencies: employeePackDependencySchema.optional(),
    store: z
      .object({
        category: z.string().optional(),
        requirements: z.array(z.string()).optional(),
        capabilities: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type EmployeePackManifest = z.infer<typeof employeePackManifestSchema>;

export interface AppManifestValidationResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
  manifest?: OpenGroveAppManifest;
}

export interface EmployeePackManifestValidationResult {
  ok: boolean;
  issues: string[];
  manifest?: EmployeePackManifest;
}

export function findAppManifestPath(appRoot: string): string | undefined {
  for (const candidate of ["opengrove.app.json", "opengrove.app.jsonc"]) {
    const manifestPath = join(appRoot, candidate);
    if (existsSync(manifestPath)) return manifestPath;
  }
  return undefined;
}

export function validateAppManifestFile(appRoot: string): AppManifestValidationResult & { manifestPath?: string } {
  const manifestPath = findAppManifestPath(appRoot);
  if (!manifestPath) {
    return {
      ok: false,
      issues: ["missing opengrove.app.json"],
      warnings: [],
    };
  }
  try {
    const entry = lstatSync(manifestPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return {
        ok: false,
        issues: ["manifest must be a regular file"],
        warnings: [],
        manifestPath,
      };
    }
    return {
      manifestPath,
      ...validateAppManifestText(readFileSync(manifestPath, "utf8")),
    };
  } catch (error) {
    return {
      ok: false,
      issues: [`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
      manifestPath,
    };
  }
}

export function validateAppManifestText(text: string): AppManifestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonLikeComments(text));
  } catch (error) {
    return {
      ok: false,
      issues: [`invalid json: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
  return validateAppManifest(parsed);
}

export function validateEmployeePackManifestText(text: string): EmployeePackManifestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonLikeComments(text));
  } catch (error) {
    return {
      ok: false,
      issues: [`invalid json: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const result = employeePackManifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => `${issue.path.join(".") || "employee"}: ${issue.message}`),
    };
  }
  return {
    ok: true,
    issues: [],
    manifest: result.data,
  };
}

export function validateAppManifest(value: unknown): AppManifestValidationResult {
  const result = opengroveAppManifestSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`),
      warnings: [],
    };
  }
  const semanticIssues = semanticManifestIssues(result.data);
  const semanticWarnings = semanticManifestWarnings(result.data);
  return {
    ok: semanticIssues.length === 0,
    issues: semanticIssues,
    warnings: semanticWarnings,
    manifest: result.data,
  };
}

function semanticManifestIssues(manifest: OpenGroveAppManifest): string[] {
  const issues: string[] = [];
  if (
    isRetiredKnowledgeVaultPackage({
      appId: manifest.id,
      packageKey: manifest.store?.packageKey,
    })
  ) {
    issues.push("app identity is retired: knowledge-vault");
  }
  if (manifest.locales && !manifest.defaultLocale) {
    issues.push("defaultLocale is required when locales are declared");
  }
  if (manifest.defaultLocale && !isValidLocaleTag(manifest.defaultLocale)) {
    issues.push(`defaultLocale is not a valid BCP 47 language tag: ${manifest.defaultLocale}`);
  }
  const tabIds = new Set((manifest.ui?.tabs ?? []).flatMap((tab) => (tab.id ? [tab.id] : [])));
  const employeeDeclarations = manifestEmployeeDeclarations(manifest);
  const employeeIds = new Set(employeeDeclarations.flatMap((employee) => (employee.id ? [employee.id] : [])));
  const duplicateEmployeeIdentities = duplicateStrings(
    employeeDeclarations.map((employee, index) =>
      (employee.id ?? employee.name ?? `employee-${index + 1}`).trim().toLowerCase(),
    ),
  );
  if (duplicateEmployeeIdentities.length) {
    issues.push(`employees contain duplicate identities: ${duplicateEmployeeIdentities.join(", ")}`);
  }
  const cliIds = new Set(
    (manifest.capabilities?.cli ?? []).flatMap((declaration) =>
      typeof declaration === "string"
        ? []
        : declaration.id
          ? [declaration.id]
          : declaration.name
            ? [declaration.name]
            : [],
    ),
  );
  for (const [locale, localized] of Object.entries(manifest.locales ?? {})) {
    if (!isValidLocaleTag(locale)) {
      issues.push(`locales contains an invalid BCP 47 language tag: ${locale}`);
    }
    for (const tabId of Object.keys(localized.ui?.tabs ?? {})) {
      if (!tabIds.has(tabId)) issues.push(`locales.${locale}.ui.tabs references unknown tab id: ${tabId}`);
    }
    for (const employeeId of Object.keys(localized.employees ?? {})) {
      if (!employeeIds.has(employeeId))
        issues.push(`locales.${locale}.employees references unknown employee id: ${employeeId}`);
    }
    for (const cliId of Object.keys(localized.capabilities?.cli ?? {})) {
      if (!cliIds.has(cliId)) issues.push(`locales.${locale}.capabilities.cli references unknown CLI id: ${cliId}`);
    }
  }
  const uiKind = legacyAppUiKind(manifest);
  const uiSurface = manifest.ui?.surface;
  const normalizedUi = normalizeCompatibleAppUi(manifest);
  const workspacePath = manifest.ui?.workspace || manifest.workspace?.path;
  if (uiSurface && uiKind) {
    issues.push("ui.surface and legacy ui.kind cannot be declared together");
  }
  if (uiSurface !== "view" && manifest.ui?.view) {
    issues.push("ui.view is only allowed when ui.surface=view");
  }
  if (normalizedUi.surface === "file-workbench" && !workspacePath) {
    issues.push(`${uiSurface ? "ui.surface" : "ui.kind"}=file-workbench requires ui.workspace or workspace.path`);
  }
  if (normalizedUi.surface === "view") {
    const view = normalizedUi.view;
    if (!view?.entry) {
      issues.push(uiSurface ? "ui.surface=view requires ui.view.entry" : "ui.kind=mcp-app requires ui.entry");
    }
    issues.push(...mcpAppViewIssues(view, uiSurface ? "ui.view" : "ui"));
  }
  const viewTabIds: string[] = [];
  for (const [index, tab] of (manifest.ui?.tabs ?? []).entries()) {
    const prefix = `ui.tabs[${index}]`;
    if (tab.component === "view") {
      if (normalizedUi.surface !== "file-workbench") {
        issues.push(`${prefix}.component=view is only allowed when ui.surface=file-workbench`);
      }
      if (!tab.id) issues.push(`${prefix}.id is required for component=view`);
      else viewTabIds.push(tab.id);
      if (!tab.view) {
        issues.push(`${prefix}.view is required for component=view`);
      } else {
        const view = normalizeMcpAppView(tab.view);
        if (!view.entry) issues.push(`${prefix}.view.entry is required for component=view`);
        issues.push(...mcpAppViewIssues(view, `${prefix}.view`));
      }
    } else if (tab.view) {
      issues.push(`${prefix}.view is only allowed when component=view`);
    }
  }
  const duplicateViewTabIds = duplicateStrings(viewTabIds);
  if (duplicateViewTabIds.length) {
    issues.push(`ui.tabs view ids contain duplicates: ${duplicateViewTabIds.join(", ")}`);
  }
  if (uiKind === "web-app" || uiKind === "web") {
    const retiredIssue = retiredWebAppUiIssue(manifest);
    if (retiredIssue) issues.push(retiredIssue);
  }
  for (const declaration of manifest.capabilities?.cli ?? []) {
    if (typeof declaration === "string") continue;
    if (!declaration.command && !declaration.path && !declaration.bin) {
      issues.push(`capabilities.cli.${declaration.id ?? declaration.name ?? "item"} requires command/path/bin`);
    }
  }
  return issues;
}

function manifestEmployeeDeclarations(manifest: OpenGroveAppManifest) {
  return [
    ...(manifest.employees ?? []),
    ...(manifest.agents ?? []),
    ...(manifest.rooms?.employees ?? []),
    ...(manifest.rooms?.agents ?? []),
    ...(manifest.capabilities?.employees ?? []),
    ...(manifest.capabilities?.agents ?? []),
    ...(manifest.agentPack?.employees ?? []),
    ...(manifest.agentPack?.agents ?? []),
  ];
}

function isValidLocaleTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value.replaceAll("_", "-")).length === 1;
  } catch {
    return false;
  }
}

function duplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function mcpAppViewIssues(view: ReturnType<typeof normalizeMcpAppView> | undefined, prefix: string): string[] {
  if (!view) return [];
  const issues: string[] = [];
  if (view.entry.startsWith("/") || view.entry.includes("..")) {
    issues.push(`${prefix}.entry must be a relative path inside the App root`);
  }
  const duplicateTools = duplicateStrings(view.tools);
  if (duplicateTools.length) {
    issues.push(`${prefix}.tools contains duplicates: ${duplicateTools.join(", ")}`);
  }
  const unknownTools = view.tools.filter(
    (tool) => !MCP_APP_BRIDGE_TOOL_IDS.includes(tool as (typeof MCP_APP_BRIDGE_TOOL_IDS)[number]),
  );
  if (unknownTools.length) {
    issues.push(`${prefix}.tools contains unsupported tools: ${unknownTools.join(", ")}`);
  }
  for (const domain of mcpAppCspDomains(view.csp)) {
    if (!isSafeMcpAppCspSource(domain)) {
      issues.push(`${prefix}.csp contains an invalid source: ${domain}`);
    }
  }
  return issues;
}

function mcpAppCspDomains(
  csp:
    | {
        connectDomains?: string[];
        resourceDomains?: string[];
        frameDomains?: string[];
        baseUriDomains?: string[];
      }
    | undefined,
): string[] {
  return [
    ...(csp?.connectDomains ?? []),
    ...(csp?.resourceDomains ?? []),
    ...(csp?.frameDomains ?? []),
    ...(csp?.baseUriDomains ?? []),
  ];
}

function isSafeMcpAppCspSource(value: string): boolean {
  if (/[;\r\n'"\s]/u.test(value)) return false;
  const wildcard = value.startsWith("https://*.");
  if (value.includes("*") && !wildcard) return false;
  try {
    const url = new URL(wildcard ? value.replace("https://*.", "https://wildcard.") : value);
    return (
      url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
    );
  } catch {
    return false;
  }
}

function semanticManifestWarnings(manifest: OpenGroveAppManifest): string[] {
  const warnings: string[] = [];
  const uiKind = legacyAppUiKind(manifest);
  if (uiKind === "native" || uiKind === "custom") {
    warnings.push(`ui.kind=${uiKind} is reserved; this OpenGrove version will not render it as a native/custom UI`);
  }
  for (const tab of manifest.ui?.tabs ?? []) {
    if (
      tab.component !== "file-tree" &&
      tab.component !== "flow-list" &&
      tab.component !== "dashboard" &&
      tab.component !== "view"
    ) {
      warnings.push(`ui.tabs component ${tab.component} is not supported and will be hidden`);
    }
  }
  return warnings;
}

function stripJsonLikeComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}
