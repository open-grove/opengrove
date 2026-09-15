import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

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

export function relocatedStoreAppPythonFile(
  source: string,
  target: string,
  content: Buffer,
  relocatePath: (path: string) => string,
): Buffer {
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
  if (!/^home\s*=\s*\S.*$/m.test(config) || !/^include-system-site-packages\s*=\s*(?:true|false)\s*$/m.test(config))
    return content;
  if (content.includes(0)) return content;
  const text = content.toString("utf8");
  if (!Buffer.from(text).equals(content)) return content;
  if (!configFile && !text.startsWith("#!") && !/^activate(?:\.(?:bat|csh|fish|ps1))?$/i.test(basename(source)))
    return content;
  const targetEnvironment = configFile ? dirname(target) : dirname(dirname(target));
  // Generated activation templates use several shell syntaxes. Reject paths we
  // cannot substitute safely before copying, rather than introduce shell code.
  assertSupportedPythonPath(targetEnvironment);
  const oldPaths = [...new Set([environment, realpathSync.native(environment)])];
  let updated = text;
  if (configFile) {
    // Base interpreters can move with Program independently of the venv. These
    // fields use the same relocation and legacy-root checks as filesystem links.
    updated = updated.replace(
      /^((?:home|executable)[ \t]*=[ \t]*)([^\r\n]*?)([ \t]*)(?=\r?$)/gm,
      (_line, prefix: string, value: string, suffix: string) => prefix + relocatePath(value) + suffix,
    );
    updated = updated.replace(
      /^(command[ \t]*=[ \t]*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(.+?[/\\]python(?:\d+(?:\.\d+)*)?(?:\.exe)?))(?=[ \t]|\r?$)/gm,
      (
        _match,
        prefix: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        bare: string | undefined,
      ) => {
        const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
        const previous = doubleQuoted ?? singleQuoted ?? bare!;
        const python = relocatePath(previous);
        if (python !== previous) assertSupportedPythonPath(python);
        return prefix + quote + python + quote;
      },
    );
  } else {
    const header = /^#!(.+?[/\\]python(?:\d+(?:\.\d+)*)?(?:\.exe)?)([ \t][^\r\n]*)?(?:\r?\n|$)/;
    const match = updated.match(header);
    if (match && isAbsolute(match[1]!)) {
      const python = relocatePath(match[1]!);
      if (python !== match[1]) {
        assertSupportedPythonPath(python);
        if (process.platform === "win32") {
          updated = updated.replace(match[1]!, () => python);
        } else {
          const argumentsText = (match[2] ?? "").trim();
          const argumentsList = argumentsText
            ? argumentsText
                .split(/\s+/)
                .map((arg) => ` '${arg.replaceAll("'", "'\\''")}'`)
                .join("")
            : "";
          // A shell/Python trampoline supports long paths and spaces, unlike a
          // direct kernel shebang. The Python body remains byte-for-byte intact.
          updated = `#!/bin/sh\n'''exec' "${python}"${argumentsList} "$0" "$@"\n' '''\n${updated.slice(match[0].length)}`;
        }
      }
    }
    updated = updated.replace(
      /^('''exec'[ \t]+)(["'])([^\r\n]+?)\2/gm,
      (_match, prefix: string, quote: string, value: string) => {
        const python = relocatePath(value);
        if (python !== value) assertSupportedPythonPath(python);
        return prefix + quote + python + quote;
      },
    );
  }
  for (const oldPath of oldPaths) {
    updated = updated.replace(new RegExp(`${escapeRegExp(oldPath)}(?=[\\\\/\\s"']|$)`, "g"), () => targetEnvironment);
  }
  return updated === text ? content : Buffer.from(updated);
}

function assertSupportedPythonPath(path: string): void {
  if (/["'`$\r\n]/.test(path) || (process.platform !== "win32" && path.includes("\\")))
    throw new Error("store_app_layout_python_path_unsupported");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
