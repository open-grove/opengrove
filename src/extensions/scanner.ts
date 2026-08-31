import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { JsonObject, SkillManifest, ToolSpec } from "../core.js";
import { APP_MANAGED_BY, APP_NATIVE_SKILL_MARKER_FILE } from "../identity.js";
import type { BridgeKernelId, BridgeState } from "../server/bridge-types.js";
import { collectKernelExtensionLayouts } from "./kernel-roots.js";
import type { ExtensionRootDescriptor } from "./kernel-roots.js";
import {
  arrayOfStrings,
  commandRisk,
  commandUsage,
  commandsToPermissions,
  compareDeployments,
  compareItems,
  dedupePermissions,
  deploymentId,
  extractClaudeStyleHooks,
  extractCommandUsagesFromObject,
  extractGenericHookCommands,
  itemId,
  parseSimpleToml,
  parseSkillFile,
  pathSep,
  readManagedMarker,
  record,
  resolvePathLike,
  shouldSkipDirectory,
  skillCommandUsages,
  skillDirectoryDigest,
  skillPermissions,
  stringValue,
  summarizeInventory,
  titleFromName,
  uniqueBy,
  uniqueCommandUsages,
  uniqueStrings,
  type HookEntry,
} from "./scanner-helpers.js";
import { mountedAppEntry, type MountedAppCliDeclaration, type MountedAppEntry } from "./scanner-mounted-apps.js";
import { resolveHostLanguageSettings } from "../server/language-preference.js";
import { normalizeCompatibleAppUi } from "../app-builder/compat/legacy-app-ui.compat.js";
import { discoverPlugins } from "./scanner-plugin-discovery.js";
import { loadExtensionManagerState } from "./state.js";
import type {
  ExtensionCommandUsage,
  ExtensionDeployment,
  ExtensionInventory,
  ExtensionPermission,
  ManagedExtensionRecord,
} from "./types.js";

export interface ScanExtensionInventoryOptions {
  includeSystem?: boolean;
}

interface McpServerEntry {
  name: string;
  command?: string;
  args: string[];
  envKeys: string[];
  url?: string;
  entry: JsonObject;
}

interface InventoryAccumulator {
  items: Map<string, ManagedExtensionRecord>;
  deployments: ExtensionDeployment[];
  commandUsages: ExtensionCommandUsage[];
}

