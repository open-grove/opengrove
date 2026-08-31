import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type AppCliDeclarationSource = "command" | "path" | "bin";

export interface NormalizedAppCliDeclaration {
  source: AppCliDeclarationSource;
  executable: string;
  fixedArgs: string[];
}

export interface AppCliNodeScriptArgument {
  index: number;
  value: string;
}

export type AppCliOwnedPathResolution =
  | { ok: true; path: string }
  | { ok: false; path: string; error: "missing" | "outside" };

const NODE_SOURCE_TEXT_OPTIONS = ["-e", "--eval", "-p", "--print"] as const;

const NODE_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  "-C",
  "--build-snapshot-config",
  "--conditions",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--cpu-prof-name",
  "--diagnostic-dir",
  "--disable-proto",
  "--dns-result-order",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-config-file",
  "--experimental-loader",
  "--experimental-sea-config",
  "--experimental-test-isolation",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--heap-prof-name",
  "--heapsnapshot-near-heap-limit",
  "--heapsnapshot-signal",
  "--icu-data-dir",
  "--import",
  "--input-type",
  "--inspect-port",
  "--loader",
  "--localstorage-file",
  "--max-http-header-size",
  "--network-family-autoselection-attempt-timeout",
  "--openssl-config",
  "--redirect-warnings",
  "--report-dir",
  "--report-directory",
  "--report-filename",
  "--report-signal",
  "--secure-heap",
  "--secure-heap-min",
  "--snapshot-blob",
  "--test-concurrency",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--title",
  "--tls-cipher-list",
  "--tls-keylog",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--unhandled-rejections",
  "--v8-pool-size",
  "--watch-path",
  "-r",
  "--require",
]);

export function normalizeAppCliDeclaration(value: unknown): NormalizedAppCliDeclaration | undefined {
  if (typeof value === "string") {
    return normalizeAppCliSource("command", value, []);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const declaration = value as Record<string, unknown>;
  const manifestArgs = stringArray(declaration.args);
  for (const source of ["path", "command", "bin"] as const) {
    const declaredValue = stringValue(declaration[source]);
    if (!declaredValue) continue;
    return normalizeAppCliSource(source, declaredValue, manifestArgs);
  }
  return undefined;
}

export function splitAppCliCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && value[index + 1] === quote) {
        current += quote;
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function isAppCliDeclaredPath(value: string): boolean {
  return isAppCliExplicitPath(value) || value.includes("/") || value.includes("\\");
}

export function isAppCliExplicitPath(value: string): boolean {
  return (
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

export function appCliNodeScriptArgument(
  declaration: NormalizedAppCliDeclaration | undefined,
): AppCliNodeScriptArgument | undefined {
  if (!declaration || !isNodeExecutable(declaration.executable)) return undefined;
  for (let index = 0; index < declaration.fixedArgs.length; index += 1) {
    const argument = declaration.fixedArgs[index]?.trim() ?? "";
    if (!argument) continue;
    if (argument === "--") {
      const script = declaration.fixedArgs[index + 1]?.trim();
      return script ? { index: index + 1, value: script } : undefined;
    }
    if (isNodeSourceTextOption(argument)) return undefined;
    if (NODE_OPTIONS_WITH_SEPARATE_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return { index, value: argument };
  }
  return undefined;
}

export function resolveAppCliOwnedPath(appRoot: string, value: string): AppCliOwnedPathResolution {
  const path = isAbsolute(value) ? value : resolve(appRoot, value);
  if (!isPathInside(appRoot, path)) return { ok: false, path, error: "outside" };
  if (!existsSync(path)) return { ok: false, path, error: "missing" };
  try {
    const realRoot = realpathSync.native(appRoot);
    const realPath = realpathSync.native(path);
    if (!isPathInside(realRoot, realPath)) return { ok: false, path, error: "outside" };
  } catch {
    return { ok: false, path, error: "missing" };
  }
  return { ok: true, path };
}

function normalizeAppCliSource(
  source: AppCliDeclarationSource,
  declaredValue: string,
  manifestArgs: string[],
): NormalizedAppCliDeclaration | undefined {
  const tokens = source === "bin" ? [declaredValue.trim()] : splitAppCliCommandLine(declaredValue.trim());
  const executable = tokens[0];
  if (!executable) return undefined;
  return {
    source,
    executable,
    fixedArgs: [...tokens.slice(1), ...manifestArgs],
  };
}

function isNodeExecutable(value: string): boolean {
  const basename = value.replaceAll("\\", "/").split("/").pop() ?? "";
  return /^(?:node|nodejs)(?:\.exe)?$/i.test(basename);
}

function isNodeSourceTextOption(value: string): boolean {
  return NODE_SOURCE_TEXT_OPTIONS.some(
    (option) =>
      value === option ||
      value.startsWith(`${option}=`) ||
      (option.length === 2 && value.startsWith(option) && value.length > option.length),
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
