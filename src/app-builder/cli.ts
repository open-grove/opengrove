import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { PackageProvenance } from "#agent-protocol";
import { resolveAppCliTargetPath, type AppCliTargetKey, validateAppCliTargetFile } from "./cli-targets.js";
import {
  appCliNodeScriptArgument,
  isAppCliDeclaredPath,
  normalizeAppCliDeclaration,
  resolveAppCliOwnedPath,
} from "./cli-declaration.js";
import {
  findAppManifestPath,
  opengroveAppManifestSchema,
  validateAppManifestFile,
  type OpenGroveAppManifest,
} from "./manifest.js";
import { isFlowMarkdownPath, parseFlowMarkdown } from "./flow.js";
import { ensureAppGitRepo, importProjectAsApp, type ImportProjectOptions } from "./importer.js";
import { ensureAppBuildContract } from "./build-contract-scaffold.js";
export { ensureAppBuildContract } from "./build-contract-scaffold.js";
import { tarCommand } from "../archive/tar-command.js";
import { normalizeAppIconValue } from "../app-icons/icon-value.js";
import { minimalMcpAppHtml } from "./mcp-app-template.js";
import { normalizeMcpAppView, type AppUiSurface } from "./ui-runtime.js";
import { legacyAppUiKind, normalizeCompatibleAppUi } from "./compat/legacy-app-ui.compat.js";
import {
  appStorePublishIdempotencyKey,
  appStorePublishRequestIdempotencyKey,
} from "../app-store-publish-idempotency.js";

const USAGE = `OpenGrove App tools

Usage:
  opengrove app inspect <source>
  opengrove app import <source> [--target DIR | --apps-dir DIR] [--id ID] [--title TITLE] [--force]
  opengrove app stage <source> [--target DIR | --apps-dir DIR] [--id ID] [--copy] [--force]
  opengrove app validate <app-root>
  opengrove app pack <app-root> [--output FILE]
  opengrove app publish <app-root> --registry URL [--token TOKEN]
  opengrove app report <app-root>
  opengrove app scaffold <target> [--id ID] [--title TITLE] [--description TEXT] [--ui-surface SURFACE] [--force]
  opengrove app mount <app-root> [--settings PATH] [--id ID] [--title TITLE] [--disabled]

Commands:
  inspect   Classify a local folder or URL before importing it as an App.
  import    Create a portable App package around a local project folder.
  stage     Put a source into an OpenGrove-managed App directory.
  validate  Validate opengrove.app.json and the basic workspace contract.
  pack      Create a publishable .tgz App package with a file hash manifest.
  publish   Pack and upload an App package to a private OpenGrove registry.
  report    Print a machine-readable import readiness report.
  scaffold  Create a minimal portable App package for an agent to continue.
  mount     Register an App root in bridge settings after validation.
`;

const MAX_FLOW_SCAN_DEPTH = 8;
const MAX_RUNTIME_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_RECEIPT_PATH_REPLACEMENTS = 64;
const LOCAL_BUILD_PATH_PATTERN =
  /^(?:\/(?:Users|home)\/[A-Za-z0-9._-]+\/|\/(?:private\/)?var\/folders\/|\/Volumes\/[^/\s]+\/|[A-Za-z]:\/(?:Users|Documents and Settings)\/[^/\r\n]+\/)/;

