import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { APP_CONFIG_DIR } from "../identity.js";
import { BRIDGE_KERNEL_IDS } from "../server/bridge-types.js";
import type { BridgeKernelId, BridgeSettings, BridgeState } from "../server/bridge-types.js";
import { getKernelPathContract } from "../server/kernel-registry.js";
import { defaultKernelConfigHome, kernelBinaryPathOverride, kernelConfigHome } from "../server/kernel-utils.js";
import { resolveBridgeWorkspaceRoot } from "../server/workspace-root.js";
import type { ExtensionScope, ExtensionSourceOrigin } from "./types.js";

export type ExtensionRootKind = "skill" | "mcp" | "plugin" | "hook";

export interface ExtensionRootDescriptor {
  id: string;
  kind: ExtensionRootKind;
  kernelId: BridgeKernelId;
  scope: ExtensionScope;
  path: string;
  reason: string;
  sourceOrigin: ExtensionSourceOrigin;
  readonly: boolean;
  system: boolean;
  preferredTarget?: boolean;
  recursive?: boolean;
  maxDepth?: number;
  configFormat?: "json" | "jsonc" | "toml";
}

export interface KernelCliDescriptor {
  id: string;
  kernelId: BridgeKernelId;
  command: string;
  configuredPath?: string;
  reason: string;
}

export interface KernelExtensionLayout {
  kernelId: BridgeKernelId;
  configHome: string;
  workspaceRoot: string;
  roots: ExtensionRootDescriptor[];
  cliCommands: KernelCliDescriptor[];
}

export function collectKernelExtensionLayouts(state: BridgeState): KernelExtensionLayout[] {
  const workspaceRoot = resolveBridgeWorkspaceRoot(state.settings);
  return BRIDGE_KERNEL_IDS.map((kernelId) => collectKernelExtensionLayout(state.settings, kernelId, workspaceRoot));
}

