import { existsSync } from "node:fs";
import { win32 } from "node:path";

// Product TypeScript uses resolveCommandInvocation for host-authored commands.
// Release scripts cannot import unbuilt TS, so this pre-build ESM counterpart
// accepts the same bare npm/npx names and additionally prefers npm's JS entry
// point when npm_execpath proves it exists. The cmd.exe fallback is only for
// repo-controlled arguments because cmd metacharacters follow different rules.

export function nodePackageManagerInvocation(manager, args, options = {}) {
  if (manager !== "npm" && manager !== "npx") {
    throw new Error(`Unsupported Node package manager command: ${manager}`);
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: manager, args };

  const environment = options.environment ?? process.env;
  const nodePath = options.nodePath ?? process.execPath;
  const pathExists = options.pathExists ?? existsSync;
  const npmExecPath = options.npmExecPath ?? environment.npm_execpath;
  const npmCliPath =
    npmExecPath && win32.basename(npmExecPath).toLowerCase() === "npm-cli.js" && pathExists(npmExecPath)
      ? npmExecPath
      : undefined;
  if (!npmCliPath) {
    return {
      command: options.comSpec ?? environment.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `${manager}.cmd`, ...args],
    };
  }
  const cliPath = manager === "npm" ? npmCliPath : win32.join(win32.dirname(npmCliPath), "npx-cli.js");
  if (!pathExists(cliPath)) {
    return {
      command: options.comSpec ?? environment.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `${manager}.cmd`, ...args],
    };
  }
  return {
    command: nodePath,
    args: [cliPath, ...args],
  };
}
