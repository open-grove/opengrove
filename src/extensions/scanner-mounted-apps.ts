import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { JsonObject, UserLanguagePreference } from "../core.js";
import { resolveAppManifestPresentation, type AppManifestPresentation } from "../app-builder/manifest-localization.js";
import type { ExtensionDeployment } from "./types.js";
import {
  arrayOfStrings,
  record,
  resolveExecutable,
  stringValue,
  titleFromName,
  uniqueBy,
  uniqueStrings,
} from "./scanner-helpers.js";

export interface MountedAppEntry {
  name: string;
  title: string;
  description: string;
  appRoot: string;
  manifestPath?: string;
  enabled: boolean;
  status: ExtensionDeployment["status"];
  capabilities: string[];
  cli: MountedAppCliDeclaration[];
  presentation: AppManifestPresentation;
  metadata: JsonObject;
}

export interface MountedAppCliDeclaration {
  id: string;
  title: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
  doctor: string[];
  smoke: string[];
  cwd?: string;
  artifacts: string[];
  allowNativeBash: boolean;
  resolvedPath?: string;
  metadata: JsonObject;
}

const MAX_FLOW_SCAN_DEPTH = 8;
const MAX_FLOW_SCAN_ENTRIES = 500;

export function mountedAppEntry(
  mountedApp: { id?: string; path: string; enabled?: boolean; title?: string },
  appRoot: string,
  parseConfig: (path: string, format: string | undefined) => JsonObject | undefined,
  language: UserLanguagePreference = "en",
): MountedAppEntry {
  const exists = existsSync(appRoot);
  const manifest = exists ? findMountedAppManifest(appRoot) : undefined;
  const metadata = manifest ? (parseConfig(manifest, "jsonc") ?? {}) : {};
  const name = stringValue(metadata.id) ?? stringValue(metadata.name) ?? mountedApp.id ?? basename(appRoot);
  const presentation = resolveAppManifestPresentation(metadata as JsonObject, language);
  const cli = exists
    ? parseMountedAppCliDeclarations(metadata as JsonObject, appRoot).map((declaration) => {
        const localized = presentation.cli[declaration.id];
        return {
          ...declaration,
          title: localized?.title || declaration.title,
          description: localized?.description || declaration.description,
        };
      })
    : [];
  const capabilities = exists
    ? uniqueStrings([...discoverMountedAppCapabilities(appRoot), ...(cli.length ? ["cli"] : [])])
    : [];
  const enabled = mountedApp.enabled !== false && exists;
  return {
    name,
    title:
      presentation.title ||
      stringValue(metadata.title) ||
      stringValue(metadata.displayName) ||
      mountedApp.title ||
      titleFromName(name),
    description: presentation.description || "",
    appRoot,
    manifestPath: manifest,
    enabled,
    status: !exists ? "missing" : mountedApp.enabled === false ? "disabled" : "enabled",
    capabilities,
    cli,
    presentation,
    metadata: metadata as JsonObject,
  };
}

function findMountedAppManifest(appRoot: string): string | undefined {
  for (const candidate of ["opengrove.app.json", "opengrove.app.jsonc"]) {
    const path = join(appRoot, candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function discoverMountedAppCapabilities(appRoot: string): string[] {
  const capabilities: string[] = [];
  const directories = [
    ["ui", "ui"],
    ["skills", "skills"],
    ["tools", "tools"],
    ["bin", "bin"],
    ["assets", "assets"],
  ] as const;
  for (const [dirName, capability] of directories) {
    if (existsSync(join(appRoot, dirName))) capabilities.push(capability);
  }
  if (existsSync(join(appRoot, "mcp.json"))) capabilities.push("mcp");
  if (existsSync(join(appRoot, "hooks.json"))) capabilities.push("hooks");
  if (hasFlowFiles(join(appRoot, "workspace"))) capabilities.push("flows");
  return capabilities;
}

function hasFlowFiles(root: string, depth = 0, state: { visited: number } = { visited: 0 }): boolean {
  if (!existsSync(root)) return false;
  if (depth > MAX_FLOW_SCAN_DEPTH || state.visited >= MAX_FLOW_SCAN_ENTRIES) return false;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    state.visited += 1;
    if (state.visited > MAX_FLOW_SCAN_ENTRIES) return false;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory() && hasFlowFiles(path, depth + 1, state)) return true;
    if (entry.isFile() && /\.flow\.md$/i.test(entry.name)) return true;
  }
  return false;
}

function parseMountedAppCliDeclarations(manifest: JsonObject, appRoot: string): MountedAppCliDeclaration[] {
  const capabilities = record(manifest.capabilities);
  const rawDeclarations = Array.isArray(capabilities.cli)
    ? capabilities.cli
    : Array.isArray(manifest.cli)
      ? manifest.cli
      : [];
  return uniqueBy(
    rawDeclarations
      .map((value) => parseMountedAppCliDeclaration(value, appRoot))
      .filter((value): value is MountedAppCliDeclaration => Boolean(value)),
    (value) => value.id,
  );
}

function parseMountedAppCliDeclaration(value: unknown, appRoot: string): MountedAppCliDeclaration | undefined {
  if (typeof value === "string") {
    const command = resolveMountedAppCommand(appRoot, value);
    const id = basename(value).replace(/\.[^.]+$/, "") || value;
    return {
      id,
      title: titleFromName(id),
      description: "",
      command,
      args: [],
      envKeys: [],
      doctor: [],
      smoke: [],
      artifacts: [],
      allowNativeBash: true,
      resolvedPath: resolveExecutable(command),
      metadata: { id, command: value },
    };
  }

  const declaration = record(value);
  const declaredCommand =
    stringValue(declaration.command) ??
    stringValue(declaration.path) ??
    stringValue(declaration.bin) ??
    stringValue(declaration.id) ??
    stringValue(declaration.name);
  if (!declaredCommand) return undefined;

  const command = resolveMountedAppCommand(appRoot, declaredCommand);
  const id =
    stringValue(declaration.id) ??
    stringValue(declaration.name) ??
    basename(declaredCommand).replace(/\.[^.]+$/, "") ??
    declaredCommand;
  return {
    id,
    title: stringValue(declaration.title) ?? stringValue(declaration.displayName) ?? titleFromName(id),
    description: stringValue(declaration.description) ?? "",
    command,
    args: arrayOfStrings(declaration.args),
    envKeys: uniqueStrings([
      ...arrayOfStrings(declaration.env),
      ...arrayOfStrings(declaration.envKeys),
      ...arrayOfStrings(declaration.env_keys),
    ]),
    doctor: commandTokens(declaration.doctor),
    smoke: commandTokens(declaration.smoke),
    cwd: resolveMountedAppOptionalPath(appRoot, stringValue(declaration.cwd)),
    artifacts: arrayOfStrings(declaration.artifacts ?? declaration.outputs),
    allowNativeBash: declaration.allowNativeBash !== false && declaration.allow_native_bash !== false,
    resolvedPath: resolveExecutable(command),
    metadata: declaration as JsonObject,
  };
}

function resolveMountedAppCommand(appRoot: string, command: string): string {
  const value = command.trim();
  if (!value) return value;
  if (isAbsolute(value)) return value;
  if (value.startsWith(".") || value.includes("/")) return resolve(appRoot, value);
  const appBinCommand = join(appRoot, "bin", value);
  return existsSync(appBinCommand) ? appBinCommand : value;
}

function resolveMountedAppOptionalPath(appRoot: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(appRoot, path);
}

function commandTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}