export function collectKernelExtensionLayout(
  settings: Pick<BridgeSettings, "kernelPathOverrides" | "workspaceRoot" | "mountedApps">,
  kernelId: BridgeKernelId,
  workspaceRoot = resolveBridgeWorkspaceRoot(settings),
): KernelExtensionLayout {
  const configHome = resolve(kernelConfigHome(settings, kernelId));
  const rootBuilder = new RootBuilder(kernelId, workspaceRoot);
  const configParent = dirname(configHome);
  const agentsSkills = join(configParent, ".agents", "skills");
  const ancestry = collectWorkspaceAncestry(workspaceRoot);
  const projectRoot = ancestry.find((root) => existsSync(join(root, ".git"))) ?? workspaceRoot;

  const addProjectSkills = (...segments: string[]) => {
    for (const projectRoot of ancestry) {
      rootBuilder.skill(join(projectRoot, ...segments), "project", "kernel", `${kernelId}_project_skill_directory`, {
        preferredTarget: projectRoot === workspaceRoot,
      });
    }
  };

  const addProjectConfig = (
    segments: string[],
    kind: "mcp" | "hook",
    reason: string,
    format: "json" | "jsonc" | "toml" = "json",
  ) => {
    for (const projectRoot of ancestry) {
      rootBuilder.config(kind, join(projectRoot, ...segments), "project", "kernel", reason, format);
    }
  };

  switch (kernelId) {
    case "codex":
      rootBuilder.skill(agentsSkills, "user", "kernel", "codex_shared_agents_skill_directory", {
        preferredTarget: true,
      });
      rootBuilder.skill(join(configHome, "skills"), "user", "kernel", "codex_user_skill_directory");
      rootBuilder.skill(join(configHome, "skills", ".system"), "system", "system", "codex_system_skill_directory", {
        readonly: true,
        system: true,
      });
      rootBuilder.skill(join(configHome, "plugins", "cache"), "system", "plugin", "codex_plugin_skill_cache", {
        readonly: true,
        system: true,
        recursive: true,
        maxDepth: 7,
      });
      addProjectSkills(".agents", "skills");
      addProjectSkills(".codex", "skills");
      addProjectConfig([".agents", "mcp.json"], "mcp", "codex_project_agents_mcp_file");
      addProjectConfig([".codex", "config.toml"], "mcp", "codex_project_mcp_config", "toml");
      rootBuilder.config("mcp", join(configHome, "config.toml"), "user", "kernel", "codex_user_config_toml", "toml");
      rootBuilder.config("hook", join(configHome, "hooks.json"), "user", "kernel", "codex_user_hooks_json", "json");
      rootBuilder.plugin(join(configHome, "plugins"), "user", "kernel", "codex_user_plugin_directory");
      break;

    case "claude-code":
      rootBuilder.skill(join(configHome, "skills"), "user", "kernel", "claude_user_skill_directory", {
        preferredTarget: true,
      });
      addProjectSkills(".claude", "skills");
      addProjectConfig([".mcp.json"], "mcp", "claude_project_mcp_file");
      addProjectConfig([".claude", "settings.json"], "hook", "claude_project_settings_hooks");
      rootBuilder.config(
        "mcp",
        join(configParent, ".claude.json"),
        "user",
        "kernel",
        "claude_user_profile_json",
        "json",
      );
      rootBuilder.config("mcp", join(configHome, "mcp.json"), "user", "kernel", "claude_user_mcp_json", "json");
      rootBuilder.config(
        "hook",
        join(configHome, "settings.json"),
        "user",
        "kernel",
        "claude_user_settings_hooks",
        "json",
      );
      rootBuilder.plugin(join(configHome, "plugins"), "user", "kernel", "claude_user_plugin_directory");
      break;

    case "hermes":
      rootBuilder.skill(join(configHome, "skills"), "user", "kernel", "hermes_user_skill_directory", {
        preferredTarget: true,
      });
      addProjectSkills(".hermes", "skills");
      rootBuilder.skill(
        join(workspaceRoot, APP_CONFIG_DIR, "native-skills", "hermes"),
        "project",
        "opengrove",
        "opengrove_hermes_native_skill_directory",
        {
          preferredTarget: true,
        },
      );
      rootBuilder.config("mcp", join(configHome, "mcp.json"), "user", "kernel", "hermes_user_mcp_json", "json");
      rootBuilder.config("hook", join(configHome, "hooks.json"), "user", "kernel", "hermes_user_hooks_json", "json");
      rootBuilder.plugin(join(configHome, "plugins"), "user", "kernel", "hermes_user_plugin_directory");
      break;

    case "pi":
      rootBuilder.skill(join(configHome, "agent", "skills"), "user", "kernel", "pi_agent_skill_directory", {
        preferredTarget: true,
      });
      rootBuilder.skill(join(configHome, "skills"), "user", "kernel", "pi_user_skill_directory");
      addProjectSkills(".pi", "skills");
      rootBuilder.config("mcp", join(configHome, "mcp.json"), "user", "kernel", "pi_user_mcp_json", "json");
      rootBuilder.config("hook", join(configHome, "hooks.json"), "user", "kernel", "pi_user_hooks_json", "json");
      break;

    case "openclaw":
      rootBuilder.skill(join(configHome, "skills"), "user", "kernel", "openclaw_user_skill_directory", {
        preferredTarget: true,
      });
      addProjectSkills("skills");
      addProjectSkills(".agents", "skills");
      rootBuilder.config("mcp", join(configHome, "mcp.json"), "user", "kernel", "openclaw_user_mcp_json", "json");
      rootBuilder.config("hook", join(configHome, "hooks.json"), "user", "kernel", "openclaw_user_hooks_json", "json");
      rootBuilder.plugin(join(configHome, "plugins"), "user", "kernel", "openclaw_user_plugin_directory");
      break;

    case "opencode":
      rootBuilder.skill(join(configHome, "skills"), "user", "kernel", "opencode_user_skill_directory", {
        preferredTarget: true,
      });
      addProjectSkills(".opencode", "skills");
      rootBuilder.config("mcp", join(configHome, "opencode.jsonc"), "user", "kernel", "opencode_user_jsonc", "jsonc");
      rootBuilder.config(
        "hook",
        join(configHome, "opencode.jsonc"),
        "user",
        "kernel",
        "opencode_user_jsonc_hooks",
        "jsonc",
      );
      rootBuilder.config("mcp", join(configHome, "opencode.json"), "user", "kernel", "opencode_user_json", "json");
      rootBuilder.config(
        "hook",
        join(configHome, "opencode.json"),
        "user",
        "kernel",
        "opencode_user_json_hooks",
        "json",
      );
      rootBuilder.plugin(join(configHome, "plugin"), "user", "kernel", "opencode_plugin_directory");
      rootBuilder.plugin(join(configHome, "plugins"), "user", "kernel", "opencode_plugins_directory");
      break;

    case "kimi":
      rootBuilder.skill(join(configHome, "skills"), "user", "kernel", "kimi_user_skill_directory", {
        preferredTarget: true,
      });
      rootBuilder.skill(join(homedir(), ".agents", "skills"), "user", "kernel", "kimi_shared_agents_skill_directory");
      rootBuilder.skill(
        join(projectRoot, ".kimi-code", "skills"),
        "project",
        "kernel",
        "kimi_project_skill_directory",
        { preferredTarget: true },
      );
      rootBuilder.skill(
        join(projectRoot, ".agents", "skills"),
        "project",
        "kernel",
        "kimi_project_agents_skill_directory",
      );
      rootBuilder.config("mcp", join(configHome, "mcp.json"), "user", "kernel", "kimi_user_mcp_json", "json");
      rootBuilder.config(
        "mcp",
        join(projectRoot, ".mcp.json"),
        "project",
        "kernel",
        "kimi_project_root_mcp_json",
        "json",
      );
      rootBuilder.config(
        "mcp",
        join(workspaceRoot, ".kimi-code", "mcp.json"),
        "project",
        "kernel",
        "kimi_project_local_mcp_json",
        "json",
      );
      rootBuilder.config(
        "hook",
        join(configHome, "config.toml"),
        "user",
        "kernel",
        "kimi_user_config_toml_hooks",
        "toml",
      );
      break;
  }

  addMountedApps(rootBuilder, settings);

  return {
    kernelId,
    configHome,
    workspaceRoot,
    roots: rootBuilder.roots(),
    cliCommands: kernelCliCommands(settings, kernelId),
  };
}

