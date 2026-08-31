import { existsSync } from "node:fs";
import { join } from "node:path";

export function tarCommand(): string {
  if (process.platform !== "win32") return "tar";

  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidates = [join(windowsRoot, "Sysnative", "tar.exe"), join(windowsRoot, "System32", "tar.exe")];
  return candidates.find((candidate) => existsSync(candidate)) ?? "tar";
}
