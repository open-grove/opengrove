import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

let cachedMachineIdentity: string | undefined;

/**
 * Returns a stable, non-reversible identifier for the current machine. The raw
 * operating-system identifier never leaves this process or the local lock
 * file. A hostname fallback keeps unsupported platforms working, while known
 * desktop platforms survive hostname and network changes.
 */
export function localMachineIdentity(): string {
  if (cachedMachineIdentity) return cachedMachineIdentity;
  const raw = platformMachineIdentity() || fallbackMachineIdentity();
  cachedMachineIdentity = `machine-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
  return cachedMachineIdentity;
}

function platformMachineIdentity(): string | undefined {
  if (process.platform === "linux") {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = readFileSync(path, "utf8").trim();
        if (value) return `linux:${value}`;
      } catch {
        // non-critical-fallback: try the next OS machine-id source.
      }
    }
    return undefined;
  }
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/u);
      return match?.[1] ? `darwin:${match[1]}` : undefined;
    } catch {
      // non-critical-fallback: unsupported macOS environments use the hostname-derived identity.
      return undefined;
    }
  }
  if (process.platform === "win32") {
    try {
      const output = execFileSync(
        "reg.exe",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      const match = output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/iu);
      return match?.[1]?.trim() ? `win32:${match[1].trim()}` : undefined;
    } catch {
      // non-critical-fallback: restricted Windows environments use the hostname-derived identity.
      return undefined;
    }
  }
  return undefined;
}

function fallbackMachineIdentity(): string {
  return `fallback:${process.platform}:${process.arch}:${hostname()}`;
}
