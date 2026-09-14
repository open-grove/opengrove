import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readAppEnv } from "../../identity.js";
import {
  refreshWindowsPath,
  windowsEnvironmentValue,
  type WindowsCommandQuery,
} from "../../environment/windows-discovery.js";
import { resolveCommandPath, type CommandPathProbe } from "../../kernel/discovery.js";
import { windowsAppCodexCandidates } from "./windows-app-discovery.js";

export interface CodexCommandPathProbe {
  platform?: NodeJS.Platform;
  homeDir?: string;
  applicationDirs?: string[];
  envPath?: string;
  commandPath?: CommandPathProbe;
  environment?: NodeJS.ProcessEnv;
  windowsQuery?: WindowsCommandQuery;
}

export function resolveCodexCommandPath(probe: CodexCommandPathProbe = {}): string | undefined {
  const platform = probe.platform ?? process.platform;
  const homeDir = probe.homeDir ?? homedir();
  const environment = probe.environment ?? process.env;
  const commandPath = {
    platform,
    path: platform === "win32" ? windowsEnvironmentValue(environment, "PATH") : environment.PATH,
    ...probe.commandPath,
  };
  const envPath = probe.envPath ?? readAppEnv("CODEX_BIN")?.trim();
  const resolvedEnvPath = resolveCommandPath(envPath, commandPath);
  if (envPath) {
    return resolvedEnvPath && isRunnableCodexCommand(resolvedEnvPath, platform) ? resolvedEnvPath : undefined;
  }

  const inheritedCommand = resolveCommandPath("codex", commandPath);
  if (inheritedCommand && isRunnableCodexCommand(inheritedCommand, platform)) return inheritedCommand;
  const refreshedEnvironment = refreshWindowsPath(
    { ...environment, PATH: commandPath.path ?? "" },
    { platform, query: probe.windowsQuery },
  );
  const localAppData = windowsEnvironmentValue(environment, "LOCALAPPDATA") || join(homeDir, "AppData", "Local");
  const installDir = windowsEnvironmentValue(environment, "CODEX_INSTALL_DIR");

  const applicationDirs =
    probe.applicationDirs ?? (platform === "darwin" ? ["/Applications", join(homeDir, "Applications")] : []);
  const candidates = [
    resolveCommandPath("codex", { platform, path: refreshedEnvironment.PATH }),
    ...(platform === "win32"
      ? [
          installDir ? join(installDir, "codex.exe") : undefined,
          join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
          join(localAppData, "Microsoft", "WinGet", "Links", "codex.exe"),
        ]
      : []),
    ...applicationDirs.flatMap((root) => [
      join(root, "ChatGPT.app", "Contents", "Resources", "codex"),
      join(root, "Codex.app", "Contents", "Resources", "codex"),
    ]),
    resolve(homeDir, ".local", "bin", "codex"),
  ];
  const candidate = candidates.find((candidate): candidate is string =>
    Boolean(candidate && isRunnableCodexCommand(candidate, platform)),
  );
  if (candidate || platform !== "win32") return candidate;
  return windowsAppCodexCandidates(refreshedEnvironment, probe.windowsQuery).find((path) =>
    isRunnableCodexCommand(path, platform),
  );
}

function isRunnableCodexCommand(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
