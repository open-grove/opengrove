import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { JsonObject } from "../core.js";
import { APP_MANAGED_BY, APP_NATIVE_SKILL_MARKER_FILE } from "../identity.js";
import { openLocalPath } from "../local-path-actions.js";
import type { BridgeKernelId, BridgeState } from "../server/bridge-types.js";
import { bridgeDataPath } from "../server/storage-paths.js";
import { collectKernelExtensionLayouts, preferredSkillTargetRoot } from "./kernel-roots.js";
import { extractHookEntries, extractMcpServers, parseJsonLikeConfig, scanExtensionInventory } from "./scanner.js";
import { loadExtensionManagerState, saveExtensionManagerState } from "./state.js";
import type {
  DisabledExtensionConfigRecord,
  ExtensionActionResult,
  ExtensionDeployment,
  ExtensionKind,
  ExtensionScope,
  ManagedSkillLibraryRecord,
} from "./types.js";

export interface ImportSkillInput {
  sourcePath?: string;
  deploymentId?: string;
  itemId?: string;
  name?: string;
  replace?: boolean;
}

export interface PublishSkillInput {
  librarySkillId?: string;
  sourcePath?: string;
  deploymentId?: string;
  itemId?: string;
  name?: string;
  targetKernelIds?: BridgeKernelId[];
  scope?: "user" | "project";
  replace?: boolean;
}

export interface RepublishSkillInput {
  deploymentIds?: string[];
  itemId?: string;
  name?: string;
  targetKernelIds?: BridgeKernelId[];
}

export interface UnpublishSkillInput {
  deploymentIds?: string[];
  itemId?: string;
  name?: string;
  targetKernelIds?: BridgeKernelId[];
  forceExternal?: boolean;
  deleteLibrary?: boolean;
}

export interface SetDeploymentEnabledInput {
  deploymentIds?: string[];
  itemId?: string;
  kind?: ExtensionKind;
  enabled: boolean;
  forceExternal?: boolean;
  reason?: string;
}

export interface DeleteDeploymentInput {
  deploymentIds?: string[];
  itemId?: string;
  kind?: ExtensionKind;
  forceExternal?: boolean;
  deleteLibrary?: boolean;
}

export interface OpenLocalPathResult {
  ok: boolean;
  action: "extension.openLocalPath";
  requestedPath: string;
  openedPath?: string;
  warnings: string[];
}