export function scanExtensionInventory(
  state: BridgeState,
  options: ScanExtensionInventoryOptions = {},
): ExtensionInventory {
  const includeSystem = options.includeSystem === true;
  const managerState = loadExtensionManagerState(state);
  const layouts = collectKernelExtensionLayouts(state);
  const workspaceRoot = layouts[0]?.workspaceRoot ?? state.settings.workspaceRoot ?? process.cwd();
  const accumulator: InventoryAccumulator = {
    items: new Map(),
    deployments: [],
    commandUsages: [],
  };

  for (const layout of layouts) {
    for (const root of layout.roots) {
      if (root.system && !includeSystem) {
        continue;
      }
      if (root.kind === "skill") {
        scanSkillRoot(accumulator, root);
      } else if (root.kind === "mcp") {
        scanMcpConfig(accumulator, root);
      } else if (root.kind === "hook") {
        scanHookConfig(accumulator, root);
      } else if (root.kind === "plugin") {
        scanPluginRoot(accumulator, root);
      }
    }
  }

  scanMountedApps(accumulator, state);

  try {
    for (const skill of state.app.skills.list()) {
      addRegisteredSkill(accumulator, skill, workspaceRoot);
    }
  } catch {
    // Partial bridge states used by harnesses may not have a skill registry.
  }

  try {
    for (const tool of state.app.tools.specs()) {
      addTool(accumulator, tool, workspaceRoot);
    }
  } catch {
    // Inventory scanning should keep working in tests and partial bridge states.
  }

  for (const librarySkill of Object.values(managerState.skillLibrary)) {
    const libraryEntry = existsSync(join(librarySkill.sourceRoot, "SKILL.md"))
      ? join(librarySkill.sourceRoot, "SKILL.md")
      : join(librarySkill.sourceRoot, "SKILL.md.disabled");
    const parsed = parseSkillFile(libraryEntry, librarySkill.name);
    const sourceDigest = skillDirectoryDigest(librarySkill.sourceRoot);
    const deployment: ExtensionDeployment = {
      id: deploymentId("skill", undefined, librarySkill.sourceRoot, librarySkill.name),
      itemId: itemId("skill", librarySkill.name),
      kind: "skill",
      scope: "managed",
      status: existsSync(join(librarySkill.sourceRoot, "SKILL.md")) ? "unpublished" : "missing",
      enabled: existsSync(join(librarySkill.sourceRoot, "SKILL.md")),
      managedByOpenGrove: true,
      readonly: false,
      system: false,
      sourcePath: librarySkill.sourceRoot,
      targetPath: librarySkill.sourceRoot,
      metadata: {
        libraryId: librarySkill.id,
        createdAt: librarySkill.createdAt,
        updatedAt: librarySkill.updatedAt,
        ...(sourceDigest ? { sourceDigest } : {}),
      },
    };
    addItemDeployment(
      accumulator,
      {
        id: deployment.itemId,
        kind: "skill",
        name: librarySkill.name,
        title: parsed.title || librarySkill.title,
        description: parsed.description || librarySkill.description,
        enabled: deployment.enabled,
        managedByOpenGrove: true,
        readonly: false,
        system: false,
        source: {
          origin: librarySkill.origin?.origin ?? "opengrove",
          kernelId: librarySkill.origin?.kernelId,
          path: librarySkill.sourceRoot,
          readonly: false,
          system: false,
        },
        deployments: [],
        permissions: skillPermissions(parsed),
        commandUsages: skillCommandUsages(parsed, deployment.id),
        childIds: [],
        tags: parsed.tags,
        metadata: deployment.metadata ?? {},
      },
      deployment,
    );
    accumulator.commandUsages.push(...skillCommandUsages(parsed, deployment.id));
  }

  for (const disabledConfig of Object.values(managerState.disabledConfigs)) {
    const item =
      disabledConfig.kind === "mcp"
        ? mcpItemFromEntry(
            {
              name: disabledConfig.name,
              args: arrayOfStrings(disabledConfig.entry.args),
              command: stringValue(disabledConfig.entry.command),
              envKeys: Object.keys(record(disabledConfig.entry.env)),
              url: stringValue(disabledConfig.entry.url),
              entry: disabledConfig.entry,
            },
            disabledConfig.configPath,
            disabledConfig.kernelId,
          )
        : hookItemFromEntry(
            {
              name: disabledConfig.name,
              command: stringValue(disabledConfig.entry.command),
              args: arrayOfStrings(disabledConfig.entry.args),
              envKeys: Object.keys(record(disabledConfig.entry.env)),
              entry: disabledConfig.entry,
            },
            disabledConfig.configPath,
            disabledConfig.kernelId,
          );
    const deployment: ExtensionDeployment = {
      id: disabledConfig.id,
      itemId: item.id,
      kind: disabledConfig.kind,
      kernelId: disabledConfig.kernelId,
      scope: "user",
      status: "disabled",
      enabled: false,
      managedByOpenGrove: true,
      readonly: false,
      system: false,
      configPath: disabledConfig.configPath,
      configFormat: disabledConfig.configFormat,
      metadata: {
        disabledAt: disabledConfig.disabledAt,
        redacted: disabledConfig.redacted,
      },
    };
    addItemDeployment(accumulator, item, deployment);
  }

  for (const [deploymentIndex, deployment] of accumulator.deployments.entries()) {
    if (managerState.disabledOverlays[deployment.id]) {
      accumulator.deployments[deploymentIndex] = {
        ...deployment,
        enabled: false,
        status: "disabled",
        metadata: {
          ...(deployment.metadata ?? {}),
          disabledOverlay: managerState.disabledOverlays[deployment.id] as unknown as JsonObject,
        },
      };
    }
  }

  for (const item of accumulator.items.values()) {
    item.deployments = accumulator.deployments.filter((deployment) => deployment.itemId === item.id);
    item.enabled = item.deployments.some((deployment) => deployment.enabled);
    item.managedByOpenGrove =
      item.deployments.some((deployment) => deployment.managedByOpenGrove) || item.managedByOpenGrove;
    item.readonly = item.deployments.length > 0 && item.deployments.every((deployment) => deployment.readonly);
    item.system = item.deployments.some((deployment) => deployment.system) || item.system;
    const outdatedDeployments = item.deployments.filter(
      (deployment) =>
        deployment.kind === "skill" &&
        deployment.enabled &&
        deployment.managedByOpenGrove &&
        deployment.metadata?.outOfDate === true,
    );
    if (outdatedDeployments.length) {
      item.metadata = {
        ...(item.metadata ?? {}),
        outOfDate: true,
        outdatedDeploymentCount: outdatedDeployments.length,
        outdatedKernelIds: uniqueStrings(
          outdatedDeployments.map((deployment) => deployment.kernelId ?? "").filter(Boolean),
        ),
      };
    }
  }

  const items = Array.from(accumulator.items.values()).sort(compareItems);
  const deployments = accumulator.deployments.sort(compareDeployments);
  return {
    scannedAt: new Date().toISOString(),
    workspaceRoot,
    items,
    deployments,
    commandUsages: accumulator.commandUsages.sort((left, right) => left.command.localeCompare(right.command)),
    summary: summarizeInventory(items, deployments),
  };
}