export async function runAppBuilderCli(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE.trimEnd());
    return;
  }
  if (command === "inspect") {
    const source = args[1];
    if (!source) throw new Error("opengrove app inspect requires <source>");
    printJson(inspectAppSource(source));
    return;
  }
  if (command === "stage") {
    const source = args[1];
    if (!source) throw new Error("opengrove app stage requires <source>");
    const result = await stageAppSource(source, parseStageOptions(args.slice(2)));
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "import") {
    const source = args[1];
    if (!source) throw new Error("opengrove app import requires <source>");
    const imported = importProjectAsApp(source, parseImportOptions(args.slice(2)));
    printJson({
      ...imported,
      inspect: inspectAppSource(imported.appRoot),
      report: appImportReport(imported.appRoot),
      nextCommands: [
        `opengrove app report ${shellQuote(imported.appRoot)}`,
        `opengrove app mount ${shellQuote(imported.appRoot)}`,
      ],
    });
    return;
  }
  if (command === "validate") {
    const appRoot = args[1];
    if (!appRoot) throw new Error("opengrove app validate requires <app-root>");
    const result = validateAppRoot(resolvePathLike(appRoot));
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "pack") {
    const appRoot = args[1];
    if (!appRoot) throw new Error("opengrove app pack requires <app-root>");
    const result = packApp(resolvePathLike(appRoot), parsePackOptions(args.slice(2)));
    printJson(result);
    return;
  }
  if (command === "publish") {
    const appRoot = args[1];
    if (!appRoot) throw new Error("opengrove app publish requires <app-root>");
    const result = await publishApp(resolvePathLike(appRoot), parsePublishOptions(args.slice(2)));
    printJson(result);
    return;
  }
  if (command === "report") {
    const appRoot = args[1];
    if (!appRoot) throw new Error("opengrove app report requires <app-root>");
    const result = appImportReport(resolvePathLike(appRoot));
    printJson(result);
    if (!result.readyToMount) process.exitCode = 1;
    return;
  }
  if (command === "scaffold") {
    const target = args[1];
    if (!target) throw new Error("opengrove app scaffold requires <target>");
    printJson(scaffoldApp(resolvePathLike(target), parseScaffoldOptions(args.slice(2))));
    return;
  }
  if (command === "mount") {
    const appRoot = args[1];
    if (!appRoot) throw new Error("opengrove app mount requires <app-root>");
    const result = mountAppInSettings(resolvePathLike(appRoot), parseMountOptions(args.slice(2)));
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown app command: ${command}`);
}

export function inspectAppSource(source: string): Record<string, unknown> {
  const kind = classifySourceInput(source);
  if (kind !== "local") {
    return {
      ok: true,
      source,
      sourceKind: kind,
      sourceType: kind === "git" ? "remote-git" : kind === "archive" ? "remote-archive" : "remote-project",
      uiStatus: "needs-staging",
      recommendedNextStep:
        "Download or clone into an OpenGrove-managed staging directory, then run inspect on that local directory.",
      boundaries: defaultBoundaries(),
    };
  }

  const root = resolvePathLike(source);
  if (!existsSync(root)) {
    return {
      ok: false,
      source,
      sourceKind: "local",
      root,
      sourceType: "missing",
      issues: ["source path does not exist"],
      boundaries: defaultBoundaries(),
    };
  }
  if (!statSync(root).isDirectory()) {
    return {
      ok: false,
      source,
      sourceKind: "local",
      root,
      sourceType: "file",
      issues: ["source path must be a directory"],
      boundaries: defaultBoundaries(),
    };
  }

  const manifestPath = findAppManifestPath(root);
  const manifestValidation = validateAppManifestFile(root);
  const packageJson = readPackageJson(root);
  const capabilities = discoverCapabilities(root, packageJson);
  const sourceType = classifyLocalSource(manifestPath, capabilities, packageJson);
  return {
    ok: true,
    source,
    sourceKind: "local",
    root,
    sourceType,
    title: manifestValidation.manifest?.title ?? packageJson?.name ?? basename(root),
    manifestPath,
    manifest: manifestValidation.ok ? "valid" : manifestPath ? "invalid" : "missing",
    manifestIssues: manifestValidation.issues,
    manifestWarnings: manifestValidation.warnings,
    capabilities,
    uiStatus: decideUiStatus(sourceType, capabilities, manifestValidation.manifest),
    recommendedUiKind: recommendUiKind(sourceType, capabilities, manifestValidation.manifest),
    packageScripts: packageJson?.scripts ?? {},
    boundaries: defaultBoundaries(),
  };
}

export function validateAppRoot(appRoot: string): Record<string, unknown> {
  const validation = validateAppManifestFile(appRoot);
  const workspacePath = validation.manifest?.ui?.workspace || validation.manifest?.workspace?.path || "workspace";
  const workspaceRoot = resolve(appRoot, workspacePath);
  const cliIssues = validateCliFiles(appRoot, validation.manifest);
  const boundaryIssues = isInside(appRoot, workspaceRoot) ? [] : [`workspace escapes app root: ${workspacePath}`];
  const flowWarnings = boundaryIssues.length ? [] : validateFlowFiles(workspaceRoot, workspacePath);
  const uiEntryIssues = validateUiEntry(appRoot, validation.manifest);
  const issues = [...validation.issues, ...boundaryIssues, ...cliIssues, ...uiEntryIssues];
  return {
    ok: validation.ok && boundaryIssues.length === 0 && cliIssues.length === 0 && uiEntryIssues.length === 0,
    appRoot,
    manifestPath: validation.manifestPath,
    manifest: validation.manifest,
    workspacePath,
    workspaceExists: existsSync(workspaceRoot),
    issues,
    warnings: [...validation.warnings, ...flowWarnings],
  };
}

export async function stageAppSource(
  source: string,
  options: StageOptions = {},
): Promise<Record<string, unknown> & { ok: boolean }> {
  const sourceKind = classifySourceInput(source);
  const id = normalizeAppId(options.id || sourceId(source));
  const target = resolveStageTarget(id, options);
  const targetExisted = existsSync(target);
  if (targetExisted && readdirSync(target).length > 0 && !options.force) {
    return {
      ok: false,
      source,
      sourceKind,
      target,
      issues: ["target already exists and is not empty; pass --force or choose another target"],
    };
  }
  if (options.force) rmSync(target, { recursive: true, force: true });

  if (sourceKind === "local") {
    const localRoot = resolvePathLike(source);
    if (!existsSync(localRoot) || !statSync(localRoot).isDirectory()) {
      return {
        ok: false,
        source,
        sourceKind,
        target,
        issues: ["local source must be an existing directory"],
      };
    }
    if (!options.copy) {
      return {
        ok: true,
        source,
        sourceKind,
        action: "local-reference",
        stagedRoot: localRoot,
        copied: false,
        inspect: inspectAppSource(localRoot),
        report: appImportReport(localRoot),
        nextCommands: [`opengrove app report ${shellQuote(localRoot)}`, `opengrove app mount ${shellQuote(localRoot)}`],
      };
    }
    mkdirSync(dirname(target), { recursive: true });
    copyAppSource(localRoot, target);
    return stageSuccess(source, sourceKind, target, "copy");
  }

  if (sourceKind === "git") {
    mkdirSync(dirname(target), { recursive: true });
    const result = spawnSync("git", ["clone", "--depth", "1", source, target], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      return {
        ok: false,
        source,
        sourceKind,
        target,
        issues: [`git clone failed: ${(result.stderr || result.stdout || "").trim()}`],
      };
    }
    return stageSuccess(source, sourceKind, target, "git-clone");
  }

  if (sourceKind === "archive") {
    mkdirSync(dirname(target), { recursive: true });
    const staged = await downloadAndExtractArchive(source, target);
    if (!staged.ok) {
      return staged;
    }
    return stageSuccess(source, sourceKind, staged.stagedRoot, "archive-extract");
  }

  return {
    ok: false,
    source,
    sourceKind,
    target,
    issues: ["ordinary project URLs need a git URL, archive URL, or local downloaded folder before staging"],
  };
}

export function appImportReport(appRoot: string): Record<string, unknown> & { readyToMount: boolean } {
  const inspect = inspectAppSource(appRoot);
  const validation = validateAppRoot(appRoot);
  const readyToMount = Boolean(inspect.ok && validation.ok);
  const manifest = validation.manifest as OpenGroveAppManifest | undefined;
  return {
    ok: readyToMount,
    readyToMount,
    appRoot,
    mountCandidate: readyToMount
      ? {
          id: manifest?.id || normalizeAppId(basename(appRoot)),
          title: manifest?.title || titleFromName(basename(appRoot)),
          path: appRoot,
          enabled: true,
        }
      : undefined,
    inspect,
    validation,
    nextSteps: readyToMount
      ? [
          `Register with: opengrove app mount ${shellQuote(appRoot)}`,
          "Open Settings -> Apps or the App rail to verify it appears.",
          "Run app-specific doctor/smoke commands before declaring production readiness.",
        ]
      : [
          "Fix manifest/workspace issues or run opengrove app scaffold in a target App directory.",
          `Re-run: opengrove app report ${shellQuote(appRoot)}`,
        ],
  };
}

export function scaffoldApp(target: string, options: ScaffoldOptions): Record<string, unknown> {
  const id = normalizeAppId(options.id || basename(target) || "opengrove-app");
  const title = options.title || titleFromName(id);
  const uiSurface = options.uiSurface ?? "setup";
  if (existsSync(target) && readdirSync(target).length > 0 && !options.force) {
    throw new Error("target already exists and is not empty; pass --force to write into it");
  }
  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, "workspace", "runs"), { recursive: true });
  const setupSkeleton = uiSurface === "setup";
  if (!setupSkeleton) mkdirSync(join(target, "skills", `${id}-operator`), { recursive: true });

  const mcpAppView = {
    entry: "ui/index.html",
    tools: [
      "opengrove.app.workspace.list",
      "opengrove.app.workspace.read",
      "opengrove.app.workspace.write",
      "opengrove.app.flows.list",
    ],
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
  };
  const ui = {
    surface: uiSurface,
    workspace: "workspace",
    ...(uiSurface === "view" ? { view: { protocol: "mcp-app", ...mcpAppView } } : {}),
  };

  const manifest = {
    id,
    title,
    ...(options.icon ? { icon: options.icon } : {}),
    description: options.description || `${title} workbench for OpenGrove.`,
    version: "0.1.0",
    ui,
    workspace: {
      path: "workspace",
    },
    ...(!setupSkeleton
      ? {
          skills: {
            roots: [`skills/${id}-operator`],
          },
        }
      : {}),
    ...(!setupSkeleton
      ? {
          employees: [
            {
              id: "operator",
              name: `${title} Operator`,
              role: `Operates the ${title} App and keeps generated user-visible outputs inside the App workspace.`,
              defaultSkillIds: [`${id}-operator`],
              availableSkillIds: [`${id}-operator`],
            },
          ],
        }
      : {}),
    ...(!setupSkeleton
      ? {
          capabilities: {
            skills: [`${id}-operator`],
            cli: [],
          },
        }
      : {}),
    agent: {
      instructions:
        "Keep generated user-visible outputs inside workspace/runs. Add concrete CLI declarations only when real commands exist.",
    },
  };
  writeJsonIfAllowed(join(target, "opengrove.app.json"), manifest, options.force);
  ensureAppBuildContract(target);
  if (uiSurface === "view") {
    mkdirSync(join(target, "web"), { recursive: true });
    mkdirSync(join(target, "ui"), { recursive: true });
    const initialHtml = minimalMcpAppHtml(title);
    writeTextIfAllowed(join(target, "web", "index.html"), initialHtml, options.force);
    writeTextIfAllowed(join(target, "ui", "index.html"), initialHtml, options.force);
  }
  writeTextIfAllowed(
    join(target, "AGENTS.md"),
    setupSkeleton ? setupAppAgentsText(title) : appAgentsText(id, title),
    options.force,
  );
  writeTextIfAllowed(join(target, "workspace", "runs", ".gitkeep"), "", options.force);
  if (!setupSkeleton) {
    writeTextIfAllowed(
      join(target, "skills", `${id}-operator`, "SKILL.md"),
      operatorSkillText(id, title),
      options.force,
    );
  }
  const gitInitialized = ensureAppGitRepo(target) === "initialized";
  return {
    ok: true,
    gitInitialized,
    appRoot: target,
    manifestPath: join(target, "opengrove.app.json"),
    agentsPath: join(target, "AGENTS.md"),
    ...(!setupSkeleton ? { skillPath: join(target, "skills", `${id}-operator`, "SKILL.md") } : {}),
    workspacePath: join(target, "workspace"),
    nextSteps: [
      "Fill in real UI, CLI, tool, MCP, or hook capabilities based on the app workflow.",
      "Run opengrove app validate <app-root>.",
      "Run the app-specific doctor/smoke commands before registering the mounted App.",
    ],
  };
}

export function mountAppInSettings(
  appRoot: string,
  options: MountOptions = {},
): Record<string, unknown> & { ok: boolean } {
  const report = appImportReport(appRoot);
  if (!report.readyToMount) {
    return {
      ok: false,
      appRoot,
      report,
      issues: ["app is not ready to mount; run opengrove app report for details"],
    };
  }
  const validation = validateAppManifestFile(appRoot);
  const id = normalizeAppId(options.id || validation.manifest?.id || basename(appRoot));
  const title = options.title || validation.manifest?.title || titleFromName(id);
  const settingsPath = resolvePathLike(options.settingsPath || join("data", "bridge-settings.json"));
  const settings = readJsonFile(settingsPath);
  const currentApps = Array.isArray(settings.mountedApps) ? settings.mountedApps : [];
  const entry = {
    id,
    path: appRoot,
    enabled: options.disabled ? false : true,
    title,
  };
  const nextApps = [
    ...currentApps.filter((item) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      return record.id !== id && resolvePathLike(String(record.path || "")) !== appRoot;
    }),
    entry,
  ];
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ ...settings, mountedApps: nextApps }, null, 2)}\n`, "utf8");
  return {
    ok: true,
    settingsPath,
    appRoot,
    entry,
    mountedAppsCount: nextApps.length,
  };
}

