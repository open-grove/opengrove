import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const SUPPORTED_APP_CLI_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
  "linux-arm64",
  "linux-x64",
] as const;

export type AppCliTargetKey = (typeof SUPPORTED_APP_CLI_TARGETS)[number];

export interface AppCliTargetFileIssue {
  code: "missing" | "not_file" | "not_executable" | "outside_app" | "format_mismatch" | "arch_mismatch" | "unreadable";
  detail: string;
}

export interface AppCliTargetValidationOptions {
  appRoot?: string;
  hostPlatform?: NodeJS.Platform;
}

export function appCliTargetKey(platform: NodeJS.Platform, arch: NodeJS.Architecture): AppCliTargetKey | undefined {
  const key = `${platform}-${arch}`;
  return SUPPORTED_APP_CLI_TARGETS.find((candidate) => candidate === key);
}

export function isSafeAppCliTargetPath(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return false;
  }
  return !normalized.split("/").some((segment) => segment === "..");
}

export function resolveAppCliTargetPath(appRoot: string, source: string): string | undefined {
  if (!isSafeAppCliTargetPath(source)) return undefined;
  const target = resolve(appRoot, source);
  const targetRelative = relative(appRoot, target);
  return targetRelative === "" || (!targetRelative.startsWith("..") && !isAbsolute(targetRelative))
    ? target
    : undefined;
}

export function validateAppCliTargetFile(
  file: string,
  target: AppCliTargetKey,
  options: AppCliTargetValidationOptions = {},
): AppCliTargetFileIssue[] {
  if (!existsSync(file)) {
    return [{ code: "missing", detail: "file does not exist" }];
  }
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    return [{ code: "unreadable", detail: error instanceof Error ? error.message : String(error) }];
  }
  if (!stat.isFile()) {
    return [{ code: "not_file", detail: "path is not a regular file" }];
  }
  if (options.appRoot) {
    try {
      const realRoot = realpathSync(options.appRoot);
      const realFile = realpathSync(file);
      const realRelative = relative(realRoot, realFile);
      if (realRelative !== "" && (realRelative.startsWith("..") || isAbsolute(realRelative))) {
        return [{ code: "outside_app", detail: "resolved path escapes the App root" }];
      }
    } catch (error) {
      return [{ code: "unreadable", detail: error instanceof Error ? error.message : String(error) }];
    }
  }
  const issues: AppCliTargetFileIssue[] = [];
  if (
    (options.hostPlatform ?? process.platform) !== "win32" &&
    !target.startsWith("win32-") &&
    (stat.mode & 0o111) === 0
  ) {
    issues.push({ code: "not_executable", detail: "Unix execute permission is missing" });
  }
  let header: Buffer;
  try {
    const descriptor = openSync(file, "r");
    try {
      header = Buffer.alloc(Math.min(Math.max(stat.size, 64), 16 * 1024));
      const bytesRead = readSync(descriptor, header, 0, header.length, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    issues.push({ code: "unreadable", detail: error instanceof Error ? error.message : String(error) });
    return issues;
  }
  const binary = inspectNativeBinary(header);
  const expectedFormat = target.startsWith("linux-") ? "elf" : target.startsWith("win32-") ? "pe" : "mach-o";
  if (binary.format !== expectedFormat) {
    issues.push({
      code: "format_mismatch",
      detail: `expected ${expectedFormat}, found ${binary.format}`,
    });
    return issues;
  }
  const expectedArch = target.endsWith("-arm64") ? "arm64" : "x64";
  if (!binary.architectures.includes(expectedArch)) {
    issues.push({
      code: "arch_mismatch",
      detail: `expected ${expectedArch}, found ${binary.architectures.join("+") || "unknown"}`,
    });
  }
  return issues;
}

function inspectNativeBinary(header: Buffer): {
  format: "elf" | "pe" | "mach-o" | "unknown";
  architectures: Array<"arm64" | "x64">;
} {
  if (header.length >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (header[4] !== 2 || header[5] !== 1) return { format: "elf", architectures: [] };
    return { format: "elf", architectures: architectureFromElfMachine(header.readUInt16LE(18)) };
  }
  if (header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= header.length &&
      header.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))
    ) {
      return { format: "pe", architectures: architectureFromPeMachine(header.readUInt16LE(peOffset + 4)) };
    }
    return { format: "pe", architectures: [] };
  }
  if (header.length >= 8) {
    const magic = header.readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const entrySize = magic === 0xcafebabf ? 32 : 20;
      const architectures = new Set<"arm64" | "x64">();
      const count = Math.min(header.readUInt32BE(4), 64);
      for (let index = 0; index < count; index += 1) {
        const offset = 8 + index * entrySize;
        if (offset + 4 > header.length) break;
        for (const arch of architectureFromMachCpu(header.readUInt32BE(offset))) architectures.add(arch);
      }
      return { format: "mach-o", architectures: [...architectures] };
    }
    if (magic === 0xcffaedfe || magic === 0xfeedfacf) {
      const littleEndian = magic === 0xcffaedfe;
      const cpu = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4);
      return { format: "mach-o", architectures: architectureFromMachCpu(cpu) };
    }
  }
  return { format: "unknown", architectures: [] };
}

function architectureFromElfMachine(machine: number): Array<"arm64" | "x64"> {
  if (machine === 0x3e) return ["x64"];
  if (machine === 0xb7) return ["arm64"];
  return [];
}

function architectureFromPeMachine(machine: number): Array<"arm64" | "x64"> {
  if (machine === 0x8664) return ["x64"];
  if (machine === 0xaa64) return ["arm64"];
  return [];
}

function architectureFromMachCpu(cpu: number): Array<"arm64" | "x64"> {
  if (cpu === 0x01000007) return ["x64"];
  if (cpu === 0x0100000c) return ["arm64"];
  return [];
}