export function parseJsonLikeConfig(path: string, format: string | undefined): JsonObject | undefined {
  try {
    const text = readFileSync(path, "utf8");
    if (format === "toml") {
      return parseSimpleToml(text);
    }
    return record(JSON.parse(stripJsonTrailingCommas(stripJsonComments(text)))) as JsonObject;
  } catch {
    return undefined;
  }
}

export function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        output += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function stripJsonTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] === "}" || text[cursor] === "]") {
        continue;
      }
    }
    output += char;
  }
  return output;
}

export function extractMcpServers(config: JsonObject): McpServerEntry[] {
  const containers: Record<string, unknown>[] = [];
  for (const key of ["mcpServers", "mcp_servers", "servers"]) {
    const value = record(config[key]);
    if (Object.keys(value).length) containers.push(value);
  }
  const mcp = record(config.mcp);
  for (const key of ["servers", "mcpServers", "mcp_servers"]) {
    const value = record(mcp[key]);
    if (Object.keys(value).length) containers.push(value);
  }

  const entries: McpServerEntry[] = [];
  for (const container of containers) {
    for (const [name, raw] of Object.entries(container)) {
      const item = record(raw);
      entries.push({
        name,
        command: stringValue(item.command),
        args: arrayOfStrings(item.args),
        envKeys: Object.keys(record(item.env)),
        url: stringValue(item.url) ?? stringValue(item.endpoint),
        entry: item as JsonObject,
      });
    }
  }
  return uniqueBy(entries, (entry) => entry.name);
}

export function extractHookEntries(config: JsonObject): HookEntry[] {
  const hooks = record(config.hooks);
  if (Object.keys(hooks).length) {
    return extractClaudeStyleHooks(hooks);
  }
  return extractGenericHookCommands(config);
}