function validateUiEntry(appRoot: string, manifest: OpenGroveAppManifest | undefined): string[] {
  if (!manifest) return [];
  return uiEntryDeclarations(manifest).flatMap(({ field, entry }) => validateSingleUiEntry(appRoot, field, entry));
}

function uiEntryDeclarations(manifest: OpenGroveAppManifest): Array<{ field: string; entry: string }> {
  const entries: Array<{ field: string; entry: string }> = [];
  const topLevelEntry = normalizeCompatibleAppUi(manifest).view?.entry;
  if (topLevelEntry) entries.push({ field: "ui.entry", entry: topLevelEntry });
  for (const [index, tab] of (manifest.ui?.tabs ?? []).entries()) {
    if (tab.component !== "view" || !tab.view) continue;
    const entry = normalizeMcpAppView(tab.view).entry;
    if (entry) entries.push({ field: `ui.tabs[${index}].view.entry`, entry });
  }
  return entries;
}

function validateSingleUiEntry(appRoot: string, field: string, entry: string): string[] {
  const entryPath = resolve(appRoot, entry);
  if (!isInside(appRoot, entryPath)) return [`${field} escapes app root: ${entry}`];
  try {
    if (!isInside(realpathSync.native(appRoot), realpathSync.native(entryPath))) {
      return [`${field} escapes app root through a symbolic link: ${entry}`];
    }
    return statSync(entryPath).isFile() ? [] : [`${field} is not a file: ${entry}`];
  } catch {
    return [`${field} does not exist: ${entry}`];
  }
}

export interface AppPackageManifest {
  [key: string]: unknown;
  schemaVersion: 1;
  packageKey?: string;
  packageId: string;
  appId: string;
  version: string;
  workspacePath: string;
  files: Record<string, string>;
  excluded: string[];
  provenance?: PackageProvenance;
}

export interface PackAppResult {
  ok: true;
  appRoot: string;
  archivePath: string;
  archiveSha256: string;
  archiveSize: number;
  packageManifest: AppPackageManifest;
}

interface AppPackPlan {
  manifest: OpenGroveAppManifest;
  rewriteManifest: boolean;
  workspacePath: string;
  packageId: string;
  packageKey?: string;
  version: string;
  exclusionPolicy: PackExclusionPolicy;
  files: string[];
  manifestRelativePath: string;
}

function appPackPlan(appRoot: string, options: PackOptions): AppPackPlan {
  const { manifest, rewriteManifest } = resolvedPackageManifest(appRoot, options);
  assertResolvedAppReleaseEligibility(appRoot, manifest, options.allowSetup === true);
  const workspacePath = manifest.ui?.workspace || manifest.workspace?.path || "workspace";
  const packageId = normalizeAppId(manifest.id);
  const packageKey = normalizePackageKey(manifest.store?.packageKey);
  const version = manifest.version || "0.1.0";
  const exclusionPolicy = defaultPackExcludes(workspacePath, manifest, options.purpose);
  const files = collectPackageFiles(appRoot, exclusionPolicy);
  if (!files.some((file) => file === "opengrove.app.json")) {
    throw new Error("pack_manifest_missing");
  }
  const packedFiles = new Set(files);
  for (const { field, entry } of uiEntryDeclarations(manifest)) {
    const packedEntry = relative(resolve(appRoot), resolve(appRoot, entry)).replaceAll("\\", "/");
    if (!packedFiles.has(packedEntry)) {
      throw new Error(`pack_ui_entry_excluded:${field}:${entry}`);
    }
  }
  const manifestPath = findAppManifestPath(appRoot);
  return {
    manifest,
    rewriteManifest,
    workspacePath,
    packageId,
    ...(packageKey ? { packageKey } : {}),
    version,
    exclusionPolicy,
    files,
    manifestRelativePath: manifestPath ? relative(appRoot, manifestPath).split("\\").join("/") : "",
  };
}

function resolvedPackageManifest(
  appRoot: string,
  options: PackOptions,
): { manifest: OpenGroveAppManifest; rewriteManifest: boolean } {
  const validation = validateAppManifestFile(appRoot);
  if (!validation.ok || !validation.manifest) {
    throw new Error(`app_not_valid: ${validation.issues.join("; ")}`);
  }
  const manifest = options.manifestOverride ?? validation.manifest;
  const rewriteManifest = Boolean(
    options.manifestOverride && !isDeepStrictEqual(options.manifestOverride, validation.manifest),
  );
  if (options.manifestOverride) {
    const overrideValidation = opengroveAppManifestSchema.safeParse(options.manifestOverride);
    if (!overrideValidation.success) {
      throw new Error(`app_not_valid: ${overrideValidation.error.issues.map((issue) => issue.message).join("; ")}`);
    }
  }
  return { manifest, rewriteManifest };
}

/**
 * Check only product-level release eligibility that Host can decide without
 * enumerating or reading the formal package. Builder remains the package-plan
 * authority.
 */
