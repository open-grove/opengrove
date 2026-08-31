import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { appEnvName, readAppEnv } from "../../identity.js";
import { resolveCommandPath } from "../../kernel/discovery.js";
import { normalizeOptionalString } from "./prompt.js";

export interface HermesGatewayLaunchOptions {
  command: string;
  gatewayCommand?: string;
  gatewayArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface HermesGatewayLaunch {
  command: string;
  args: string[];
  pythonSourceRoot?: string;
}

export function resolveHermesTuiGatewayLaunch(options: HermesGatewayLaunchOptions): HermesGatewayLaunch {
  const explicitCommand = normalizeOptionalString(options.gatewayCommand);
  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: options.gatewayArgs ?? [],
    };
  }

  const explicitPython =
    normalizeOptionalString(options.env?.[appEnvName("HERMES_TUI_GATEWAY_PYTHON")]) ??
    normalizeOptionalString(options.env?.HERMES_TUI_GATEWAY_PYTHON) ??
    normalizeOptionalString(readAppEnv("HERMES_TUI_GATEWAY_PYTHON")) ??
    normalizeOptionalString(process.env.HERMES_TUI_GATEWAY_PYTHON);
  if (explicitPython) {
    return hermesPythonGatewayLaunch(explicitPython);
  }

  const inferredPython = inferHermesGatewayPython(options.command);
  if (inferredPython) {
    return hermesPythonGatewayLaunch(inferredPython);
  }

  throw new Error(
    `Hermes TUI Gateway entry was not found. Set ${appEnvName("HERMES_TUI_GATEWAY_PYTHON")} to the Hermes venv python executable.`,
  );
}

function hermesPythonGatewayLaunch(python: string): HermesGatewayLaunch {
  return {
    command: python,
    args: ["-u", "-m", "tui_gateway.entry"],
    pythonSourceRoot: inferHermesPythonSourceRoot(python),
  };
}

function inferHermesGatewayPython(command: string): string | undefined {
  const resolved = resolveCommandPath(command) ?? (existsSync(command) ? resolve(command) : undefined);
  if (!resolved) return undefined;
  if (basename(resolved).startsWith("python")) return resolved;
  const siblingPython = resolve(dirname(resolved), "python");
  if (basename(resolved) === "hermes" && existsSync(siblingPython)) {
    return siblingPython;
  }
  try {
    const script = readFileSync(resolved, "utf8").slice(0, 4096);
    const match = script.match(/exec\s+["']([^"']*\/(?:venv\/)?bin\/hermes)["']/);
    const wrappedHermes = match?.[1];
    if (wrappedHermes) {
      const python = resolve(dirname(wrappedHermes), "python");
      if (existsSync(python)) return python;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function inferHermesPythonSourceRoot(python: string): string | undefined {
  const binDir = dirname(python);
  const maybeVenv = dirname(binDir);
  if (basename(maybeVenv) !== "venv") return undefined;
  const root = dirname(maybeVenv);
  return existsSync(root) ? root : undefined;
}
