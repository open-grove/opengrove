import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const DEV_APP_NAME = "OpenGrove Dev";
export const DEV_BUNDLE_ID = "cn.opengrove.desktop.dev";
export const DEV_APP_VERSION = 5;
export const DEV_ICON_FILE = "icon.icns";
export const DEV_EXECUTABLE_FILE = "OpenGroveDev";
export const DEV_URL_SCHEME = "opengrove-dev";

export function desktopDevRuntimePaths({
  homeDir = homedir(),
  runtimeRoot = process.env.OPENGROVE_DESKTOP_DEV_RUNTIME_ROOT,
} = {}) {
  const userDataPath = join(homeDir, "Library", "Application Support", "OpenGroveDev");
  const root = runtimeRoot ? resolve(runtimeRoot) : join(userDataPath, "runtime");
  const appPath = join(root, "electron", `${DEV_APP_NAME}.app`);
  return {
    root,
    userDataPath,
    appPath,
    executablePath: join(appPath, "Contents", "MacOS", DEV_EXECUTABLE_FILE),
    electronExecutablePath: join(appPath, "Contents", "MacOS", "Electron"),
    markerPath: join(appPath, "Contents", "Resources", "opengrove-dev-electron.json"),
    activeProjectPath: join(root, "active-project.json"),
  };
}

export function resolveDesktopDevProfileOptions(
  args,
  { homeDir = homedir(), platform = process.platform, env = process.env } = {},
) {
  const profile = commandOption(args, "--profile");
  if (profile && !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(profile)) {
    throw new Error("OpenGrove Dev profile must use lowercase letters, digits, and hyphens.");
  }
  const profileEnvPrefix = profile ? `OPENGROVE_DESKTOP_DEV_${profile.replaceAll("-", "_").toUpperCase()}` : undefined;
  const wwBaseUrl =
    commandOption(args, "--ww-base-url") ??
    environmentOption(env, profileEnvPrefix && `${profileEnvPrefix}_WW_BASE_URL`);
  const releaseControlUrl =
    commandOption(args, "--release-control-url") ??
    environmentOption(env, profileEnvPrefix && `${profileEnvPrefix}_RELEASE_CONTROL_URL`);
  if (!profile && !wwBaseUrl && !releaseControlUrl) return undefined;
  if (!profile || !wwBaseUrl || !releaseControlUrl) {
    throw new Error(
      "OpenGrove Dev profile requires --profile plus --ww-base-url and --release-control-url " +
        "(or the matching OPENGROVE_DESKTOP_DEV_<PROFILE> service URL variables).",
    );
  }
  const normalizedWwBaseUrl = normalizeServiceBaseUrl(wwBaseUrl);
  const normalizedReleaseControlUrl = normalizeServiceBaseUrl(releaseControlUrl, "--release-control-url");
  const appDataDir =
    platform === "darwin"
      ? join(homeDir, "Library", "Application Support")
      : platform === "win32"
        ? resolve(env.APPDATA?.trim() || join(homeDir, "AppData", "Roaming"))
        : resolve(env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config"));
  const userDataDir = join(appDataDir, platform === "linux" ? `opengrove-dev-${profile}` : `OpenGroveDev-${profile}`);
  return {
    name: profile,
    wwBaseUrl: normalizedWwBaseUrl,
    releaseControlUrl: normalizedReleaseControlUrl,
    userDataDir,
    environmentOverrides: {
      OPENGROVE_DESKTOP_DEV_PROFILE: profile,
      OPENGROVE_DESKTOP_DEV_USER_DATA_DIR: userDataDir,
      OPENGROVE_WW_BASE_URL: normalizedWwBaseUrl,
      OPENGROVE_WW_API_KEY: "",
      OPENGROVE_WW_ACCESS_TOKEN: "",
      OPENGROVE_WW_USER_ID: "",
      OPENGROVE_WW_USER_EMAIL: "",
      OPENGROVE_RELEASE_CONTROL_URL: normalizedReleaseControlUrl,
      OPENGROVE_APP_STORE_REGISTRY_URL: normalizedReleaseControlUrl,
      OPENGROVE_APP_STORE_REGISTRY_TOKEN: "",
      APP_STORE_REGISTRY_URL: "",
      APP_STORE_REGISTRY_TOKEN: "",
    },
  };
}

export function desktopDevProfileEnvironment(baseEnv, profile) {
  const env = { ...baseEnv };
  if (!profile) return env;
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("OPENGROVE_WW_") ||
      isDesktopDevProfileServiceEnvironmentKey(key) ||
      key.startsWith("OPENGROVE_RELEASE_CONTROL_") ||
      key.startsWith("OPENGROVE_APP_STORE_") ||
      key.startsWith("APP_STORE_")
    ) {
      delete env[key];
    }
  }
  Object.assign(env, profile.environmentOverrides);
  return env;
}

export function desktopDevRestartArgumentsFromEnvironment(env) {
  const args = ["scripts/restart-desktop-dev.mjs", "--skip-build"];
  const profile = env.OPENGROVE_DESKTOP_DEV_PROFILE?.trim();
  if (!profile) return args;
  const wwBaseUrl = env.OPENGROVE_WW_BASE_URL?.trim();
  const releaseControlUrl = env.OPENGROVE_RELEASE_CONTROL_URL?.trim();
  if (!wwBaseUrl || !releaseControlUrl) {
    throw new Error("desktop_dev_profile_restart_config_incomplete");
  }
  return [...args, "--profile", profile, "--ww-base-url", wwBaseUrl, "--release-control-url", releaseControlUrl];
}