export function assertAppReleaseEligibility(appRoot: string, options: PackOptions = {}): void {
  const { manifest } = resolvedPackageManifest(appRoot, options);
  assertResolvedAppReleaseEligibility(appRoot, manifest, options.allowSetup === true);
}

/** Returns declared paths that the formal package policy would omit. */
export function appPackageExcludedPaths(
  appRoot: string,
  paths: string[],
  options: Pick<PackOptions, "manifestOverride"> = {},
): string[] {
  const { manifest } = resolvedPackageManifest(appRoot, options);
  const workspacePath = manifest.ui?.workspace || manifest.workspace?.path || "workspace";
  const exclusionPolicy = defaultPackExcludes(workspacePath, manifest, "release");
  return paths.filter((path) => isPackExcluded(normalizedPackPath(path), exclusionPolicy));
}

function assertResolvedAppReleaseEligibility(
  appRoot: string,
  manifest: OpenGroveAppManifest,
  allowSetup: boolean,
): void {
  const uiEntryIssues = validateUiEntry(appRoot, manifest);
  if (uiEntryIssues.length) {
    throw new Error(`app_not_valid: ${uiEntryIssues.join("; ")}`);
  }
  if (normalizeCompatibleAppUi(manifest).surface === "setup" && !allowSetup) {
    throw new Error("app_setup_not_publishable: choose file-workbench, view, or none before packing");
  }
  const userExclusions: PackExclusionPolicy = {
    patterns: manifest.store?.packExclude ?? [],
    excludeSensitiveLocalState: false,
  };
  if (isPackExcluded("opengrove.app.json", userExclusions)) {
    throw new Error("pack_manifest_missing");
  }
  for (const { field, entry } of uiEntryDeclarations(manifest)) {
    const packedEntry = relative(resolve(appRoot), resolve(appRoot, entry)).replaceAll("\\", "/");
    if (isPackExcluded(packedEntry, userExclusions)) {
      throw new Error(`pack_ui_entry_excluded:${field}:${entry}`);
    }
  }
}

/** Validate the exact formal package inputs without constructing a staging tree or tar archive. */
export function validateAppPackageSource(appRoot: string, options: PackOptions = {}): void {
  const plan = appPackPlan(appRoot, options);
  for (const file of plan.files) {
    if (normalizedPackPath(file) !== "runtime/vendor/receipt.json") continue;
    validatePackedMetadata(file, readFileSync(join(appRoot, file)));
  }
}

export function computeAppPackageManifest(appRoot: string, options: PackOptions = {}): AppPackageManifest {
  const plan = appPackPlan(appRoot, options);
  const hashes = collectAppPackageFileHashes(appRoot, plan);
  return appPackageManifestFromPlan(appRoot, plan, hashes);
}