function scanSkillRoot(accumulator: InventoryAccumulator, root: ExtensionRootDescriptor): void {
  if (!existsSync(root.path)) return;
  const skillRoots = discoverSkillDirectories(root.path, root.recursive === true, root.maxDepth ?? 2);
  for (const skillRoot of skillRoots) {
    const enabledEntry = join(skillRoot, "SKILL.md");
    const disabledEntry = join(skillRoot, "SKILL.md.disabled");
    const entry = existsSync(enabledEntry) ? enabledEntry : disabledEntry;
    const status = existsSync(enabledEntry) ? "enabled" : "disabled";
    const parsed = parseSkillFile(entry, basename(skillRoot));
    const marker = readManagedMarker(skillRoot);
    const managedByOpenGrove = marker?.managedBy === APP_MANAGED_BY;
    const system = root.system || skillRoot.includes(`${pathSep()}skills${pathSep()}.system${pathSep()}`);
    const sourceDigest = marker?.sourceRoot ? skillDirectoryDigest(marker.sourceRoot) : undefined;
    const targetDigest = marker?.sourceRoot ? skillDirectoryDigest(skillRoot) : undefined;
    const outOfDate = Boolean(sourceDigest && targetDigest && sourceDigest !== targetDigest);
    const deployment: ExtensionDeployment = {
      id: deploymentId("skill", root.kernelId, skillRoot, parsed.name),
      itemId: itemId("skill", parsed.name),
      kind: "skill",
      kernelId: root.kernelId,
      scope: root.scope,
      status,
      enabled: status === "enabled",
      managedByOpenGrove,
      readonly: root.readonly || system,
      system,
      sourcePath: skillRoot,
      targetPath: skillRoot,
      markerPath: marker ? join(skillRoot, APP_NATIVE_SKILL_MARKER_FILE) : undefined,
      metadata: {
        root: root.path,
        reason: root.reason,
        skillFile: entry,
        sourceOrigin: marker?.sourceRoot ? "opengrove" : root.sourceOrigin,
        ...(marker?.sourceRoot ? { managedSourceRoot: marker.sourceRoot } : {}),
        ...(sourceDigest ? { sourceDigest } : {}),
        ...(targetDigest ? { targetDigest } : {}),
        ...(marker?.sourceRoot ? { outOfDate } : {}),
      },
    };
    addItemDeployment(
      accumulator,
      {
        id: deployment.itemId,
        kind: "skill",
        name: parsed.name,
        title: parsed.title,
        description: parsed.description,
        enabled: deployment.enabled,
        managedByOpenGrove,
        readonly: deployment.readonly,
        system,
        source: {
          origin: marker?.sourceRoot ? "opengrove" : root.sourceOrigin,
          kernelId: root.kernelId,
          path: skillRoot,
          readonly: deployment.readonly,
          system,
        },
        deployments: [],
        permissions: skillPermissions(parsed),
        commandUsages: skillCommandUsages(parsed, deployment.id, root.kernelId),
        childIds: [],
        tags: parsed.tags,
        metadata: {
          allowedTools: parsed.allowedTools,
          shell: parsed.shell,
          paths: parsed.paths,
        },
      },
      deployment,
    );
    accumulator.commandUsages.push(...skillCommandUsages(parsed, deployment.id, root.kernelId));
  }
}

function scanMcpConfig(accumulator: InventoryAccumulator, root: ExtensionRootDescriptor): void {
  if (!existsSync(root.path)) return;
  const config = parseJsonLikeConfig(root.path, root.configFormat);
  if (!config) return;
  for (const server of extractMcpServers(config)) {
    const item = mcpItemFromEntry(server, root.path, root.kernelId);
    const deployment: ExtensionDeployment = {
      id: deploymentId("mcp", root.kernelId, root.path, server.name),
      itemId: item.id,
      kind: "mcp",
      kernelId: root.kernelId,
      scope: root.scope,
      status: "enabled",
      enabled: true,
      managedByOpenGrove: false,
      readonly: root.readonly,
      system: root.system,
      configPath: root.path,
      configFormat: root.configFormat,
      command: server.command,
      args: server.args,
      envKeys: server.envKeys,
      metadata: {
        reason: root.reason,
        ...(server.url ? { url: server.url } : {}),
      },
    };
    addItemDeployment(accumulator, item, deployment);
    accumulator.commandUsages.push(...item.commandUsages);
  }
}

