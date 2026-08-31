import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalPortableRelativePath, portablePathsOverlap } from "../app-builder/portable-path.js";

export const APP_RELEASE_BUILD_CONTRACT_FILE = ".opengrove-build.json";

export interface AppReleaseBuildContractValidation {
  ok: boolean;
  detail: string;
}

export interface AppReleaseBuildRecipe {
  schemaVersion: 1;
  workingDirectory: string;
  inputs: string[];
  outputs: string[];
  commands: string[][];
}

const MAX_BUILD_COMMANDS = 16;
const MAX_BUILD_COMMAND_ARGUMENTS = 64;
const MAX_BUILD_COMMAND_CHARACTERS = 8 * 1024;

export type AppReleaseBuildContractReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; recipe: AppReleaseBuildRecipe };

export function readAppReleaseBuildContract(appRoot: string): AppReleaseBuildContractReadResult {
  const path = resolve(appRoot, APP_RELEASE_BUILD_CONTRACT_FILE);
  return existsSync(path) ? parseAppReleaseBuildRecipe(appRoot) : { status: "missing" };
}

export function validateAppReleaseBuildContract(appRoot: string): AppReleaseBuildContractValidation {
  const result = readAppReleaseBuildContract(appRoot);
  if (result.status === "missing") return { ok: false, detail: "build_contract_missing" };
  if (result.status === "invalid") return { ok: false, detail: "build_contract_invalid" };
  return { ok: true, detail: "build_contract_valid" };
}

function parseAppReleaseBuildRecipe(appRoot: string): AppReleaseBuildContractReadResult {
  const path = resolve(appRoot, APP_RELEASE_BUILD_CONTRACT_FILE);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { status: "invalid" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid" };
  }
  const contract = value as Record<string, unknown>;
  const workingDirectory =
    typeof contract.workingDirectory === "string"
      ? canonicalPortableRelativePath(contract.workingDirectory)
      : undefined;
  const inputs = stringArray(contract.inputs) ? contract.inputs.map(canonicalPortableRelativePath) : [];
  const outputs = stringArray(contract.outputs) ? contract.outputs.map(canonicalPortableRelativePath) : [];
  if (
    contract.schemaVersion !== 1 ||
    !workingDirectory ||
    !pathIsDirectory(appRoot, workingDirectory) ||
    !stringArray(contract.inputs) ||
    !stringArray(contract.outputs) ||
    !commandArray(contract.commands) ||
    contract.inputs.length === 0 ||
    contract.outputs.length === 0 ||
    contract.commands.length === 0 ||
    Object.keys(contract).some(
      (key) => !["schemaVersion", "workingDirectory", "inputs", "outputs", "commands"].includes(key),
    )
  ) {
    return { status: "invalid" };
  }
  const commands = contract.commands as string[][];
  if (
    [...inputs, ...outputs].some((item) => !item || !pathExists(appRoot, item)) ||
    inputs.some((input) => outputs.some((output) => portablePathsOverlap(input!, output!))) ||
    outputs.some((output, index) => outputs.slice(index + 1).some((other) => portablePathsOverlap(output!, other!)))
  ) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    recipe: {
      schemaVersion: 1,
      workingDirectory,
      inputs: inputs as string[],
      outputs: outputs as string[],
      commands: commands.map((command) => [...command]),
    },
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function commandArray(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_BUILD_COMMANDS &&
    value.every(
      (command) =>
        Array.isArray(command) &&
        command.length > 0 &&
        command.length <= MAX_BUILD_COMMAND_ARGUMENTS &&
        typeof command[0] === "string" &&
        command[0].trim().length > 0 &&
        command.every((argument) => typeof argument === "string" && !argument.includes("\0")) &&
        command.reduce((total, argument) => total + argument.length, 0) <= MAX_BUILD_COMMAND_CHARACTERS &&
        !evaluatesCommandString(command),
    )
  );
}

function evaluatesCommandString(command: string[]): boolean {
  const parsed = unwrapCommandLaunchers(command);
  if (!parsed.ok) return true;
  const executable = commandBasename(parsed.command[0] ?? "");
  return new Set([
    "sh",
    "bash",
    "dash",
    "ksh",
    "zsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
  ]).has(executable);
}

function unwrapCommandLaunchers(command: string[]): { ok: true; command: string[] } | { ok: false } {
  let effective = command;
  for (let depth = 0; depth < 16; depth += 1) {
    const launcher = commandBasename(effective[0] ?? "");
    if (launcher === "busybox") {
      if (effective.length < 2 || effective[1]!.startsWith("-")) return { ok: false };
      effective = effective.slice(1);
      continue;
    }
    if (launcher !== "env") return { ok: true, command: effective };
    let index = 1;
    let commandFound = false;
    while (index < effective.length) {
      const argument = effective[index]!;
      if (argument === "--") {
        index += 1;
        commandFound = true;
        break;
      }
      if (argument === "-u" || argument === "--unset") {
        if (index + 1 >= effective.length) return { ok: false };
        index += 2;
        continue;
      }
      if (argument === "-i" || argument === "--ignore-environment" || argument.startsWith("--unset=")) {
        index += 1;
        continue;
      }
      if (argument.startsWith("-")) return { ok: false };
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
        index += 1;
        continue;
      }
      commandFound = true;
      break;
    }
    if (!commandFound || index >= effective.length) return { ok: false };
    effective = effective.slice(index);
  }
  return { ok: false };
}

function commandBasename(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
}

function pathExists(appRoot: string, value: string): boolean {
  try {
    const path = resolveInside(appRoot, value);
    const stat = statSync(path);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

function pathIsDirectory(appRoot: string, value: string): boolean {
  try {
    return statSync(resolveInside(appRoot, value)).isDirectory();
  } catch {
    return false;
  }
}

function resolveInside(appRoot: string, value: string): string {
  const root = resolve(appRoot);
  const target = resolve(root, value);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot.startsWith("..") || resolve(root, pathFromRoot) !== target) {
    throw new Error("build_contract_path_invalid");
  }
  return target;
}
