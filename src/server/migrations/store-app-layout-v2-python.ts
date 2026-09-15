import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/**
 * Supports: OpenGrove <=0.6.5 Store Apps with generated venv text files (#102).
 * Remove when: all supported upgrade sources already use layout v2 (OpenGrove >=0.6.6).
 * Same-machine relocation preserves installed packages; it neither
 * runs an installer nor claims general Python environment portability.
 * https://docs.python.org/3.13/library/venv.html#how-venvs-work
 */
export function isStoreAppPythonLauncher(path: string): boolean {
  const configFile = basename(path) === "pyvenv.cfg";
  if (!configFile && !["bin", "Scripts"].includes(basename(dirname(path)))) return false;
  const root = configFile ? dirname(path) : dirname(dirname(path));
  try {
    return lstatSync(join(root, "pyvenv.cfg")).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export function relocatedStoreAppPythonFile(source: string, target: string, content: Buffer): Buffer {
  if (!isStoreAppPythonLauncher(source)) return content;
  const configFile = basename(source) === "pyvenv.cfg";
  const environment = configFile ? dirname(source) : dirname(dirname(source));
  const configuration = join(environment, "pyvenv.cfg");
  let config: string;
  try {
    const stat = lstatSync(configuration);
    if (!stat.isFile() || stat.size > 64 * 1024) return content;
    config = readFileSync(configuration, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return content;
    throw error;
  }
  if (!/^home\s*=\s*\S.+$/m.test(config) || !/^include-system-site-packages\s*=\s*(?:true|false)\s*$/m.test(config))
    return content;
  if (content.includes(0)) return content;
  const text = content.toString("utf8");
  if (!Buffer.from(text).equals(content)) return content;
  if (!configFile && !text.startsWith("#!") && !/^activate(?:\.(?:bat|csh|fish|ps1))?$/i.test(basename(source)))
    return content;
  const targetEnvironment = configFile ? dirname(target) : dirname(dirname(target));
  // Generated activation templates use several shell syntaxes. Reject paths we
  // cannot substitute safely before copying, rather than introduce shell code.
  if (/["'`$\r\n]/.test(targetEnvironment) || (process.platform !== "win32" && targetEnvironment.includes("\\")))
    throw new Error("store_app_layout_python_path_unsupported");
  const oldPaths = [...new Set([environment, realpathSync.native(environment)])];
  let updated = text;
  for (const oldPath of oldPaths) {
    if (!configFile && process.platform !== "win32") {
      const header = new RegExp(
        `^#!${escapeRegExp(oldPath + sep + "bin" + sep)}(python(?:\\d+(?:\\.\\d+)*)?)([ \\t][^\\r\\n]*)?(?:\\r?\\n|$)`,
      );
      const match = updated.match(header);
      if (match) {
        const python = join(targetEnvironment, "bin", match[1]!);
        const argumentsText = (match[2] ?? "").trim();
        const argumentsList = argumentsText
          ? argumentsText
              .split(/\s+/)
              .map((arg) => ` '${arg.replaceAll("'", "'\\''")}'`)
              .join("")
          : "";
        // A shell/Python trampoline also supports long paths and spaces, unlike
        // a direct kernel shebang. The Python body remains byte-for-byte intact.
        updated = `#!/bin/sh\n'''exec' "${python}"${argumentsList} "$0" "$@"\n' '''\n${updated.slice(match[0].length)}`;
      }
    }
    updated = updated.replace(new RegExp(`${escapeRegExp(oldPath)}(?=[\\\\/\\s"']|$)`, "g"), () => targetEnvironment);
  }
  return updated === text ? content : Buffer.from(updated);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