function scanHookConfig(accumulator: InventoryAccumulator, root: ExtensionRootDescriptor): void {
  if (!existsSync(root.path)) return;
  const config = parseJsonLikeConfig(root.path, root.configFormat);
  if (!config) return;
  for (const hook of extractHookEntries(config)) {
    const item = hookItemFromEntry(hook, root.path, root.kernelId);
    const deployment: ExtensionDeployment = {
      id: deploymentId("hook", root.kernelId, root.path, hook.name),
      itemId: item.id,
      kind: "hook",
      kernelId: root.kernelId,
      scope: root.scope,
      status: "enabled",
      enabled: true,
      managedByOpenGrove: false,
      readonly: root.readonly,
      system: root.system,
      configPath: root.path,
      configFormat: root.configFormat,
      command: hook.command,
      args: hook.args,
      envKeys: hook.envKeys,
      metadata: {
        reason: root.reason,
        ...(hook.event ? { event: hook.event } : {}),
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
      },
    };
    addItemDeployment(accumulator, item, deployment);
    accumulator.commandUsages.push(...item.commandUsages);
  }
}

function scanPluginRoot(accumulator: InventoryAccumulator, root: ExtensionRootDescriptor): void {
  if (!existsSync(root.path)) return;
  for (const plugin of discoverPlugins(root, parseJsonLikeConfig, shouldSkipDirectory)) {
    const commands = extractCommandUsagesFromObject(
      plugin.metadata,
      "plugin",
      itemId("plugin", plugin.name),
      root.kernelId,
      plugin.manifestPath,
    );
    const deployment: ExtensionDeployment = {
      id: deploymentId("plugin", root.kernelId, plugin.pluginRoot, plugin.name),
      itemId: itemId("plugin", plugin.name),
      kind: "plugin",
      kernelId: root.kernelId,
      scope: root.scope,
      status: plugin.enabled ? "enabled" : "disabled",
      enabled: plugin.enabled,
      managedByOpenGrove: plugin.sourceOrigin === "opengrove",
      readonly: root.readonly,
      system: root.system,
      sourcePath: plugin.manifestPath,
      targetPath: plugin.pluginRoot,
      metadata: {
        reason: root.reason,
        manifestPath: plugin.manifestPath,
      },
    };
    addItemDeployment(
      accumulator,
      {
        id: deployment.itemId,
        kind: "plugin",
        name: plugin.name,
        title: plugin.title,
        description: plugin.description,
        enabled: plugin.enabled,
        managedByOpenGrove: deployment.managedByOpenGrove,
        readonly: deployment.readonly,
        system: deployment.system,
        source: {
          origin: plugin.sourceOrigin,
          kernelId: root.kernelId,
          path: plugin.pluginRoot,
          readonly: deployment.readonly,
          system: deployment.system,
        },
        deployments: [],
        permissions: commandsToPermissions(commands),
        commandUsages: commands,
        childIds: [],
        tags: [],
        metadata: plugin.metadata,
      },
      deployment,
    );
    accumulator.commandUsages.push(...commands);
  }
}

