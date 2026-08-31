import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export interface HostCommandProbe {
  platform?: NodeJS.Platform;
  path?: string;
  userHome?: string;
  execPath?: string;
  environment?: NodeJS.ProcessEnv;
}

export function resolveHostCommandPath(command: string | undefined, probe: HostCommandProbe = {}): string | undefined {
  const executable = command?.trim().split(/\s+/)[0];
  if (!executable) return undefined;
  const platform = probe.platform ?? process.platform;
  const environment = probe.environment ?? process.env;
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    const candidate = isAbsolute(executable) ? executable : resolve(executable);
    return isExecutableFile(candidate, platform) ? candidate : undefined;
  }

  const directories = commandSearchDirectories({
    ...probe,
    platform,
    environment,
  });
  for (const directory of directories) {
    for (const candidate of executableCandidates(join(directory, executable), platform, environment)) {
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

export function hostCommandSearchPath(probe: HostCommandProbe = {}): string {
  const platform = probe.platform ?? process.platform;
  const environment = probe.environment ?? process.env;
  return commandSearchDirectories({
    ...probe,
    platform,
    environment,
  }).join(platform === "win32" ? ";" : ":");
}

export function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandSearchDirectories(
  probe: Required<Pick<HostCommandProbe, "platform" | "environment">> & HostCommandProbe,
): string[] {
  const { platform, environment } = probe;
  const userHome = probe.userHome ?? homedir();
  const delimiter = platform === "win32" ? ";" : ":";
  const inherited = (probe.path ?? environment.PATH ?? "").split(delimiter).filter(Boolean);
  const npmPrefix = environment.NPM_CONFIG_PREFIX?.trim();
  const runtimeDir = probe.execPath?.trim() ? dirname(probe.execPath) : undefined;
  const fallbacks =
    platform === "win32"
      ? [
          runtimeDir,
          environment.APPDATA ? join(environment.APPDATA, "npm") : undefined,
          npmPrefix,
          join(userHome, "scoop", "shims"),
          environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, "Microsoft", "WindowsApps") : undefined,
        ]
      : [
          runtimeDir,
          npmPrefix ? join(npmPrefix, "bin") : undefined,
          join(userHome, ".local", "bin"),
          join(userHome, ".hermes", "node", "bin"),
          join(userHome, ".npm-global", "bin"),
          join(userHome, ".volta", "bin"),
          join(userHome, ".bun", "bin"),
          join(userHome, ".cargo", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ];
  return [...new Set([...inherited, ...fallbacks].filter((value): value is string => Boolean(value)))];
}

function executableCandidates(path: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32" || extname(path)) return [path];
  const extensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [path, ...extensions.map((extension) => `${path}${extension}`)];
}
