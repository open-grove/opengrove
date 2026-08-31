import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { JsonObject, UserLanguagePreference } from "../core.js";
import { hostMessage, type HostMessageCode } from "../localization/host-messages.js";
import { resolveAppManifestPresentation } from "../app-builder/manifest-localization.js";
import { resolveHostCommandPath } from "../environment/command-path.js";
import type { AppStoreEmployeeDoctor, AppStoreEmployeeDoctorItem } from "./app-store.js";
import { findDefaultAppGroupRoom } from "./app-room-ids.js";
import { pmAgentMemberId } from "./bridge-mounted-app-employees.js";
import type { BridgeState } from "./bridge-types.js";
import { normalizeHostSystemLanguage, resolveHostLanguageSettings } from "./language-preference.js";
import { resolveMountedAppTarget } from "./mounted-apps.js";
import { bridgeDataPath } from "./storage-paths.js";
import { safeResolveInside } from "./workspace-store.js";
import { migrateAppWelcomeMarkerV2 } from "./migrations/app-welcome-marker-v2.js";

export type AppReadinessStatus = "ready" | "preparing" | "needs_setup" | "broken";

export type AppReadinessSideEffect =
  | "none"
  | "local-write"
  | "network-read"
  | "user-input"
  | "external-write"
  | "spend"
  | "delete";

export interface AppReadinessFix {
  kind: "none" | "prepare-runtime" | "install-system" | "bind-asset" | "configure-env" | "run-doctor";
  sideEffects: AppReadinessSideEffect[];
  assetId?: string;
  env?: string[];
}

export type AppReadinessItem = Omit<AppStoreEmployeeDoctorItem, "kind"> & {
  kind: AppStoreEmployeeDoctorItem["kind"] | "asset";
  fix?: AppReadinessFix;
};

export interface AppReadinessReport {
  appId: string;
  title: string;
  version?: string;
  computedAt: string;
  status: AppReadinessStatus;
  items: AppReadinessItem[];
  employees: Record<string, AppStoreEmployeeDoctor>;
}

interface StoreRequirements {
  env: string[];
  system: string[];
  runtimes: RuntimeRequirement[];
}

interface RuntimeRequirement {
  id: string;
  version?: string;
  manager?: string;
  requirements: string[];
  packageFiles: string[];
  binEnv?: string;
}

interface AssetDeclaration {
  id: string;
  title: string;
  kind: "directory" | "file";
  required: boolean;
  accept: string[];
  preferredMountPath?: string;
  mountEnv?: string;
  validation: {
    minFiles?: number;
    glob: string[];
  };
}