function scanMountedApps(accumulator: InventoryAccumulator, state: BridgeState): void {
  const seenRoots = new Set<string>();
  const language = resolveHostLanguageSettings(state.settings);
  for (const mountedApp of state.settings.mountedApps ?? []) {
    if (!mountedApp.path?.trim()) continue;
    const appRoot = resolvePathLike(mountedApp.path);
    if (seenRoots.has(appRoot)) continue;
    seenRoots.add(appRoot);
    const entry = mountedAppEntry(mountedApp, appRoot, parseJsonLikeConfig, language);
    const appItemId = itemId("app", entry.name);
    const cliChildIds = entry.cli.map((cli) => itemId("cli", `${entry.name}.${cli.id}`));
    const deployment: ExtensionDeployment = {
      id: deploymentId("app", undefined, appRoot, entry.name),
      itemId: appItemId,
      kind: "app",
      scope: "external",
      status: entry.status,
      enabled: entry.enabled,
      managedByOpenGrove: false,
      readonly: false,
      system: false,
      sourcePath: appRoot,
      targetPath: appRoot,
      metadata: {
        ...(entry.manifestPath ? { manifestPath: entry.manifestPath } : {}),
        ...entry.metadata,
        presentation: entry.presentation as unknown as JsonObject,
        uiRuntime: normalizeCompatibleAppUi(entry.metadata) as unknown as JsonObject,
        capabilities: entry.capabilities,
      },
    };
    addItemDeployment(
      accumulator,
      {
        id: deployment.itemId,
        kind: "app",
        name: entry.name,
        title: entry.title,
        description: entry.description,
        enabled: deployment.enabled,
        managedByOpenGrove: false,
        readonly: false,
        system: false,
        source: {
          origin: "local",
          path: appRoot,
          packageId: entry.name,
          readonly: false,
          system: false,
        },
        deployments: [],
        permissions: [{ type: "filesystem", values: [appRoot] }],
        commandUsages: [],
        childIds: cliChildIds,
        tags: ["app", ...entry.capabilities],
        metadata: deployment.metadata ?? {},
      },
      deployment,
    );
    for (const cli of entry.cli) {
      addMountedAppCli(accumulator, entry, appItemId, cli);
    }
  }
}

function addMountedAppCli(
  accumulator: InventoryAccumulator,
  app: MountedAppEntry,
  appItemId: string,
  cli: MountedAppCliDeclaration,
): void {
  const cliItemName = `${app.name}.${cli.id}`;
  const cliItemId = itemId("cli", cliItemName);
  const usage = commandUsage({
    command: cli.command,
    args: cli.args,
    envKeys: cli.envKeys,
    parentKind: "cli",
    parentId: cliItemId,
    resolvedPath: cli.resolvedPath,
    risk: commandRisk(cli.command, cli.args),
  });
  const enabled = app.enabled && Boolean(cli.resolvedPath);
  const deployment: ExtensionDeployment = {
    id: deploymentId("cli", undefined, cli.command, cliItemName),
    itemId: cliItemId,
    kind: "cli",
    scope: "external",
    status: enabled ? "enabled" : "missing",
    enabled,
    managedByOpenGrove: false,
    readonly: true,
    system: false,
    sourcePath: app.manifestPath ?? app.appRoot,
    targetPath: cli.resolvedPath,
    command: cli.command,
    args: cli.args,
    envKeys: cli.envKeys,
    metadata: {
      appId: app.name,
      appRoot: app.appRoot,
      cwd: cli.cwd ?? app.appRoot,
      doctor: cli.doctor,
      smoke: cli.smoke,
      artifacts: cli.artifacts,
      allowNativeBash: cli.allowNativeBash,
      declared: cli.metadata,
      ...(cli.resolvedPath ? { resolvedPath: cli.resolvedPath } : {}),
    },
  };
  addItemDeployment(
    accumulator,
    {
      id: cliItemId,
      kind: "cli",
      name: cliItemName,
      title: `${app.title} / ${cli.title}`,
      description: cli.description || `CLI declared by ${app.title}.`,
      enabled,
      managedByOpenGrove: false,
      readonly: true,
      system: false,
      source: {
        origin: "local",
        path: cli.resolvedPath ?? app.appRoot,
        packageId: app.name,
        readonly: true,
        system: false,
      },
      deployments: [],
      permissions: [
        { type: "shell", values: [cli.command] },
        ...(cli.envKeys.length ? [{ type: "env" as const, values: cli.envKeys }] : []),
      ],
      commandUsages: [usage],
      parentId: appItemId,
      childIds: [],
      tags: ["cli", app.name, cli.allowNativeBash ? "native-bash" : ""],
      metadata: deployment.metadata ?? {},
    },
    deployment,
  );
}

