import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readAppEnv } from "../../identity.js";
import { resolveCommandInvocation, resolveCommandPath, resolveUsableCommandPath } from "../../kernel/discovery.js";

export function resolveHermesCommandPath(): string | undefined {
  const candidate = resolveInstalledHermesCommandPath();
  return resolveUsableCommandPath(candidate);
}

export function resolveInstalledHermesCommandPath(): string | undefined {
  const envPath = readAppEnv("HERMES_BIN")?.trim();
  if (envPath) return resolveCommandPath(envPath);

  const systemHermes = resolveCommandPath("hermes");
  if (systemHermes) {
    return systemHermes;
  }

  for (const candidate of [
    resolve(homedir(), ".local", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
    "/usr/bin/hermes",
  ]) {
    const resolvedCandidate = resolveCommandPath(candidate);
    if (resolvedCandidate) return resolvedCandidate;
  }
  return undefined;
}

export function hermesHealth(command: string): { ok: boolean; message: string } {
  try {
    const invocation = resolveCommandInvocation(command, ["--version"]);
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    if (result.status === 0) {
      const version = (result.stdout || result.stderr || "").trim();
      return { ok: true, message: version || "Hermes CLI is available." };
    }
    return {
      ok: false,
      message: (result.stderr || result.stdout || "").trim() || `Hermes CLI exited with ${result.status}.`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