export function verifyDesktopDevProfileProbe(profile, probe) {
  if (!profile) return;
  const liveProfile =
    probe && typeof probe === "object" && probe.desktopDevProfile && typeof probe.desktopDevProfile === "object"
      ? probe.desktopDevProfile
      : {};
  if (liveProfile.name !== profile.name) {
    throw new Error(`OpenGrove Dev profile ${profile.name} resolved live profile ${liveProfile.name ?? "missing"}`);
  }
  if (liveProfile.appStoreRegistryUrl !== profile.releaseControlUrl) {
    throw new Error(
      `OpenGrove Dev profile ${profile.name} resolved App Store ${liveProfile.appStoreRegistryUrl ?? "missing"} instead of ${profile.releaseControlUrl}`,
    );
  }
  if (liveProfile.releaseControlUrl !== profile.releaseControlUrl) {
    throw new Error(
      `OpenGrove Dev profile ${profile.name} resolved Release Control ${liveProfile.releaseControlUrl ?? "missing"} instead of ${profile.releaseControlUrl}`,
    );
  }
}

export function desktopDevOpenEnvironmentArguments(environmentOverrides = {}) {
  return Object.entries(environmentOverrides)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function commandOption(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value.`);
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  if (values.length > 1) {
    throw new Error(`${name} may only be provided once.`);
  }
  return values[0]?.trim() || undefined;
}

function environmentOption(env, name) {
  if (!name) return undefined;
  const value = env?.[name];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function isDesktopDevProfileServiceEnvironmentKey(name) {
  return /^OPENGROVE_DESKTOP_DEV_[A-Z0-9_]+_(?:WW_BASE_URL|RELEASE_CONTROL_URL)$/u.test(name);
}

function normalizeServiceBaseUrl(value, optionName = "--ww-base-url") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${optionName} must be a valid HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${optionName} must be an HTTP(S) base URL without credentials, query, or fragment.`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/+$/u, "");
}

export function desktopDevExecutableLauncherSource() {
  return `#!/bin/sh
launcher_dir=\${0%/*}
# Electron can touch Safe Storage before the JavaScript entrypoint runs.
exec "\${launcher_dir}/Electron" --use-mock-keychain "$@"
`;
}

export function legacyDesktopDevAppPath(projectRoot) {
  return join(projectRoot, ".opengrove", "electron", `${DEV_APP_NAME}.app`);
}

export function isLegacyDesktopDevAppPath(appPath, canonicalAppPath) {
  if (!appPath || resolve(appPath) === resolve(canonicalAppPath)) return false;
  return appPath.includes(`${sep}.opengrove${sep}electron${sep}${DEV_APP_NAME}.app`);
}

export function parseLaunchServicesDevAppPaths(output) {
  const paths = new Set();
  let currentPath = "";

  for (const line of String(output).split(/\r?\n/u)) {
    if (/^-{10,}\s*$/u.test(line)) {
      currentPath = "";
      continue;
    }
    const pathMatch = line.match(/^path:\s+(.*?)\s+\(0x[0-9a-f]+\)\s*$/iu);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const identifierMatch = line.match(/^identifier:\s+(\S+)\s*$/u);
    if (identifierMatch) {
      if (identifierMatch[1] === DEV_BUNDLE_ID && currentPath) {
        paths.add(currentPath);
      }
      currentPath = "";
    }
  }

  return [...paths];
}

export function selectDesktopDevProject(explicitProject, activeProject, validateProject) {
  return explicitProject ? validateProject(explicitProject) : validateProject(activeProject);
}

export function desktopDevBootstrapSource(activeProjectPath) {
  return `"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const { join, resolve } = require("node:path");
const { app, dialog } = require("electron");

app.setName(${JSON.stringify(DEV_APP_NAME)});
app.setPath("userData", join(app.getPath("appData"), "OpenGroveDev"));

function validProjectRoot(value) {
  try {
    if (typeof value !== "string" || !value.trim()) {
      return undefined;
    }
    const projectRoot = resolve(value);
    const packagePath = join(projectRoot, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const desktopEntry = join(projectRoot, "desktop-dist", "main.cjs");
    if (
      packageJson.name !== "opengrove"
      || packageJson.main !== "desktop-dist/main.cjs"
      || !existsSync(desktopEntry)
    ) {
      return undefined;
    }
    return { projectRoot, packageJson, desktopEntry };
  } catch {
    return undefined;
  }
}

function explicitProjectRoot() {
  return process.argv
    .slice(1)
    .find((arg) => arg && !arg.startsWith("-"));
}

function activeProjectRoot() {
  try {
    return JSON.parse(readFileSync(${JSON.stringify(activeProjectPath)}, "utf8")).projectRoot;
  } catch {
    return "";
  }
}

${selectDesktopDevProject.toString()}

async function main() {
  const explicitProject = explicitProjectRoot();
  const project = selectDesktopDevProject(
    explicitProject,
    activeProjectRoot(),
    validProjectRoot,
  );
  if (!project) {
    const detail = explicitProject
      ? \`The requested project is not a built OpenGrove worktree:\\n\\n\${explicitProject}\`
      : "No valid OpenGrove Dev project is active. Run npm run restart:desktop-dev from a worktree first.";
    dialog.showErrorBox("OpenGrove Dev could not start", detail);
    app.exit(1);
    return;
  }

  Object.defineProperty(process, "defaultApp", {
    configurable: false,
    enumerable: true,
    value: true,
  });
  app.setVersion(project.packageJson.version);
  app.setAppPath(project.projectRoot);
  await import(pathToFileURL(project.desktopEntry).toString());
}

void main().catch((error) => {
  console.error("OpenGrove Dev failed to load its active project");
  console.error(error?.stack ?? error);
  app.exit(1);
});
`;
}