function addRegisteredSkill(accumulator: InventoryAccumulator, skill: SkillManifest, workspaceRoot: string): void {
  const id = itemId("skill", skill.name);
  if (accumulator.items.has(id)) return;
  const system = skill.source === "bundled";
  const deployment: ExtensionDeployment = {
    id: deploymentId("skill", undefined, "opengrove-registry", skill.name),
    itemId: id,
    kind: "skill",
    scope: "managed",
    status: "enabled",
    enabled: true,
    managedByOpenGrove: true,
    readonly: true,
    system,
    sourcePath: skill.entry,
    targetPath: skill.entry,
    metadata: {
      source: skill.source,
      allowedTools: skill.allowedTools,
      toolIds: skill.toolIds,
    },
  };
  addItemDeployment(
    accumulator,
    {
      id,
      kind: "skill",
      name: skill.name,
      title: skill.title,
      description: skill.description,
      enabled: true,
      managedByOpenGrove: true,
      readonly: true,
      system,
      source: {
        origin: system ? "opengrove" : skill.source === "pack" ? "registry" : "local",
        path: skill.entry || workspaceRoot,
        readonly: true,
        system,
      },
      deployments: [],
      permissions: skill.allowedTools.length ? [{ type: "unknown", values: skill.allowedTools }] : [],
      commandUsages: [],
      childIds: [],
      tags: uniqueStrings([skill.source, ...(skill.tags ?? [])]),
      metadata: {
        allowedTools: skill.allowedTools,
        toolIds: skill.toolIds,
        whenToUse: skill.whenToUse ?? "",
      },
    },
    deployment,
  );
}

function addTool(accumulator: InventoryAccumulator, tool: ToolSpec, workspaceRoot: string): void {
  const deployment: ExtensionDeployment = {
    id: deploymentId("tool", undefined, "opengrove", tool.id),
    itemId: itemId("tool", tool.id),
    kind: "tool",
    scope: "managed",
    status: "enabled",
    enabled: true,
    managedByOpenGrove: true,
    readonly: true,
    system: false,
    metadata: {
      activity: tool.activity,
      risk: tool.risk,
      permission: tool.permission as unknown as JsonObject,
    },
  };
  addItemDeployment(
    accumulator,
    {
      id: deployment.itemId,
      kind: "tool",
      name: tool.id,
      title: tool.title,
      description: tool.description,
      enabled: true,
      managedByOpenGrove: true,
      readonly: true,
      system: false,
      source: {
        origin: "opengrove",
        path: workspaceRoot,
        readonly: true,
        system: false,
      },
      deployments: [],
      permissions: [
        {
          type:
            tool.risk === "send"
              ? "network"
              : tool.risk === "write" || tool.risk === "delete"
                ? "filesystem"
                : "unknown",
          values: [tool.risk],
        },
      ],
      commandUsages: [],
      childIds: [],
      tags: [tool.activity, tool.risk],
      metadata: {
        input: tool.input as unknown as JsonObject,
        output: tool.output as unknown as JsonObject,
      },
    },
    deployment,
  );
}