export function writeAppReadinessReport(state: BridgeState, appId: string): AppReadinessReport {
  const report = computeAppReadinessReport(state, appId);
  const path = appReadinessReportPath(state, report.appId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function queueAppReadinessReport(input: {
  state: BridgeState;
  appId: string;
  notifyPm?: boolean;
  emitActivity?: (activity: {
    text: string;
    level?: "debug" | "info" | "warn" | "error";
    metadata?: Record<string, unknown>;
  }) => void;
}): void {
  void Promise.resolve().then(() => {
    try {
      const report = writeAppReadinessReport(input.state, input.appId);
      input.emitActivity?.({
        text: `${report.title} readiness checked: ${report.status}.`,
        level: report.status === "ready" ? "info" : "warn",
      });
      if (input.notifyPm !== false) {
        notifyPmOfAppReadiness(input.state, report);
      }
    } catch (error) {
      input.emitActivity?.({
        text: `App readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
        level: "warn",
      });
    }
  });
}

export function notifyPmOfAppReadiness(state: BridgeState, report: AppReadinessReport): boolean {
  const room = findDefaultAppGroupRoom(state.app.rooms.listRooms(), report.appId);
  if (!room) return false;
  const roomId = room.id;
  const pmId = pmAgentMemberId(report.appId);
  const pm = state.app.rooms.listMembers().find((member) => member.id === pmId && !member.disabled);
  const language = resolveHostLanguageSettings(state.settings);
  const text = formatPmReadinessMessage(report, language);
  if (pm) {
    state.app.rooms.postAgentMessage({
      roomId,
      senderId: pm.id,
      senderName: pm.displayName || pm.name,
      text,
    });
  } else {
    state.app.rooms.postSystemMessage({
      roomId,
      text,
    });
  }
  const welcomeMessage = resolveAppWelcomeMessage(state, report.appId);
  if (pm && welcomeMessage) {
    migrateAppWelcomeMarkerV2(appWelcomeMarkerPath(state, report.appId), readinessIntroVersion(report), language);
  }
  if (pm && welcomeMessage && shouldPostAppWelcome(state, report, language)) {
    state.app.rooms.postAgentMessage({
      roomId,
      senderId: pm.id,
      senderName: pm.displayName || pm.name,
      text: welcomeMessage,
    });
    markAppWelcomePosted(state, report, language);
  }
  state.store.saveFrom(state.app);
  return true;
}

export function appReadinessReportPath(state: BridgeState, appId: string): string {
  return bridgeDataPath(state, "app-readiness", `${safeFileName(appId)}.json`);
}

function computeAppReadinessReport(state: BridgeState, appId: string): AppReadinessReport {
  const target = resolveMountedAppTarget(state, appId);
  const computedAt = new Date().toISOString();
  if (!target) {
    return {
      appId,
      title: appId,
      computedAt,
      status: "broken",
      items: [
        {
          id: "mounted-app",
          kind: "runtime",
          label: "Mounted App",
          status: "missing",
          detail: "Mounted App not found",
        },
      ],
      employees: {},
    };
  }
  const requirements = readStoreRequirements(target.manifest);
  const presentation = resolveAppManifestPresentation(target.manifest, resolveHostLanguageSettings(state.settings));
  const localSecrets = readLocalSecretEnv(target.appRoot, target.id);
  const assetState = readAssetState(state, target.id);
  const items: AppReadinessItem[] = [
    ...requirements.system.map(systemRequirementItem),
    ...requirements.env.map((envName) => envRequirementItem(envName, localSecrets)),
    ...requirements.runtimes.map((runtime) => runtimeRequirementItem(target.appRoot, runtime)),
    ...readAssetDeclarations(target.manifest).map((asset) => assetRequirementItem(target.appRoot, asset, assetState)),
  ];
  return {
    appId: target.id,
    title: presentation.title || target.title,
    ...(stringValue(target.manifest.version) ? { version: stringValue(target.manifest.version) } : {}),
    computedAt,
    status: readinessStatus(items),
    items,
    employees: {},
  };
}

function systemRequirementItem(command: string): AppReadinessItem {
  const resolved = resolveCommand(command);
  return {
    id: `system:${command}`,
    kind: "cli",
    label: command,
    status: resolved ? "ok" : "missing",
    detail: resolved ? resolved : "System tool not found on PATH",
    ...(resolved
      ? {}
      : {
          fix: {
            kind: "install-system",
            sideEffects: ["user-input"],
          },
        }),
  };
}

function envRequirementItem(envName: string, localSecrets: Record<string, string>): AppReadinessItem {
  const configured = Boolean(process.env[envName]?.trim() || localSecrets[envName]?.trim());
  return {
    id: envName,
    kind: "provider",
    label: envName,
    status: configured ? "ok" : "missing",
    detail: configured ? "Configured locally" : "Not configured in process env or local App secrets",
    ...(configured
      ? {}
      : {
          fix: {
            kind: "configure-env",
            sideEffects: ["user-input"],
            env: [envName],
          },
        }),
  };
}

function runtimeRequirementItem(appRoot: string, runtime: RuntimeRequirement): AppReadinessItem {
  const files = [...runtime.requirements, ...runtime.packageFiles];
  const missingFiles = files
    .map((file) => ({ file, path: safeResolveInside(appRoot, file) }))
    .filter((item) => !item.path || !existsSync(item.path));
  const label = [runtime.id, runtime.version].filter(Boolean).join(" ");
  return {
    id: `runtime:${runtime.id}`,
    kind: "runtime",
    label,
    status: missingFiles.length > 0 ? "missing" : "installable",
    detail:
      missingFiles.length > 0
        ? `Missing runtime declaration files: ${missingFiles.map((item) => item.file).join(", ")}`
        : "Runtime can be prepared after user confirmation",
    fix: {
      kind: "prepare-runtime",
      sideEffects: ["local-write", "network-read"],
    },
  };
}

function assetRequirementItem(
  appRoot: string,
  asset: AssetDeclaration,
  assetState: Record<string, string>,
): AppReadinessItem {
  const configuredPath = assetState[asset.id];
  const preferredPath = asset.preferredMountPath ? safeResolveInside(appRoot, asset.preferredMountPath) : undefined;
  const path = configuredPath || preferredPath;
  const validation = path ? validateAssetPath(path, asset) : { ok: false, detail: "Asset path is not configured" };
  const missingStatus = asset.required ? "missing" : "warning";
  return {
    id: asset.id,
    kind: "asset",
    label: asset.title,
    status: validation.ok ? "ok" : missingStatus,
    detail: validation.detail,
    ...(validation.ok
      ? {}
      : {
          fix: {
            kind: "bind-asset",
            sideEffects: ["user-input"],
            assetId: asset.id,
          },
        }),
  };
}

function validateAssetPath(path: string, asset: AssetDeclaration): { ok: boolean; detail: string } {
  if (!existsSync(path)) return { ok: false, detail: `Asset path not found: ${path}` };
  const stat = statSync(path);
  if (asset.kind === "directory") {
    if (!stat.isDirectory()) return { ok: false, detail: `Expected a directory: ${path}` };
    const count = countAcceptedFiles(path, asset);
    const minFiles = asset.validation.minFiles ?? 1;
    return count >= minFiles
      ? { ok: true, detail: `${path} (${count} accepted files)` }
      : { ok: false, detail: `${path} has ${count} accepted files; needs at least ${minFiles}` };
  }
  if (!stat.isFile()) return { ok: false, detail: `Expected a file: ${path}` };
  return assetMatches(basename(path), asset)
    ? { ok: true, detail: path }
    : { ok: false, detail: `File does not match accepted asset patterns: ${path}` };
}

function countAcceptedFiles(root: string, asset: AssetDeclaration): number {
  const queue = [root];
  let count = 0;
  while (queue.length > 0 && count < 25_000) {
    const current = queue.shift() ?? "";
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // non-critical-fallback: Treat an unreadable subtree as absent and report the required asset as missing.
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() && assetMatches(entry.name, asset)) {
        count += 1;
      }
    }
  }
  return count;
}

function assetMatches(name: string, asset: AssetDeclaration): boolean {
  const candidates = [...asset.accept, ...asset.validation.glob].map((item) => item.trim()).filter(Boolean);
  if (candidates.length === 0) return true;
  const extension = extname(name).toLowerCase();
  return candidates.some((candidate) => {
    const value = candidate.toLowerCase();
    if (value.startsWith(".")) return extension === value;
    if (value.startsWith("*.")) return extension === value.slice(1);
    return name.toLowerCase() === value;
  });
}

function readinessStatus(items: AppReadinessItem[]): AppReadinessStatus {
  if (items.some((item) => item.status === "missing")) return "needs_setup";
  if (items.some((item) => item.status === "installable" || item.status === "warning")) return "needs_setup";
  return "ready";
}

function formatPmReadinessMessage(report: AppReadinessReport, language: UserLanguagePreference): string {
  const blocking = report.items.filter((item) => item.status !== "ok");
  if (blocking.length === 0) {
    return hostMessage(language, "app.readiness.ready", { title: report.title });
  }
  const lines = blocking.slice(0, 8).map((item, index) => `${index + 1}. ${readinessItemText(item, language)}`);
  const more =
    blocking.length > lines.length
      ? hostMessage(language, "app.readiness.more", { count: blocking.length - lines.length })
      : "";
  return [
    hostMessage(language, "app.readiness.not_ready", { title: report.title }),
    "",
    hostMessage(language, "app.readiness.found"),
    ...lines,
    more,
    "",
    hostMessage(language, "app.readiness.safety"),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function resolveAppWelcomeMessage(state: BridgeState, appId: string): string | undefined {
  const target = resolveMountedAppTarget(state, appId);
  if (!target) return undefined;
  return resolveAppManifestPresentation(target.manifest, resolveHostLanguageSettings(state.settings)).welcomeMessage;
}

function shouldPostAppWelcome(
  state: BridgeState,
  report: AppReadinessReport,
  language: UserLanguagePreference,
): boolean {
  if (report.status !== "ready") return false;
  const marker = readAppWelcomeMarker(state, report.appId);
  return marker.version !== readinessIntroVersion(report) || !marker.locales.includes(language);
}

function markAppWelcomePosted(state: BridgeState, report: AppReadinessReport, language: UserLanguagePreference): void {
  const version = readinessIntroVersion(report);
  const previousMarker = readAppWelcomeMarker(state, report.appId);
  const locales = previousMarker.version === version ? [...new Set([...previousMarker.locales, language])] : [language];
  writeAppWelcomeMarker(state, {
    appId: report.appId,
    version,
    locales,
    sentAt: new Date().toISOString(),
  });
}

function writeAppWelcomeMarker(
  state: BridgeState,
  marker: {
    appId: string;
    version: string;
    locales: UserLanguagePreference[];
    sentAt: string;
  },
): void {
  const path = appWelcomeMarkerPath(state, marker.appId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        appId: marker.appId,
        version: marker.version,
        locales: marker.locales,
        sentAt: marker.sentAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function readAppWelcomeMarker(
  state: BridgeState,
  appId: string,
): {
  version?: string;
  locales: UserLanguagePreference[];
  sentAt?: string;
} {
  const path = appWelcomeMarkerPath(state, appId);
  if (!existsSync(path)) return { locales: [] };
  try {
    const marker = recordValue(JSON.parse(readFileSync(path, "utf8")));
    const locales = [
      ...rawStringArray(marker.locales)
        .map((locale) => normalizeHostSystemLanguage(locale))
        .filter((locale): locale is UserLanguagePreference => Boolean(locale)),
    ];
    const version = stringValue(marker.version) || undefined;
    return {
      version,
      locales: [...new Set(locales)],
      sentAt: stringValue(marker.sentAt) || undefined,
    };
  } catch {
    return { locales: [] };
  }
}

function appWelcomeMarkerPath(state: BridgeState, appId: string): string {
  return bridgeDataPath(state, "app-readiness", `${safeFileName(appId)}.pm-intro.json`);
}

function readinessIntroVersion(report: AppReadinessReport): string {
  return report.version || "unknown";
}

function readinessItemText(item: AppReadinessItem, language: UserLanguagePreference): string {
  const code: HostMessageCode =
    item.kind === "asset"
      ? "app.readiness.asset"
      : item.kind === "runtime"
        ? "app.readiness.runtime"
        : item.kind === "cli"
          ? "app.readiness.cli"
          : item.kind === "provider"
            ? "app.readiness.provider"
            : "app.readiness.item";
  return hostMessage(language, code, {
    label: item.label,
    detail: item.detail ?? item.status,
  }).trim();
}

function readStoreRequirements(manifest: JsonObject): StoreRequirements {
  const requirements = recordValue(recordValue(manifest.store).requirements);
  return {
    env: uniqueStrings(rawStringArray(requirements.env)),
    system: uniqueStrings(rawStringArray(requirements.system)),
    runtimes: runtimeRequirements(requirements.runtimes),
  };
}

function runtimeRequirements(value: unknown): RuntimeRequirement[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") {
        return {
          id: item,
          requirements: [],
          packageFiles: [],
        };
      }
      const object = recordValue(item);
      const id = stringValue(object.id);
      if (!id) return undefined;
      return {
        id,
        ...(stringValue(object.version) ? { version: stringValue(object.version) } : {}),
        ...(stringValue(object.manager) ? { manager: stringValue(object.manager) } : {}),
        requirements: rawStringArray(object.requirements),
        packageFiles: rawStringArray(object.packageFiles),
        ...(stringValue(object.binEnv) ? { binEnv: stringValue(object.binEnv) } : {}),
      };
    })
    .filter((item): item is RuntimeRequirement => Boolean(item));
}

function readAssetDeclarations(manifest: JsonObject): AssetDeclaration[] {
  if (!Array.isArray(manifest.assets)) return [];
  return manifest.assets
    .map((item) => {
      const object = recordValue(item);
      const id = stringValue(object.id);
      if (!id) return undefined;
      const validation = recordValue(object.validation);
      return {
        id,
        title: stringValue(object.title) || id,
        kind: object.kind === "file" ? "file" : "directory",
        required: object.required !== false,
        accept: rawStringArray(object.accept),
        ...(stringValue(object.mountEnv) ? { mountEnv: stringValue(object.mountEnv) } : {}),
        ...(stringValue(object.preferredMountPath)
          ? { preferredMountPath: stringValue(object.preferredMountPath) }
          : {}),
        validation: {
          ...(typeof validation.minFiles === "number" && Number.isFinite(validation.minFiles)
            ? { minFiles: Math.max(0, Math.floor(validation.minFiles)) }
            : {}),
          glob: rawStringArray(validation.glob),
        },
      };
    })
    .filter((item): item is AssetDeclaration => Boolean(item));
}

function readAssetState(state: BridgeState, appId: string): Record<string, string> {
  const path = bridgeDataPath(state, "app-assets", `${safeFileName(appId)}.json`);
  if (!existsSync(path)) return {};
  try {
    const parsed = recordValue(JSON.parse(readFileSync(path, "utf8")));
    const assets = recordValue(parsed.assets);
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(assets)) {
      const item = recordValue(value);
      const itemPath = typeof value === "string" ? value : stringValue(item.path);
      if (itemPath) output[key] = resolvePathLike(itemPath);
    }
    return output;
  } catch {
    return {};
  }
}

function readLocalSecretEnv(appRoot: string, appId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const path of localSecretEnvCandidates(appRoot, appId)) {
    if (!existsSync(path)) continue;
    try {
      Object.assign(env, parseEnvFile(readFileSync(path, "utf8")));
    } catch (error) {
      console.warn("app_readiness_secret_env_unreadable", {
        appId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      // non-critical-fallback: An unreadable optional secret file is treated as absent so readiness can report missing env keys.
    }
  }
  return env;
}

function localSecretEnvCandidates(appRoot: string, appId: string): string[] {
  const suffix = envVarSuffix(appId);
  const explicitAppFile = process.env[`OPENGROVE_APP_SECRETS_FILE_${suffix}`]?.trim();
  const explicitFile = process.env.OPENGROVE_APP_SECRETS_FILE?.trim();
  const explicitDir = process.env.OPENGROVE_APP_SECRETS_DIR?.trim();
  return uniqueStrings(
    [
      explicitAppFile,
      explicitFile,
      explicitDir ? join(explicitDir, `${appId}.env`) : "",
      join(homedir(), ".opengrove", "secrets", `${appId}.env`),
      join(appRoot, ".env.local"),
    ].filter((item): item is string => Boolean(item)),
  ).map(resolvePathLike);
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveCommand(command: string): string | undefined {
  const name = command.trim();
  if (!name) return undefined;
  return resolveHostCommandPath(name);
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(homedir());
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

function envVarSuffix(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function rawStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
