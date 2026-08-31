import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readAppEnv } from "../../identity.js";
import { resolveCommandPath, type CommandPathProbe } from "../../kernel/discovery.js";

export interface CodexCommandPathProbe {
  platform?: NodeJS.Platform;
  homeDir?: string;
  applicationDirs?: string[];
  envPath?: string;
  commandPath?: CommandPathProbe;
}

export function resolveCodexCommandPath(probe: CodexCommandPathProbe = {}): string | undefined {
  const platform = probe.platform ?? process.platform;
  const homeDir = probe.homeDir ?? homedir();
  const commandPath = { platform, ...probe.commandPath };
  const envPath = probe.envPath ?? readAppEnv("CODEX_BIN")?.trim();
  const resolvedEnvPath = resolveCommandPath(envPath, commandPath);
  if (envPath) {
    return resolvedEnvPath && isRunnableCodexCommand(resolvedEnvPath, platform) ? resolvedEnvPath : undefined;
  }

  const applicationDirs =
    probe.applicationDirs ?? (platform === "darwin" ? ["/Applications", join(homeDir, "Applications")] : []);
  const candidates = [
    resolveCommandPath("codex", commandPath),
    ...applicationDirs.flatMap((root) => [
      join(root, "ChatGPT.app", "Contents", "Resources", "codex"),
      join(root, "Codex.app", "Contents", "Resources", "codex"),
    ]),
    resolve(homeDir, ".local", "bin", "codex"),
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && isRunnableCodexCommand(candidate, platform)),
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