function addMountedApps(rootBuilder: RootBuilder, settings: Pick<BridgeSettings, "mountedApps">): void {
  for (const mountedApp of settings.mountedApps ?? []) {
    if (mountedApp.enabled === false || !mountedApp.path?.trim()) continue;
    const root = resolvePathLike(mountedApp.path);
    const reason = mountedApp.id ? `mounted_app:${mountedApp.id}` : "mounted_app";
    rootBuilder.skill(join(root, "skills"), "external", "local", `${reason}:skills`, {
      recursive: true,
      maxDepth: 4,
    });
    rootBuilder.config("mcp", join(root, "mcp.json"), "external", "local", `${reason}:mcp`, "json");
    rootBuilder.config("hook", join(root, "hooks.json"), "external", "local", `${reason}:hooks`, "json");
  }
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(homedir());
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function preferredSkillTargetRoot(
  state: BridgeState,
  kernelId: BridgeKernelId,
  scope: "user" | "project" = "user",
): ExtensionRootDescriptor | undefined {
  const layout = collectKernelExtensionLayout(state.settings, kernelId);
  const candidates = layout.roots.filter(
    (root) => root.kind === "skill" && root.scope === scope && !root.readonly && !root.system,
  );
  return candidates.find((root) => root.preferredTarget) ?? candidates[0];
}

export function collectWorkspaceAncestry(workspaceRoot: string): string[] {
  const roots: string[] = [];
  const home = resolve(homedir());
  let current = resolve(workspaceRoot || process.cwd());

  while (true) {
    roots.push(current);
    if (current === home) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

function kernelCliCommands(
  settings: Pick<BridgeSettings, "kernelPathOverrides">,
  kernelId: BridgeKernelId,
): KernelCliDescriptor[] {
  const configuredPath = kernelBinaryPathOverride(settings, kernelId);
  const command = configuredPath ?? defaultKernelCliCommand(kernelId);
  return [
    {
      id: `cli.${kernelId}`,
      kernelId,
      command,
      configuredPath,
      reason: configuredPath ? "kernel_binary_path_override" : "default_kernel_cli_command",
    },
  ];
}

function defaultKernelCliCommand(kernelId: BridgeKernelId): string {
  return getKernelPathContract(kernelId).cliCommand;
}

class RootBuilder {
  private readonly values: ExtensionRootDescriptor[] = [];

  constructor(
    private readonly kernelId: BridgeKernelId,
    private readonly workspaceRoot: string,
  ) {}

  skill(
    path: string,
    scope: ExtensionScope,
    sourceOrigin: ExtensionSourceOrigin,
    reason: string,
    options: Partial<
      Pick<ExtensionRootDescriptor, "readonly" | "system" | "preferredTarget" | "recursive" | "maxDepth">
    > = {},
  ): void {
    this.add({
      kind: "skill",
      path,
      scope,
      sourceOrigin,
      reason,
      readonly: options.readonly ?? scope === "system",
      system: options.system ?? scope === "system",
      preferredTarget: options.preferredTarget,
      recursive: options.recursive,
      maxDepth: options.maxDepth,
    });
  }

  config(
    kind: "mcp" | "hook",
    path: string,
    scope: ExtensionScope,
    sourceOrigin: ExtensionSourceOrigin,
    reason: string,
    configFormat: "json" | "jsonc" | "toml",
  ): void {
    this.add({
      kind,
      path,
      scope,
      sourceOrigin,
      reason,
      readonly: false,
      system: false,
      configFormat,
    });
  }

  plugin(path: string, scope: ExtensionScope, sourceOrigin: ExtensionSourceOrigin, reason: string): void {
    this.add({
      kind: "plugin",
      path,
      scope,
      sourceOrigin,
      reason,
      readonly: false,
      system: false,
      recursive: true,
      maxDepth: 4,
    });
  }

  roots(): ExtensionRootDescriptor[] {
    return this.values.filter(
      (root, index, list) =>
        list.findIndex(
          (candidate) =>
            candidate.kind === root.kind &&
            candidate.kernelId === root.kernelId &&
            candidate.path === root.path &&
            candidate.configFormat === root.configFormat,
        ) === index,
    );
  }

  private add(input: Omit<ExtensionRootDescriptor, "id" | "kernelId">): void {
    const normalizedPath = resolve(input.path);
    this.values.push({
      ...input,
      id: [
        input.kind,
        this.kernelId,
        input.scope,
        basename(normalizedPath) || "root",
        stablePathId(normalizedPath, this.workspaceRoot),
      ].join("."),
      kernelId: this.kernelId,
      path: normalizedPath,
    });
  }
}

function stablePathId(path: string, workspaceRoot: string): string {
  const normalized = path.startsWith(workspaceRoot) ? path.slice(workspaceRoot.length) : path;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function isDefaultKernelConfigHome(kernelId: BridgeKernelId, configHome: string): boolean {
  return resolve(defaultKernelConfigHome(kernelId)) === resolve(configHome);
}