export function importSkillToLibrary(state: BridgeState, input: ImportSkillInput): ExtensionActionResult {
  const warnings: string[] = [];
  const sourceRoot = resolveSkillSourceRoot(state, input, true);
  if (!sourceRoot) {
    return failed("skill.import", "skill_source_not_found");
  }
  const parsed = parseSkillBasics(sourceRoot, input.name);
  const name = safeName(input.name || parsed.name || basename(sourceRoot));
  const targetRoot = join(bridgeDataPath(state, "extensions", "skills"), name);
  if (existsSync(targetRoot) && !input.replace) {
    return failed("skill.import", `library_skill_exists:${name}`);
  }

  mkdirSync(dirname(targetRoot), { recursive: true });
  rmSync(targetRoot, { recursive: true, force: true });
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });
  const now = new Date().toISOString();
  writeFileSync(
    join(targetRoot, ".opengrove-skill-origin.json"),
    `${JSON.stringify(
      {
        managedBy: APP_MANAGED_BY,
        sourceRoot,
        importedAt: now,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const managerState = loadExtensionManagerState(state);
  const existing = managerState.skillLibrary[name];
  const record: ManagedSkillLibraryRecord = {
    id: name,
    name,
    title: parsed.title,
    description: parsed.description,
    sourceRoot: targetRoot,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    origin: {
      origin: "local",
      path: sourceRoot,
      readonly: false,
      system: false,
    },
  };
  managerState.skillLibrary[name] = record;
  saveExtensionManagerState(state, managerState);

  const deployment: ExtensionDeployment = {
    id: deploymentId("skill", undefined, targetRoot, name),
    itemId: itemId("skill", name),
    kind: "skill",
    scope: "managed",
    status: "unpublished",
    enabled: true,
    managedByOpenGrove: true,
    readonly: false,
    system: false,
    sourcePath: targetRoot,
    targetPath: targetRoot,
    metadata: { libraryId: name },
  };
  return { ok: true, action: "skill.import", records: [deployment], warnings };
}

export async function openExtensionLocalPath(path: string | undefined): Promise<OpenLocalPathResult> {
  const requestedPath = typeof path === "string" ? path.trim() : "";
  if (!requestedPath) {
    return { ok: false, action: "extension.openLocalPath", requestedPath, warnings: ["local_path_missing"] };
  }
  const targetPath = resolve(requestedPath);
  const folderPath = resolveOpenableFolder(targetPath);
  if (!folderPath) {
    return {
      ok: false,
      action: "extension.openLocalPath",
      requestedPath,
      warnings: [`local_path_not_found:${requestedPath}`],
    };
  }
  try {
    await openLocalPath(folderPath, "system");
    return { ok: true, action: "extension.openLocalPath", requestedPath, openedPath: folderPath, warnings: [] };
  } catch (error) {
    return {
      ok: false,
      action: "extension.openLocalPath",
      requestedPath,
      openedPath: folderPath,
      warnings: [`open_failed:${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function publishSkillToKernels(state: BridgeState, input: PublishSkillInput): ExtensionActionResult {
  const warnings: string[] = [];
  const sourceRoot = resolveSkillSourceRoot(state, input, true);
  if (!sourceRoot) {
    return failed("skill.publish", "skill_source_not_found");
  }
  const parsed = parseSkillBasics(sourceRoot, input.name);
  const name = safeName(input.name || parsed.name || basename(sourceRoot));
  const targetKernelIds = input.targetKernelIds?.length
    ? input.targetKernelIds
    : collectKernelExtensionLayouts(state).map((layout) => layout.kernelId);
  const scope = input.scope ?? "user";
  const records: ExtensionDeployment[] = [];

  for (const kernelId of targetKernelIds) {
    const targetRoot = preferredSkillTargetRoot(state, kernelId, scope);
    if (!targetRoot) {
      warnings.push(`${kernelId}:skill_target_not_configured`);
      continue;
    }
    const targetSkillRoot = join(targetRoot.path, name);
    if (samePath(sourceRoot, targetSkillRoot)) {
      warnings.push(`${kernelId}:source_already_in_target`);
      records.push(skillDeploymentRecord(kernelId, targetSkillRoot, name, targetRoot.scope, true));
      continue;
    }
    if (existsSync(targetSkillRoot) && !input.replace && !isOpenGroveManagedSkill(targetSkillRoot)) {
      warnings.push(`${kernelId}:target_exists_without_opengrove_marker:${targetSkillRoot}`);
      continue;
    }
    mkdirSync(dirname(targetSkillRoot), { recursive: true });
    rmSync(targetSkillRoot, { recursive: true, force: true });
    cpSync(sourceRoot, targetSkillRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
      filter(source) {
        return !source.endsWith(APP_NATIVE_SKILL_MARKER_FILE) && !source.endsWith(".opengrove-skill-origin.json");
      },
    });
    writeFileSync(
      join(targetSkillRoot, APP_NATIVE_SKILL_MARKER_FILE),
      `${JSON.stringify(
        {
          managedBy: APP_MANAGED_BY,
          kernelId,
          sourceRoot,
          skillName: name,
          publishedAt: new Date().toISOString(),
          targetReason: targetRoot.reason,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    records.push(skillDeploymentRecord(kernelId, targetSkillRoot, name, targetRoot.scope, true));
  }

  return { ok: true, action: "skill.publish", records, warnings };
}

export function republishSkillDeployments(state: BridgeState, input: RepublishSkillInput): ExtensionActionResult {
  const warnings: string[] = [];
  const records: ExtensionDeployment[] = [];
  if (!input.deploymentIds?.length && !input.itemId && !input.name && !input.targetKernelIds?.length) {
    return { ok: true, action: "skill.republish", records, warnings: ["skill_republish_no_targets"] };
  }
  const targets = resolveDeployments(state, {
    deploymentIds: input.deploymentIds,
    itemId: input.itemId,
    kind: "skill",
    name: input.name,
    targetKernelIds: input.targetKernelIds,
    includeSystem: false,
  });

  for (const deployment of targets) {
    const targetPath = deployment.targetPath ?? deployment.sourcePath;
    const kernelId = deployment.kernelId;
    const sourceRoot = normalizeSkillRoot(stringValue(deployment.metadata?.managedSourceRoot));
    if (!deployment.managedByOpenGrove) {
      warnings.push(`${deployment.id}:external_skill_not_republished`);
      continue;
    }
    if (deployment.readonly || deployment.system) {
      warnings.push(`${deployment.id}:readonly_skill_not_republished`);
      continue;
    }
    if (!kernelId) {
      warnings.push(`${deployment.id}:kernel_id_missing`);
      continue;
    }
    if (!targetPath) {
      warnings.push(`${deployment.id}:target_path_missing`);
      continue;
    }
    if (!sourceRoot) {
      warnings.push(`${deployment.id}:managed_source_missing`);
      continue;
    }
    if (samePath(sourceRoot, targetPath)) {
      warnings.push(`${deployment.id}:source_already_in_target`);
      records.push(skillDeploymentRecord(kernelId, targetPath, basename(targetPath), deployment.scope, true));
      continue;
    }

    const parsed = parseSkillBasics(sourceRoot, input.name);
    const name = safeName(input.name || parsed.name || basename(sourceRoot));
    mkdirSync(dirname(targetPath), { recursive: true });
    rmSync(targetPath, { recursive: true, force: true });
    cpSync(sourceRoot, targetPath, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
      filter(source) {
        return !source.endsWith(APP_NATIVE_SKILL_MARKER_FILE) && !source.endsWith(".opengrove-skill-origin.json");
      },
    });
    writeFileSync(
      join(targetPath, APP_NATIVE_SKILL_MARKER_FILE),
      `${JSON.stringify(
        {
          managedBy: APP_MANAGED_BY,
          kernelId,
          sourceRoot,
          skillName: name,
          republishedAt: new Date().toISOString(),
          targetReason: stringValue(deployment.metadata?.reason) ?? deployment.reason ?? "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    records.push(skillDeploymentRecord(kernelId, targetPath, name, deployment.scope, true));
  }

  return { ok: true, action: "skill.republish", records, warnings };
}

export function unpublishSkillFromKernels(state: BridgeState, input: UnpublishSkillInput): ExtensionActionResult {
  const warnings: string[] = [];
  const records: ExtensionDeployment[] = [];
  const targets = resolveDeployments(state, {
    deploymentIds: input.deploymentIds,
    itemId: input.itemId,
    kind: "skill",
    name: input.name,
    targetKernelIds: input.targetKernelIds,
    includeSystem: true,
  });

  for (const deployment of targets) {
    const targetPath = deployment.targetPath ?? deployment.sourcePath;
    if (!targetPath) {
      warnings.push(`${deployment.id}:target_path_missing`);
      continue;
    }
    if (!deployment.managedByOpenGrove && !input.forceExternal) {
      warnings.push(`${deployment.id}:external_skill_not_removed_without_force`);
      continue;
    }
    if (!existsSync(targetPath)) {
      warnings.push(`${deployment.id}:target_path_already_missing`);
      records.push({ ...deployment, enabled: false, status: "missing" });
      continue;
    }
    moveToTrash(state, targetPath, "skill");
    records.push({ ...deployment, enabled: false, status: "unpublished" });
  }

  if (input.deleteLibrary) {
    const managerState = loadExtensionManagerState(state);
    const key = input.name ? safeName(input.name) : input.itemId?.replace(/^skill\./, "");
    if (key && managerState.skillLibrary[key]) {
      moveToTrash(state, managerState.skillLibrary[key].sourceRoot, "skill-library");
      delete managerState.skillLibrary[key];
      saveExtensionManagerState(state, managerState);
    }
  }

  return { ok: true, action: "skill.unpublish", records, warnings };
}

export function setDeploymentEnabled(state: BridgeState, input: SetDeploymentEnabledInput): ExtensionActionResult {
  const warnings: string[] = [];
  const records: ExtensionDeployment[] = [];
  const deployments = resolveDeployments(state, {
    deploymentIds: input.deploymentIds,
    itemId: input.itemId,
    kind: input.kind,
    includeSystem: true,
  });
  const managerState = loadExtensionManagerState(state);

  for (const deployment of deployments) {
    if ((deployment.readonly || deployment.system) && !input.forceExternal) {
      warnings.push(`${deployment.id}:readonly_or_system_not_modified`);
      continue;
    }
    if (deployment.kind === "skill") {
      const changed = setSkillEnabled(deployment, input.enabled, warnings);
      if (changed) {
        if (input.enabled) {
          delete managerState.disabledOverlays[deployment.id];
        } else {
          managerState.disabledOverlays[deployment.id] = {
            disabledAt: new Date().toISOString(),
            reason: input.reason,
          };
        }
        records.push({ ...deployment, enabled: input.enabled, status: input.enabled ? "enabled" : "disabled" });
      }
      continue;
    }
    if (deployment.kind === "plugin") {
      const changed = setPluginEnabled(deployment, input.enabled, warnings);
      if (changed) {
        records.push({ ...deployment, enabled: input.enabled, status: input.enabled ? "enabled" : "disabled" });
      }
      continue;
    }
    if (deployment.kind === "mcp" || deployment.kind === "hook") {
      const changed = setConfigDeploymentEnabled(managerState, deployment, input.enabled, warnings);
      if (changed) {
        records.push({ ...deployment, enabled: input.enabled, status: input.enabled ? "enabled" : "disabled" });
      }
      continue;
    }
    warnings.push(`${deployment.id}:${deployment.kind}_enable_disable_not_supported`);
  }

  saveExtensionManagerState(state, managerState);
  return { ok: true, action: input.enabled ? "deployment.enable" : "deployment.disable", records, warnings };
}

export function deleteDeployments(state: BridgeState, input: DeleteDeploymentInput): ExtensionActionResult {
  const warnings: string[] = [];
  const records: ExtensionDeployment[] = [];
  const deployments = resolveDeployments(state, {
    deploymentIds: input.deploymentIds,
    itemId: input.itemId,
    kind: input.kind,
    includeSystem: true,
  });
  const managerState = loadExtensionManagerState(state);

  for (const deployment of deployments) {
    if ((deployment.readonly || deployment.system || !deployment.managedByOpenGrove) && !input.forceExternal) {
      warnings.push(`${deployment.id}:not_deleted_without_force`);
      continue;
    }
    if (deployment.kind === "skill" || deployment.kind === "plugin") {
      const target = deployment.targetPath ?? deployment.sourcePath;
      if (!target) {
        warnings.push(`${deployment.id}:target_path_missing`);
        continue;
      }
      if (!existsSync(target)) {
        warnings.push(`${deployment.id}:target_path_already_missing`);
        records.push({ ...deployment, enabled: false, status: "missing" });
        continue;
      }
      moveToTrash(state, target, deployment.kind);
      records.push({ ...deployment, enabled: false, status: "missing" });
      continue;
    }
    if (deployment.kind === "mcp" || deployment.kind === "hook") {
      const changed = setConfigDeploymentEnabled(managerState, deployment, false, warnings);
      if (changed) {
        delete managerState.disabledConfigs[deployment.id];
        records.push({ ...deployment, enabled: false, status: "missing" });
      }
      continue;
    }
    warnings.push(`${deployment.id}:${deployment.kind}_delete_not_supported`);
  }

  if (input.deleteLibrary) {
    const key = input.itemId?.replace(/^skill\./, "");
    if (key && managerState.skillLibrary[key]) {
      moveToTrash(state, managerState.skillLibrary[key].sourceRoot, "skill-library");
      delete managerState.skillLibrary[key];
    }
  }

  saveExtensionManagerState(state, managerState);
  return { ok: true, action: "deployment.delete", records, warnings };
}

function resolveSkillSourceRoot(
  state: BridgeState,
  input: Pick<ImportSkillInput & PublishSkillInput, "sourcePath" | "deploymentId" | "itemId" | "librarySkillId">,
  includeLibrary: boolean,
): string | undefined {
  if (input.sourcePath) {
    return normalizeSkillRoot(input.sourcePath);
  }
  if (includeLibrary && input.librarySkillId) {
    const managerState = loadExtensionManagerState(state);
    return normalizeSkillRoot(managerState.skillLibrary[input.librarySkillId]?.sourceRoot);
  }
  const inventory = scanExtensionInventory(state, { includeSystem: true });
  const deployment = input.deploymentId
    ? inventory.deployments.find((candidate) => candidate.id === input.deploymentId)
    : input.itemId
      ? inventory.deployments.find((candidate) => candidate.itemId === input.itemId && candidate.kind === "skill")
      : undefined;
  return (
    normalizeSkillRoot(stringValue(deployment?.metadata?.managedSourceRoot)) ??
    normalizeSkillRoot(deployment?.targetPath ?? deployment?.sourcePath)
  );
}

function resolveDeployments(
  state: BridgeState,
  options: {
    deploymentIds?: string[];
    itemId?: string;
    kind?: ExtensionKind;
    name?: string;
    targetKernelIds?: BridgeKernelId[];
    includeSystem?: boolean;
  },
): ExtensionDeployment[] {
  const inventory = scanExtensionInventory(state, { includeSystem: options.includeSystem });
  const idSet = new Set(options.deploymentIds ?? []);
  return inventory.deployments.filter((deployment) => {
    if (idSet.size && !idSet.has(deployment.id)) return false;
    if (options.itemId && deployment.itemId !== options.itemId) return false;
    if (options.kind && deployment.kind !== options.kind) return false;
    if (options.name && deployment.itemId !== itemId(options.kind ?? deployment.kind, options.name)) return false;
    if (
      options.targetKernelIds?.length &&
      (!deployment.kernelId || !options.targetKernelIds.includes(deployment.kernelId))
    )
      return false;
    return idSet.size > 0 || options.itemId || options.kind || options.name || options.targetKernelIds?.length;
  });
}

function setSkillEnabled(deployment: ExtensionDeployment, enabled: boolean, warnings: string[]): boolean {
  const root = deployment.targetPath ?? deployment.sourcePath;
  if (!root) {
    warnings.push(`${deployment.id}:skill_root_missing`);
    return false;
  }
  const enabledPath = join(root, "SKILL.md");
  const disabledPath = join(root, "SKILL.md.disabled");
  if (enabled) {
    if (existsSync(enabledPath)) return true;
    if (!existsSync(disabledPath)) {
      warnings.push(`${deployment.id}:disabled_skill_file_missing`);
      return false;
    }
    renameSync(disabledPath, enabledPath);
    return true;
  }
  if (existsSync(disabledPath)) return true;
  if (!existsSync(enabledPath)) {
    warnings.push(`${deployment.id}:skill_file_missing`);
    return false;
  }
  renameSync(enabledPath, disabledPath);
  return true;
}

function setPluginEnabled(deployment: ExtensionDeployment, enabled: boolean, warnings: string[]): boolean {
  const manifestPath = stringValue(deployment.metadata?.manifestPath) ?? deployment.sourcePath;
  if (!manifestPath) {
    warnings.push(`${deployment.id}:plugin_manifest_missing`);
    return false;
  }
  if (enabled) {
    const disabledPath = manifestPath.endsWith(".disabled") ? manifestPath : `${manifestPath}.disabled`;
    const enabledPath = disabledPath.replace(/\.disabled$/, "");
    if (existsSync(enabledPath)) return true;
    if (!existsSync(disabledPath)) {
      warnings.push(`${deployment.id}:disabled_plugin_manifest_missing`);
      return false;
    }
    renameSync(disabledPath, enabledPath);
    return true;
  }
  const enabledPath = manifestPath.endsWith(".disabled") ? manifestPath.replace(/\.disabled$/, "") : manifestPath;
  const disabledPath = `${enabledPath}.disabled`;
  if (existsSync(disabledPath)) return true;
  if (!existsSync(enabledPath)) {
    warnings.push(`${deployment.id}:plugin_manifest_missing`);
    return false;
  }
  renameSync(enabledPath, disabledPath);
  return true;
}

function setConfigDeploymentEnabled(
  managerState: ReturnType<typeof loadExtensionManagerState>,
  deployment: ExtensionDeployment,
  enabled: boolean,
  warnings: string[],
): boolean {
  if (!deployment.configPath || !deployment.configFormat) {
    warnings.push(`${deployment.id}:config_path_missing`);
    return false;
  }
  if (enabled) {
    const disabled = managerState.disabledConfigs[deployment.id];
    if (!disabled) {
      return true;
    }
    const restored = restoreConfigEntry(disabled, warnings);
    if (restored) delete managerState.disabledConfigs[deployment.id];
    return restored;
  }
  if (managerState.disabledConfigs[deployment.id]) {
    return true;
  }
  const disabled = removeConfigEntry(deployment, warnings);
  if (!disabled) return false;
  managerState.disabledConfigs[deployment.id] = disabled;
  return true;
}

function removeConfigEntry(
  deployment: ExtensionDeployment,
  warnings: string[],
): DisabledExtensionConfigRecord | undefined {
  const kind = deployment.kind === "mcp" || deployment.kind === "hook" ? deployment.kind : undefined;
  if (!kind || !deployment.configPath || !deployment.configFormat) return undefined;
  if (deployment.configFormat === "toml") {
    if (kind !== "mcp") {
      warnings.push(`${deployment.id}:toml_hook_disable_not_supported`);
      return undefined;
    }
    return removeTomlMcpEntry(deployment, warnings);
  }
  const config = parseJsonLikeConfig(deployment.configPath, deployment.configFormat);
  if (!config) {
    warnings.push(`${deployment.id}:config_parse_failed`);
    return undefined;
  }
  const removed = kind === "mcp" ? removeMcpFromJson(config, deployment) : removeHookFromJson(config, deployment);
  if (!removed) {
    warnings.push(`${deployment.id}:config_entry_not_found`);
    return undefined;
  }
  writeJsonConfig(deployment.configPath, config);
  return {
    id: deployment.id,
    kind,
    kernelId: deployment.kernelId,
    name: deployment.itemId.replace(`${kind}.`, ""),
    configPath: deployment.configPath,
    configFormat: deployment.configFormat,
    redacted: false,
    entry: removed,
    disabledAt: new Date().toISOString(),
  };
}

function restoreConfigEntry(disabled: DisabledExtensionConfigRecord, warnings: string[]): boolean {
  if (disabled.configFormat === "toml") {
    if (disabled.kind !== "mcp") return false;
    const text = existsSync(disabled.configPath) ? readFileSync(disabled.configPath, "utf8") : "";
    const command = stringValue(disabled.entry.command);
    const args = arrayOfStrings(disabled.entry.args);
    const env = record(disabled.entry.env);
    const lines = [
      text.trimEnd(),
      "",
      `[mcp_servers.${disabled.name}]`,
      command ? `command = ${JSON.stringify(command)}` : "",
      args.length ? `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]` : "",
      Object.keys(env).length ? `[mcp_servers.${disabled.name}.env]` : "",
      ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`),
      "",
    ].filter((line, index) => index === 0 || line !== "");
    mkdirSync(dirname(disabled.configPath), { recursive: true });
    writeFileSync(disabled.configPath, `${lines.join("\n")}\n`, "utf8");
    return true;
  }
  const config = parseJsonLikeConfig(disabled.configPath, disabled.configFormat) ?? {};
  if (disabled.kind === "mcp") {
    const container = ensureMcpContainer(config);
    container[disabled.name] = disabled.entry;
  } else {
    const hooks = ensureHooksContainer(config);
    const event = stringValue(disabled.entry.event) || "UserPromptSubmit";
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...existing, disabled.entry];
  }
  try {
    writeJsonConfig(disabled.configPath, config);
    return true;
  } catch (error) {
    warnings.push(`${disabled.id}:${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function removeMcpFromJson(config: JsonObject, deployment: ExtensionDeployment): JsonObject | undefined {
  const name = deployment.itemId.replace(/^mcp\./, "");
  const containers = findMcpContainers(config);
  for (const container of containers) {
    for (const [key, value] of Object.entries(container)) {
      if (safeName(key) === name) {
        delete container[key];
        return record(value) as JsonObject;
      }
    }
  }
  const server = extractMcpServers(config).find((entry) => itemId("mcp", entry.name) === deployment.itemId);
  return server?.entry;
}

function removeHookFromJson(config: JsonObject, deployment: ExtensionDeployment): JsonObject | undefined {
  const hooks = record(config.hooks);
  if (Object.keys(hooks).length) {
    for (const [event, rawEntries] of Object.entries(hooks)) {
      if (!Array.isArray(rawEntries)) continue;
      const kept: unknown[] = [];
      let removed: JsonObject | undefined;
      for (const rawEntry of rawEntries) {
        const entry = record(rawEntry);
        const nested = Array.isArray(entry.hooks) ? entry.hooks : [entry];
        const shouldRemove = nested.some((rawNested) => {
          const nestedEntry = record(rawNested);
          const command = stringValue(nestedEntry.command) ?? stringValue(nestedEntry.cmd);
          const name = safeName([event, stringValue(entry.matcher) ?? "all", command ?? ""].join("-"));
          return itemId("hook", name) === deployment.itemId;
        });
        if (shouldRemove) {
          removed = { ...entry, event } as JsonObject;
        } else {
          kept.push(rawEntry);
        }
      }
      hooks[event] = kept as JsonObject[];
      if (removed) return removed;
    }
  }
  const hook = extractHookEntries(config).find((entry) => itemId("hook", entry.name) === deployment.itemId);
  return hook?.entry;
}

function removeTomlMcpEntry(
  deployment: ExtensionDeployment,
  warnings: string[],
): DisabledExtensionConfigRecord | undefined {
  if (!deployment.configPath) return undefined;
  const text = existsSync(deployment.configPath) ? readFileSync(deployment.configPath, "utf8") : "";
  const config = parseJsonLikeConfig(deployment.configPath, "toml") ?? {};
  const server = extractMcpServers(config).find((entry) => itemId("mcp", entry.name) === deployment.itemId);
  if (!server) {
    warnings.push(`${deployment.id}:toml_mcp_entry_not_found`);
    return undefined;
  }
  const escaped = escapeRegExp(server.name);
  const lines = text.split(/\r?\n/g);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/);
    if (section) {
      skipping = new RegExp(`^mcp_servers\\.${escaped}(\\.|$)`).test(section[1] ?? "");
    }
    if (!skipping) kept.push(line);
  }
  writeFileSync(deployment.configPath, `${kept.join("\n").trimEnd()}\n`, "utf8");
  return {
    id: deployment.id,
    kind: "mcp",
    kernelId: deployment.kernelId,
    name: server.name,
    configPath: deployment.configPath,
    configFormat: "toml",
    redacted: false,
    entry: server.entry,
    disabledAt: new Date().toISOString(),
  };
}

function findMcpContainers(config: JsonObject): Record<string, unknown>[] {
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
  return containers;
}

function ensureMcpContainer(config: JsonObject): Record<string, unknown> {
  const existing = record(config.mcpServers);
  if (Object.keys(existing).length) return existing;
  config.mcpServers = {} as JsonObject;
  return config.mcpServers as Record<string, unknown>;
}

function ensureHooksContainer(config: JsonObject): Record<string, unknown> {
  const existing = record(config.hooks);
  if (Object.keys(existing).length) return existing;
  config.hooks = {} as JsonObject;
  return config.hooks as Record<string, unknown>;
}

function writeJsonConfig(path: string, config: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function normalizeSkillRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const resolved = resolve(path);
  if (existsSync(join(resolved, "SKILL.md")) || existsSync(join(resolved, "SKILL.md.disabled"))) {
    return resolved;
  }
  if (basename(resolved) === "SKILL.md" || basename(resolved) === "SKILL.md.disabled") {
    return dirname(resolved);
  }
  return undefined;
}

function parseSkillBasics(
  skillRoot: string,
  fallbackName?: string,
): { name: string; title: string; description: string } {
  const skillFile = existsSync(join(skillRoot, "SKILL.md"))
    ? join(skillRoot, "SKILL.md")
    : join(skillRoot, "SKILL.md.disabled");
  const name = fallbackName || basename(skillRoot);
  try {
    const text = readFileSync(skillFile, "utf8");
    const frontmatter = parseFrontmatterObject(text);
    return {
      name: stringValue(frontmatter.name) || name,
      title: stringValue(frontmatter.title) || titleFromName(name),
      description: stringValue(frontmatter.description) || "",
    };
  } catch {
    return { name, title: titleFromName(name), description: "" };
  }
}

function parseFrontmatterObject(markdown: string): Record<string, unknown> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex < 0) return {};
  const result: Record<string, unknown> = {};
  for (const rawLine of normalized.slice(4, closingIndex).split("\n")) {
    const separator = rawLine.indexOf(":");
    if (separator < 0) continue;
    const key = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (key && value) result[key] = stripQuotes(value);
  }
  return result;
}

function isOpenGroveManagedSkill(skillRoot: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(skillRoot, APP_NATIVE_SKILL_MARKER_FILE), "utf8")) as {
      managedBy?: string;
    };
    return marker.managedBy === APP_MANAGED_BY;
  } catch {
    return false;
  }
}

function resolveOpenableFolder(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? path : dirname(path);
  } catch {
    try {
      const parent = dirname(path);
      return statSync(parent).isDirectory() ? parent : undefined;
    } catch {
      return undefined;
    }
  }
}

function skillDeploymentRecord(
  kernelId: BridgeKernelId,
  targetSkillRoot: string,
  name: string,
  scope: ExtensionScope,
  enabled: boolean,
): ExtensionDeployment {
  return {
    id: deploymentId("skill", kernelId, targetSkillRoot, name),
    itemId: itemId("skill", name),
    kind: "skill",
    kernelId,
    scope,
    status: enabled ? "enabled" : "disabled",
    enabled,
    managedByOpenGrove: isOpenGroveManagedSkill(targetSkillRoot),
    readonly: false,
    system: false,
    sourcePath: targetSkillRoot,
    targetPath: targetSkillRoot,
    markerPath: join(targetSkillRoot, APP_NATIVE_SKILL_MARKER_FILE),
  };
}

function moveToTrash(state: BridgeState, targetPath: string, kind: string): string {
  const trashDir = bridgeDataPath(state, "trash", "extensions", timestampSlug());
  mkdirSync(trashDir, { recursive: true });
  const target = join(trashDir, `${kind}-${basename(targetPath)}`);
  rmSync(target, { recursive: true, force: true });
  renameSync(targetPath, target);
  return target;
}

function failed(action: string, warning: string): ExtensionActionResult {
  return { ok: false, action, records: [], warnings: [warning] };
}

function itemId(kind: ExtensionKind, name: string): string {
  return `${kind}.${safeName(name)}`;
}

function deploymentId(kind: ExtensionKind, kernelId: BridgeKernelId | undefined, path: string, name: string): string {
  return `deployment.${kind}.${kernelId ?? "host"}.${safeName(name)}.${hashText(`${path}\n${name}`)}`;
}

function safeName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function arrayOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function titleFromName(name: string): string {
  return name
    .split(/[-_.\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