export function packApp(appRoot: string, options: PackOptions = {}): PackAppResult {
  const plan = appPackPlan(appRoot, options);
  const outputPath = resolvePathLike(
    options.outputPath || join(process.cwd(), `${plan.packageId}-${plan.version}.tgz`),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  const tempRoot = mkdtempSync(join(dirname(outputPath), ".opengrove-pack-"));
  const stageRoot = join(tempRoot, plan.packageId);
  try {
    mkdirSync(stageRoot, { recursive: true });
    const hashes = collectAppPackageFileHashes(appRoot, plan, ({ file, source, bytes }) => {
      const target = join(stageRoot, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      // 保留源文件权限位（尤其 bin/ 下 CLI 的执行位），否则安装后 CLI 无法执行。
      chmodSync(target, statSync(source).mode & 0o777);
    });
    const packageManifest = appPackageManifestFromPlan(appRoot, plan, hashes);
    writeFileSync(
      join(stageRoot, ".opengrove-package-manifest.json"),
      `${JSON.stringify(packageManifest, null, 2)}\n`,
      "utf8",
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    const tar = spawnSync(tarCommand(), ["-czf", outputPath, "-C", stageRoot, "."], { encoding: "utf8" });
    if (tar.status !== 0) {
      throw new Error(`tar_failed: ${(tar.stderr || tar.stdout || "").trim()}`);
    }
    const archive = readFileSync(outputPath);
    return {
      ok: true,
      appRoot,
      archivePath: outputPath,
      archiveSha256: sha256(archive),
      archiveSize: archive.byteLength,
      packageManifest,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function collectAppPackageFileHashes(
  appRoot: string,
  plan: AppPackPlan,
  onFile?: (input: { file: string; source: string; bytes: Buffer }) => void,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of plan.files) {
    const source = join(appRoot, file);
    const bytes =
      plan.rewriteManifest && file === plan.manifestRelativePath
        ? Buffer.from(`${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8")
        : readFileSync(source);
    validatePackedMetadata(file, bytes);
    hashes[file] = `sha256:${sha256(bytes)}`;
    onFile?.({ file, source, bytes });
  }
  return hashes;
}

function appPackageManifestFromPlan(
  appRoot: string,
  plan: AppPackPlan,
  files: Record<string, string>,
): AppPackageManifest {
  const provenance = collectGitProvenance(appRoot, plan.exclusionPolicy);
  return {
    schemaVersion: 1,
    ...(plan.packageKey ? { packageKey: plan.packageKey } : {}),
    packageId: plan.packageId,
    appId: plan.packageId,
    version: plan.version,
    workspacePath: plan.workspacePath,
    files,
    excluded: plan.exclusionPolicy.patterns,
    ...(provenance ? { provenance } : {}),
  };
}

export async function publishApp(appRoot: string, options: PublishOptions): Promise<Record<string, unknown>> {
  if (!options.registryUrl) throw new Error("opengrove app publish requires --registry URL");
  const token = options.token || process.env.OPENGROVE_REGISTRY_TOKEN || "";
  if (!token) throw new Error("opengrove app publish requires --token TOKEN or OPENGROVE_REGISTRY_TOKEN");
  const tempRoot = mkdtempSync(join(process.cwd(), ".opengrove-publish-"));
  try {
    const packed = packApp(appRoot, { outputPath: join(tempRoot, "package.tgz") });
    const validation = validateAppManifestFile(appRoot);
    const manifest = validation.manifest;
    const manifestIcon =
      normalizeAppIcon((manifest as Record<string, unknown> | undefined)?.icon) ||
      normalizeAppIcon((manifest?.ui as Record<string, unknown> | undefined)?.icon);
    const metadata = {
      title: manifest?.title,
      description: manifest?.description,
      version: manifest?.version,
      packageId: manifest?.id,
      appId: manifest?.id,
      ...(manifestIcon ? { icon: manifestIcon } : {}),
      fileName: basename(packed.archivePath),
      ...(normalizePackageKey(options.packageKey || manifest?.store?.packageKey)
        ? {
            packageKey: normalizePackageKey(options.packageKey || manifest?.store?.packageKey),
          }
        : {}),
      ...(options.visibility || manifest?.store?.visibility
        ? { visibility: options.visibility || manifest?.store?.visibility }
        : {}),
    };
    const archiveBytes = readFileSync(packed.archivePath);
    const registryBaseUrl = options.registryUrl.replace(/\/+$/g, "");
    const idempotencyKey = appStorePublishIdempotencyKey({
      registryUrl: registryBaseUrl,
      appId: manifest?.id || "",
      packageId: manifest?.id,
      packageKey: metadata.packageKey,
      version: manifest?.version || "0.1.0",
      visibility: metadata.visibility,
    });
    let upload = await uploadRegistryPackage(
      registryBaseUrl,
      "/v1/app-store/packages",
      token,
      metadata,
      archiveBytes,
      appStorePublishRequestIdempotencyKey(idempotencyKey, "create"),
    );
    if (
      !upload.ok &&
      upload.status === 409 &&
      registryErrorCode(upload.body) === "app_store_package_exists" &&
      typeof metadata.packageKey === "string" &&
      metadata.packageKey
    ) {
      upload = await uploadRegistryPackage(
        registryBaseUrl,
        `/v1/app-store/packages/${encodeURIComponent(metadata.packageKey)}/versions`,
        token,
        metadata,
        archiveBytes,
        appStorePublishRequestIdempotencyKey(idempotencyKey, "version"),
      );
    }
    if (!upload.ok) {
      throw new Error(`publish_failed:${upload.status}:${JSON.stringify(upload.body)}`);
    }
    return {
      ok: true,
      archivePath: packed.archivePath,
      archiveSha256: packed.archiveSha256,
      archiveSize: packed.archiveSize,
      registry: options.registryUrl,
      response: upload.body,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function uploadRegistryPackage(
  registryBaseUrl: string,
  path: string,
  token: string,
  metadata: Record<string, unknown>,
  archiveBytes: Buffer,
  idempotencyKey: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${registryBaseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/vnd.opengrove.app-package",
      "x-opengrove-package-metadata": Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
      "Idempotency-Key": idempotencyKey,
    },
    body: archiveBytes as unknown as BodyInit,
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await readResponseBody(response),
  };
}

interface StageOptions {
  id?: string;
  target?: string;
  appsDir?: string;
  copy?: boolean;
  force?: boolean;
}

interface ScaffoldOptions {
  id?: string;
  title?: string;
  icon?: string;
  description?: string;
  uiSurface?: AppUiSurface;
  force?: boolean;
}

interface MountOptions {
  settingsPath?: string;
  id?: string;
  title?: string;
  disabled?: boolean;
}

interface PackOptions {
  outputPath?: string;
  manifestOverride?: OpenGroveAppManifest;
  /** Local draft snapshots may preserve an unfinished setup surface; formal packages may not. */
  allowSetup?: boolean;
  /** Local drafts preserve every editable input and ignore App-controlled release exclusions. */
  purpose?: "release" | "local-draft";
}

interface PublishOptions {
  registryUrl: string;
  token?: string;
  packageKey?: string;
  visibility?: "public" | "restricted";
}

function parseStageOptions(args: string[]): StageOptions {
  const options: StageOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--id") {
      options.id = readRequiredValue(args, index, "--id");
      index += 1;
    } else if (arg.startsWith("--id=")) {
      options.id = arg.slice("--id=".length);
    } else if (arg === "--target") {
      options.target = readRequiredValue(args, index, "--target");
      index += 1;
    } else if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    } else if (arg === "--apps-dir") {
      options.appsDir = readRequiredValue(args, index, "--apps-dir");
      index += 1;
    } else if (arg.startsWith("--apps-dir=")) {
      options.appsDir = arg.slice("--apps-dir=".length);
    } else if (arg === "--copy") {
      options.copy = true;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      throw new Error(`Unknown stage option: ${arg}`);
    }
  }
  return options;
}

function parseImportOptions(args: string[]): ImportProjectOptions {
  const options: ImportProjectOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--id") {
      options.id = readRequiredValue(args, index, "--id");
      index += 1;
    } else if (arg.startsWith("--id=")) {
      options.id = arg.slice("--id=".length);
    } else if (arg === "--title") {
      options.title = readRequiredValue(args, index, "--title");
      index += 1;
    } else if (arg.startsWith("--title=")) {
      options.title = arg.slice("--title=".length);
    } else if (arg === "--description") {
      options.description = readRequiredValue(args, index, "--description");
      index += 1;
    } else if (arg.startsWith("--description=")) {
      options.description = arg.slice("--description=".length);
    } else if (arg === "--target") {
      options.target = readRequiredValue(args, index, "--target");
      index += 1;
    } else if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    } else if (arg === "--apps-dir") {
      options.appsDir = readRequiredValue(args, index, "--apps-dir");
      index += 1;
    } else if (arg.startsWith("--apps-dir=")) {
      options.appsDir = arg.slice("--apps-dir=".length);
    } else if (arg === "--force") {
      options.force = true;
    } else {
      throw new Error(`Unknown import option: ${arg}`);
    }
  }
  return options;
}

function parseMountOptions(args: string[]): MountOptions {
  const options: MountOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--settings") {
      options.settingsPath = readRequiredValue(args, index, "--settings");
      index += 1;
    } else if (arg.startsWith("--settings=")) {
      options.settingsPath = arg.slice("--settings=".length);
    } else if (arg === "--id") {
      options.id = readRequiredValue(args, index, "--id");
      index += 1;
    } else if (arg.startsWith("--id=")) {
      options.id = arg.slice("--id=".length);
    } else if (arg === "--title") {
      options.title = readRequiredValue(args, index, "--title");
      index += 1;
    } else if (arg.startsWith("--title=")) {
      options.title = arg.slice("--title=".length);
    } else if (arg === "--disabled") {
      options.disabled = true;
    } else {
      throw new Error(`Unknown mount option: ${arg}`);
    }
  }
  return options;
}

function parseScaffoldOptions(args: string[]): ScaffoldOptions {
  const options: ScaffoldOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--id") {
      options.id = readRequiredValue(args, index, "--id");
      index += 1;
    } else if (arg.startsWith("--id=")) {
      options.id = arg.slice("--id=".length);
    } else if (arg === "--title") {
      options.title = readRequiredValue(args, index, "--title");
      index += 1;
    } else if (arg.startsWith("--title=")) {
      options.title = arg.slice("--title=".length);
    } else if (arg === "--description") {
      options.description = readRequiredValue(args, index, "--description");
      index += 1;
    } else if (arg.startsWith("--description=")) {
      options.description = arg.slice("--description=".length);
    } else if (arg === "--ui-surface") {
      options.uiSurface = parseUiSurface(readRequiredValue(args, index, "--ui-surface"));
      index += 1;
    } else if (arg.startsWith("--ui-surface=")) {
      options.uiSurface = parseUiSurface(arg.slice("--ui-surface=".length));
    } else if (arg === "--force") {
      options.force = true;
    } else {
      throw new Error(`Unknown scaffold option: ${arg}`);
    }
  }
  return options;
}

function parsePackOptions(args: string[]): PackOptions {
  const options: PackOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--output") {
      options.outputPath = readRequiredValue(args, index, "--output");
      index += 1;
    } else if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    } else {
      throw new Error(`Unknown pack option: ${arg}`);
    }
  }
  return options;
}

function parsePublishOptions(args: string[]): PublishOptions {
  const options: PublishOptions = { registryUrl: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--registry") {
      options.registryUrl = readRequiredValue(args, index, "--registry");
      index += 1;
    } else if (arg.startsWith("--registry=")) {
      options.registryUrl = arg.slice("--registry=".length);
    } else if (arg === "--token") {
      options.token = readRequiredValue(args, index, "--token");
      index += 1;
    } else if (arg.startsWith("--token=")) {
      options.token = arg.slice("--token=".length);
    } else if (arg === "--package-key") {
      options.packageKey = readRequiredValue(args, index, "--package-key");
      index += 1;
    } else if (arg.startsWith("--package-key=")) {
      options.packageKey = arg.slice("--package-key=".length);
    } else if (arg === "--visibility") {
      options.visibility = parsePackageVisibility(readRequiredValue(args, index, "--visibility"));
      index += 1;
    } else if (arg.startsWith("--visibility=")) {
      options.visibility = parsePackageVisibility(arg.slice("--visibility=".length));
    } else {
      throw new Error(`Unknown publish option: ${arg}`);
    }
  }
  return options;
}

function parsePackageVisibility(value: string): PublishOptions["visibility"] {
  if (value === "public" || value === "restricted") return value;
  throw new Error(`Invalid --visibility: ${value}`);
}

function normalizePackageKey(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 160);
}

function normalizeAppIcon(value: unknown): string {
  const supported = normalizeAppIconValue(value);
  if (supported) return supported;
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80)
    : "";
}

function classifySourceInput(source: string): "local" | "git" | "archive" | "project" {
  if (/^https?:\/\//i.test(source)) {
    if (/github\.com|gitlab\.com|bitbucket\.org|\.git(?:[#?].*)?$/i.test(source)) return "git";
    if (/\.(zip|tar|tgz|tar\.gz)(?:[#?].*)?$/i.test(source)) return "archive";
    return "project";
  }
  if (/^(git@|ssh:\/\/)/i.test(source) || /\.git$/i.test(source)) return "git";
  return "local";
}

function discoverCapabilities(root: string, packageJson: PackageJson | undefined): Record<string, unknown> {
  const entries = new Set(safeReadDir(root));
  const hasSrc = entries.has("src");
  const hasScripts = entries.has("scripts");
  const pythonEntryPoints = hasSrc ? pythonFileCount(join(root, "src")) : 0;
  return {
    manifest: Boolean(findAppManifestPath(root)),
    uiDirectory: entries.has("ui"),
    webProject: Boolean(packageJson || entries.has("index.html") || hasFilePrefix(root, "vite.config")),
    packageJson: Boolean(packageJson),
    packageBin: Boolean(packageJson?.bin),
    skills: entries.has("skills"),
    bin: entries.has("bin"),
    srcDirectory: hasSrc,
    tools: entries.has("tools"),
    mcp: entries.has("mcp.json"),
    hooks: entries.has("hooks.json"),
    workspace: entries.has("workspace"),
    flows: flowFileCount(join(root, "workspace")) > 0,
    scriptsDirectory: hasScripts,
    pythonProject: pythonEntryPoints > 0 || Boolean(entries.has("requirements.txt") && (hasSrc || hasScripts)),
    pythonEntryPoints,
    projectData: entries.has("projects"),
    existingReviewUi: entries.has("web"),
    docs: entries.has("docs") || entries.has("README.md"),
  };
}

function classifyLocalSource(
  manifestPath: string | undefined,
  capabilities: Record<string, unknown>,
  packageJson: PackageJson | undefined,
): string {
  if (manifestPath) return "opengrove-app";
  const hasWeb = Boolean(capabilities.webProject);
  const hasCli = Boolean(capabilities.bin || capabilities.packageBin);
  const hasWorkflowCode = Boolean(
    capabilities.srcDirectory || capabilities.scriptsDirectory || capabilities.pythonProject,
  );
  const hasAppParts = Boolean(
    capabilities.skills || capabilities.tools || capabilities.mcp || capabilities.hooks || capabilities.workspace,
  );
  if (hasWeb && hasCli) return "mixed-project";
  if (hasWeb) return "web-project";
  if (hasCli) return "cli-toolkit";
  if (hasWorkflowCode) return "workflow-project";
  if (hasAppParts) return "partial-opengrove-app";
  if (packageJson?.scripts && Object.keys(packageJson.scripts).length > 0) return "script-collection";
  if (capabilities.docs) return "knowledge-directory";
  return "directory";
}

function decideUiStatus(
  sourceType: string,
  capabilities: Record<string, unknown>,
  manifest: OpenGroveAppManifest | undefined,
): string {
  const normalizedUi = manifest ? normalizeCompatibleAppUi(manifest) : undefined;
  if (normalizedUi?.surface === "view" || sourceType === "web-project" || sourceType === "mixed-project")
    return "existing-ui";
  if (
    normalizedUi?.surface === "file-workbench" ||
    capabilities.workspace ||
    capabilities.bin ||
    capabilities.scriptsDirectory ||
    capabilities.srcDirectory
  )
    return "file-workbench";
  if (normalizedUi?.surface === "setup") return "setup";
  if (normalizedUi?.surface === "none") return "none";
  return "needs-native-ui-design";
}

function recommendUiKind(
  sourceType: string,
  capabilities: Record<string, unknown>,
  manifest: OpenGroveAppManifest | undefined,
): string {
  if (manifest?.ui?.surface) return manifest.ui.surface;
  const legacyKind = legacyAppUiKind(manifest);
  if (legacyKind) return legacyKind;
  if (sourceType === "web-project" || sourceType === "mixed-project") return "mcp-app";
  if (capabilities.workspace || capabilities.bin || capabilities.scriptsDirectory || capabilities.srcDirectory)
    return "file-workbench";
  return "mcp-app";
}

function validateCliFiles(appRoot: string, manifest: OpenGroveAppManifest | undefined): string[] {
  const issues: string[] = [];
  for (const declaration of manifest?.capabilities?.cli ?? []) {
    const normalized = normalizeAppCliDeclaration(declaration);
    if (normalized && (normalized.source === "path" || isAppCliDeclaredPath(normalized.executable))) {
      const resolved = isAbsolute(normalized.executable)
        ? normalized.executable
        : resolve(appRoot, normalized.executable);
      if (!existsSync(resolved)) issues.push(`cli command missing: ${normalized.executable}`);
    }
    const nodeScript = appCliNodeScriptArgument(normalized);
    if (nodeScript) {
      const scriptResolution = resolveAppCliOwnedPath(appRoot, nodeScript.value);
      if (!scriptResolution.ok && scriptResolution.error === "outside") {
        issues.push(`cli script escapes app root: ${nodeScript.value}`);
      } else if (!scriptResolution.ok) {
        issues.push(`cli script missing: ${nodeScript.value}`);
      }
    }
    if (typeof declaration === "string" || !declaration.targets) continue;
    for (const [target, source] of Object.entries(declaration.targets)) {
      if (!source) continue;
      const targetPath = resolveAppCliTargetPath(appRoot, source);
      if (!targetPath) {
        issues.push(`cli target ${target} escapes app root: ${source}`);
        continue;
      }
      for (const issue of validateAppCliTargetFile(targetPath, target as AppCliTargetKey, {
        appRoot,
        hostPlatform: process.platform,
      })) {
        issues.push(`cli target ${target} ${issue.code}: ${source} (${issue.detail})`);
      }
    }
  }
  return issues;
}

function validateFlowFiles(workspaceRoot: string, workspacePath: string): string[] {
  const warnings: string[] = [];
  for (const path of collectFlowFiles(workspaceRoot)) {
    const relativePath = path
      .slice(workspaceRoot.length)
      .replace(/^[/\\]+/, "")
      .split("\\")
      .join("/");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      warnings.push(
        `${join(workspacePath, relativePath).split("\\").join("/")}: flow file unreadable: ${errorMessage(error)}`,
      );
      continue;
    }
    const result = parseFlowMarkdown(text);
    if (!result.valid) {
      warnings.push(`${join(workspacePath, relativePath).split("\\").join("/")}: ${result.issues.join("; ")}`);
    }
  }
  return warnings;
}

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  bin?: unknown;
};

function readPackageJson(root: string): PackageJson | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function safeReadDir(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

function hasFilePrefix(root: string, prefix: string): boolean {
  return safeReadDir(root).some((name) => name.startsWith(prefix));
}

function pythonFileCount(root: string): number {
  try {
    return safeReadDir(root).filter((name) => name.endsWith(".py")).length;
  } catch {
    return 0;
  }
}

function flowFileCount(root: string): number {
  return collectFlowFiles(root, 1).length;
}

function collectFlowFiles(root: string, limit = 500): string[] {
  const output: string[] = [];
  collectFlowFilesInto(root, output, limit, 0);
  return output;
}

function collectFlowFilesInto(root: string, output: string[], limit: number, depth: number): void {
  if (!existsSync(root) || output.length >= limit || depth > MAX_FLOW_SCAN_DEPTH) return;
  for (const entry of safeReadDirEntries(root)) {
    if (output.length >= limit) return;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      collectFlowFilesInto(path, output, limit, depth + 1);
    } else if (entry.isFile() && isFlowMarkdownPath(entry.name)) {
      output.push(path);
    }
  }
}

function safeReadDirEntries(root: string) {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseUiSurface(value: string): AppUiSurface {
  if (value === "setup" || value === "file-workbench" || value === "view" || value === "none") return value;
  throw new Error(`Invalid --ui-surface: ${value}`);
}

function resolveStageTarget(id: string, options: StageOptions): string {
  if (options.target) return resolvePathLike(options.target);
  const appsDir = options.appsDir ? resolvePathLike(options.appsDir) : resolve("data", "apps");
  return resolve(appsDir, id);
}

function sourceId(source: string): string {
  const withoutQuery = source.split(/[?#]/)[0] || source;
  const clean = withoutQuery.replace(/\/+$/, "");
  const base = basename(clean)
    .replace(/\.git$/i, "")
    .replace(/\.(zip|tar|tgz|gz)$/i, "");
  return base || "opengrove-app";
}

function stageSuccess(
  source: string,
  sourceKind: string,
  stagedRoot: string,
  action: string,
): Record<string, unknown> & { ok: true } {
  return {
    ok: true,
    source,
    sourceKind,
    action,
    stagedRoot,
    copied: action === "copy",
    inspect: inspectAppSource(stagedRoot),
    report: appImportReport(stagedRoot),
    nextCommands: [`opengrove app report ${shellQuote(stagedRoot)}`, `opengrove app mount ${shellQuote(stagedRoot)}`],
  };
}

interface PackExclusionPolicy {
  patterns: string[];
  excludeSensitiveLocalState: boolean;
}

function defaultPackExcludes(
  workspacePath: string,
  manifest: OpenGroveAppManifest,
  purpose: PackOptions["purpose"] = "release",
): PackExclusionPolicy {
  return {
    patterns: [
      workspacePath.replace(/\/+$/g, "") || "workspace",
      `${workspacePath.replace(/\/+$/g, "") || "workspace"}/**`,
      ".git",
      ".git/**",
      "**/.git/**",
      "node_modules",
      "node_modules/**",
      "**/node_modules/**",
      "cache",
      "cache/**",
      "**/cache/**",
      ".cache",
      ".cache/**",
      "**/.cache/**",
      ".venv",
      ".venv/**",
      "**/.venv/**",
      "venv",
      "venv/**",
      "**/venv/**",
      "__pycache__",
      "__pycache__/**",
      "**/__pycache__/**",
      ".DS_Store",
      "**/.DS_Store",
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      ".opengrove-package-manifest.json",
      ".opengrove-store-package.json",
      ".opengrove-store-package.json.*",
      ...(purpose === "local-draft" ? [] : (manifest.store?.packExclude ?? [])),
    ],
    excludeSensitiveLocalState: purpose === "local-draft",
  };
}

function collectGitProvenance(appRoot: string, exclusionPolicy: PackExclusionPolicy): PackageProvenance | undefined {
  const commit = gitOutput(appRoot, ["rev-parse", "HEAD"]);
  if (!commit || !/^[a-f0-9]{40,64}$/.test(commit)) return undefined;
  const toplevel = gitOutput(appRoot, ["rev-parse", "--show-toplevel"]) || appRoot;
  const prefix = relative(resolvePathLike(toplevel), resolvePathLike(appRoot)).split("\\").join("/");
  const status = gitOutput(appRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]) ?? "";
  const dirty = status.split("\n").some((line) => {
    if (!line.trim()) return false;
    const raw = line.slice(3);
    // Rename lines look like "old -> new"; the packed content is the new path.
    const path = raw.includes(" -> ") ? raw.slice(raw.indexOf(" -> ") + 4) : raw;
    const rel = prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
    return !isPackExcluded(rel, exclusionPolicy);
  });
  const branch = gitOutput(appRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = shareableRemote(gitOutput(appRoot, ["remote", "get-url", "origin"]));
  return {
    vcs: "git",
    commit,
    dirty,
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(remote ? { remote } : {}),
  };
}

function shareableRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  // Local filesystem remotes are not portable package provenance.
  if (
    remote.startsWith("/") ||
    remote.startsWith("~") ||
    remote.startsWith(".") ||
    remote.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(remote)
  ) {
    return undefined;
  }
  return stripRemoteCredentials(remote);
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, "-c", "core.quotePath=false", ...args], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const output = result.stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function stripRemoteCredentials(remote: string): string {
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote;
  }
}

function collectPackageFiles(appRoot: string, exclusionPolicy: PackExclusionPolicy): string[] {
  const files: string[] = [];
  collectPackageFilesInto(appRoot, appRoot, exclusionPolicy, files);
  return files.sort((left, right) => left.localeCompare(right));
}

function collectPackageFilesInto(
  root: string,
  current: string,
  exclusionPolicy: PackExclusionPolicy,
  output: string[],
): void {
  for (const entry of safeReadDirEntries(current)) {
    if (entry.isSymbolicLink()) continue;
    const path = join(current, entry.name);
    const relativePath = relative(root, path).split("\\").join("/");
    if (isPackExcluded(relativePath, exclusionPolicy)) continue;
    if (entry.isDirectory()) {
      collectPackageFilesInto(root, path, exclusionPolicy, output);
    } else if (entry.isFile()) {
      output.push(relativePath);
    }
  }
}

function isPackExcluded(path: string, policy: PackExclusionPolicy): boolean {
  return (
    (policy.excludeSensitiveLocalState && isSensitiveLocalStatePath(path)) ||
    policy.patterns.some((pattern) => matchesPackPattern(path, pattern))
  );
}

function isSensitiveLocalStatePath(path: string): boolean {
  const normalized = normalizedPackPath(path).toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === ".claude" ||
        segment === ".codex" ||
        segment === ".gemini" ||
        segment === ".kimi" ||
        segment === ".opencode" ||
        segment === ".aws" ||
        segment === ".azure",
    )
  ) {
    return true;
  }
  const fileName = segments.at(-1) ?? "";
  return /^(?:auth|credentials?|cookies?|sessions?|tokens?)(?:\.(?:json|ya?ml|toml|ini|db|sqlite3?))?$/i.test(fileName);
}

function matchesPackPattern(path: string, rawPattern: string): boolean {
  const pattern = rawPattern.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/g, "");
  if (!pattern) return false;
  if (!pattern.includes("*")) return path === pattern || path.startsWith(`${pattern}/`);
  if (pattern.endsWith("/**")) {
    const prefix = packGlobSource(pattern.slice(0, -3));
    return new RegExp(`^${prefix}(?:/.*)?$`).test(path);
  }
  return new RegExp(`^${packGlobSource(pattern)}$`).test(path);
}

function packGlobSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:[^/]+/)*";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (pattern[index] === "*") {
      source += "[^/]*";
      index += 1;
    } else {
      source += escapeRegex(pattern[index] ?? "");
      index += 1;
    }
  }
  return source;
}

function validatePackedMetadata(path: string, bytes: Buffer): void {
  if (normalizedPackPath(path) !== "runtime/vendor/receipt.json") return;
  if (bytes.byteLength > MAX_RUNTIME_RECEIPT_BYTES) throw new Error(`pack_runtime_receipt_invalid:${path}`);
  validateRuntimeReceipt(path, bytes.toString("utf8"));
}

function validateRuntimeReceipt(path: string, text: string): void {
  try {
    const receipt = JSON.parse(text) as {
      lock?: {
        python?: {
          embedded_path_replacements?: Record<string, unknown>;
        };
      };
    };
    const replacements = receipt.lock?.python?.embedded_path_replacements;
    if (!replacements || !Object.keys(replacements).length) return;
    const entries = Object.entries(replacements);
    if (
      entries.length > MAX_RUNTIME_RECEIPT_PATH_REPLACEMENTS ||
      !entries.every(
        ([source, replacement]) =>
          LOCAL_BUILD_PATH_PATTERN.test(normalizedPackPath(source)) && isScrubbedRuntimePathReplacement(replacement),
      )
    ) {
      throw new Error(`pack_runtime_receipt_invalid:${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pack_runtime_receipt_invalid:")) throw error;
    throw new Error(`pack_runtime_receipt_invalid:${path}`);
  }
}

function normalizedPackPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isScrubbedRuntimePathReplacement(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    /^\/__[A-Za-z0-9._-]+__\/(?:[A-Za-z0-9._/-]*)$/.test(value) &&
    !value.split("/").includes("..")
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function copyAppSource(sourceRoot: string, target: string): void {
  cpSync(sourceRoot, target, {
    recursive: true,
    filter: (path) => {
      const name = basename(path);
      if (name === ".git" || name === "node_modules" || name === ".venv" || name === "__pycache__") return false;
      if (name === ".cache" || name === "cache" || name === ".DS_Store") return false;
      if (/^\.env(?:\.|$)/.test(name)) return false;
      return true;
    },
  });
}

async function downloadAndExtractArchive(
  source: string,
  target: string,
): Promise<(Record<string, unknown> & { ok: false }) | { ok: true; stagedRoot: string }> {
  const tempRoot = mkdtempSync(join(dirname(target), ".opengrove-archive-"));
  const archivePath = join(tempRoot, `source${archiveExtension(source)}`);
  try {
    const response = await fetch(source);
    if (!response.ok || !response.body) {
      return {
        ok: false,
        source,
        sourceKind: "archive",
        target,
        issues: [`download failed: ${response.status} ${response.statusText}`],
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    writeFileSync(archivePath, bytes);
    const unpackRoot = join(tempRoot, "unpacked");
    mkdirSync(unpackRoot, { recursive: true });
    const unpack = unpackArchive(archivePath, unpackRoot);
    if (!unpack.ok) {
      return {
        ok: false,
        source,
        sourceKind: "archive",
        target,
        issues: [unpack.error],
      };
    }
    const root = singleDirectoryRoot(unpackRoot) ?? unpackRoot;
    copyAppSource(root, target);
    return { ok: true, stagedRoot: target };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function archiveExtension(source: string): string {
  const lower = source.toLowerCase().split(/[?#]/)[0] || "";
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return extname(lower) || ".archive";
}

function unpackArchive(archivePath: string, target: string): { ok: true } | { ok: false; error: string } {
  const lower = archivePath.toLowerCase();
  const command = lower.endsWith(".zip")
    ? { bin: "unzip", args: ["-q", archivePath, "-d", target] }
    : { bin: tarCommand(), args: ["-xf", archivePath, "-C", target] };
  const result = spawnSync(command.bin, command.args, { encoding: "utf8" });
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    error: `${command.bin} failed: ${(result.stderr || result.stdout || "").trim()}`,
  };
}

function singleDirectoryRoot(root: string): string | undefined {
  const entries = readdirSync(root).filter((name) => name !== "__MACOSX" && name !== ".DS_Store");
  if (entries.length !== 1) return undefined;
  const candidate = join(root, entries[0] ?? "");
  return statSync(candidate).isDirectory() ? candidate : undefined;
}

function readRequiredValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return value;
}

function writeJsonIfAllowed(path: string, value: unknown, force: boolean | undefined): void {
  writeTextIfAllowed(path, `${JSON.stringify(value, null, 2)}\n`, force);
}

function writeTextIfAllowed(path: string, value: string, force: boolean | undefined): void {
  if (existsSync(path) && !force) throw new Error(`${path} already exists; pass --force to overwrite`);
  writeFileSync(path, value, "utf8");
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function operatorSkillText(id: string, title: string): string {
  return `---
name: ${id}-operator
description: Use when operating the ${title} OpenGrove App, including running its commands, reading workspace artifacts, and keeping outputs inside the App workspace.
---

# ${title} Operator

Use this skill for App-specific work after the App is mounted in OpenGrove.

## Workflow

1. Read opengrove.app.json first.
2. Keep generated outputs inside workspace/runs unless the manifest says otherwise.
3. Run declared doctor/smoke commands before claiming the App is ready.
4. Report missing API keys, model files, or system dependencies as configuration gaps.
`;
}

function appAgentsText(id: string, title: string): string {
  return `# ${title} App Agent

You are the bound employee for the ${title} OpenGrove App.

- Read opengrove.app.json before changing the App workflow.
- Use the ${id}-operator skill for App-specific tasks.
- Keep generated user-visible outputs inside workspace/runs unless the manifest says otherwise.
- Treat API keys, model paths, and machine-specific tools as runtime configuration.
- Report what was changed and what was verified after each App operation.
`;
}

function setupAppAgentsText(title: string): string {
  return `# ${title} App

This App is still in setup. The Host will ask the user whether to use the built-in file workbench or build a custom MCP App View.

- Read opengrove.app.json before changing the App.
- Work only inside this App root.
- For a custom View, build a real source project first and expose its bundled entry through ui.surface=view and ui.view.protocol=mcp-app.
- To keep the file workbench and customize one business tab, declare a stable ui.tabs id with component=view and a standard MCP App view contract; keep that UI source and build output inside this App.
- Change business UI in the App package. Do not modify the OpenGrove Host for App-specific copy, layout, or interaction.
- Keep generated user-visible outputs inside workspace/runs unless the manifest says otherwise.
- Do not mark the App ready until its declared build, validation, and smoke checks pass.
`;
}

function defaultBoundaries(): string[] {
  return [
    "Write only inside the App root or its declared workspace.",
    "Stage URL imports into an OpenGrove-managed App directory before editing.",
    "Do not copy secrets, caches, or unrelated source folders into the App package.",
    "Document API keys, model files, and system dependencies as runtime configuration.",
  ];
}

function normalizeAppId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "opengrove-app";
}

function titleFromName(name: string): string {
  return name
    .split(/[-_:.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolvePathLike(path: string): string {
  if (path === "~") return resolve(homedir());
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const relation = relative(normalizedRoot, normalizedCandidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function registryErrorCode(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" ? error.trim() : "";
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