function discoverSkillDirectories(rootPath: string, recursive: boolean, maxDepth: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let identity = dir;
    try {
      identity = realpathSync(dir);
    } catch {
      // non-critical-fallback: Missing realpath support only disables symlink deduplication for this bounded candidate.
      identity = dir;
    }
    if (seen.has(identity)) return;
    seen.add(identity);
    if (existsSync(join(dir, "SKILL.md")) || existsSync(join(dir, "SKILL.md.disabled"))) {
      output.push(dir);
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
      if (!recursive && depth >= 1) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(rootPath, 0);
  return output.sort((left, right) => left.localeCompare(right));
}

function mcpItemFromEntry(
  server: McpServerEntry,
  configPath: string,
  kernelId?: BridgeKernelId,
): ManagedExtensionRecord {
  const usage = server.command
    ? commandUsage({
        command: server.command,
        args: server.args,
        envKeys: server.envKeys,
        parentKind: "mcp",
        parentId: itemId("mcp", server.name),
        kernelId,
        configPath,
        risk: commandRisk(server.command, server.args),
      })
    : undefined;
  const permissions: ExtensionPermission[] = [];
  if (server.command) permissions.push({ type: "shell", values: [server.command] });
  if (server.url) permissions.push({ type: "network", values: [server.url] });
  if (server.envKeys.length) permissions.push({ type: "env", values: server.envKeys });
  return {
    id: itemId("mcp", server.name),
    kind: "mcp",
    name: server.name,
    title: titleFromName(server.name),
    description: server.command
      ? `MCP server launched with ${server.command}.`
      : server.url
        ? `Remote MCP server at ${server.url}.`
        : "MCP server configuration.",
    enabled: true,
    managedByOpenGrove: false,
    readonly: false,
    system: false,
    source: {
      origin: "kernel",
      kernelId,
      path: configPath,
      readonly: false,
      system: false,
    },
    deployments: [],
    permissions,
    commandUsages: usage ? [usage] : [],
    childIds: [],
    tags: ["mcp"],
    metadata: {
      hasEnv: server.envKeys.length > 0,
      ...(server.url ? { url: server.url } : {}),
    },
  };
}

function hookItemFromEntry(hook: HookEntry, configPath: string, kernelId?: BridgeKernelId): ManagedExtensionRecord {
  const usage = hook.command
    ? commandUsage({
        command: hook.command,
        args: hook.args,
        envKeys: hook.envKeys,
        parentKind: "hook",
        parentId: itemId("hook", hook.name),
        kernelId,
        configPath,
        risk: commandRisk(hook.command, hook.args),
      })
    : undefined;
  return {
    id: itemId("hook", hook.name),
    kind: "hook",
    name: hook.name,
    title: hook.event ? `${hook.event}: ${hook.matcher || hook.command || hook.name}` : titleFromName(hook.name),
    description: hook.command ? `Hook command: ${hook.command}` : "Hook configuration.",
    enabled: true,
    managedByOpenGrove: false,
    readonly: false,
    system: false,
    source: {
      origin: "kernel",
      kernelId,
      path: configPath,
      readonly: false,
      system: false,
    },
    deployments: [],
    permissions: hook.command ? [{ type: "shell", values: [hook.command] }] : [],
    commandUsages: usage ? [usage] : [],
    childIds: [],
    tags: ["hook", hook.event ?? ""].filter(Boolean),
    metadata: {
      ...(hook.event ? { event: hook.event } : {}),
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
    },
  };
}

function addItemDeployment(
  accumulator: InventoryAccumulator,
  item: ManagedExtensionRecord,
  deployment: ExtensionDeployment,
): void {
  if (!accumulator.items.has(item.id)) {
    accumulator.items.set(item.id, {
      ...item,
      deployments: [],
      permissions: dedupePermissions(item.permissions),
      commandUsages: uniqueCommandUsages(item.commandUsages),
      childIds: uniqueStrings(item.childIds),
      tags: uniqueStrings(item.tags.filter(Boolean)),
    });
  } else {
    const existing = accumulator.items.get(item.id);
    if (existing) {
      existing.enabled = existing.enabled || item.enabled;
      existing.managedByOpenGrove = existing.managedByOpenGrove || item.managedByOpenGrove;
      existing.readonly = existing.readonly && item.readonly;
      existing.system = existing.system || item.system;
      existing.permissions = dedupePermissions([...existing.permissions, ...item.permissions]);
      existing.commandUsages = uniqueCommandUsages([...existing.commandUsages, ...item.commandUsages]);
      existing.childIds = uniqueStrings([...existing.childIds, ...item.childIds]);
      existing.tags = uniqueStrings([...existing.tags, ...item.tags.filter(Boolean)]);
    }
  }
  if (!accumulator.deployments.some((candidate) => candidate.id === deployment.id)) {
    accumulator.deployments.push(deployment);
  }
}
