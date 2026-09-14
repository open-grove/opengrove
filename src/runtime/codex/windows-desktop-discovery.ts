import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { windowsEnvironmentValue } from "../../environment/windows-discovery.js";

interface DesktopCliSnapshot {
  command?: string;
  pending?: Promise<string | undefined>;
}

const snapshots = new Map<string, DesktopCliSnapshot>();

// Desktop compatibility boundary: executable generations can live outside the
// protected Store package, under the user runtime root recognized upstream:
// https://github.com/openai/codex/blob/f5a3dc55404ddc066a4e4a65602fee166ecc46b3/codex-rs/windows-sandbox-rs/src/bin/setup_main/win/setup_runtime_bin.rs#L95
// Retire this layout lookup when the desktop app provides a stable CLI entry.
function desktopBinDirectory(environment: NodeJS.ProcessEnv, homeDir: string): string {
  const localAppData = windowsEnvironmentValue(environment, "LOCALAPPDATA") || join(homeDir, "AppData", "Local");
  return join(localAppData, "OpenAI", "Codex", "bin");
}

/** Ordinary command resolution only reads the last successfully validated path. */
export function windowsDesktopCodexCommand(environment: NodeJS.ProcessEnv, homeDir = homedir()): string | undefined {
  return snapshots.get(desktopBinDirectory(environment, homeDir))?.command;
}

/** Runs inside the existing throttled/forceable Windows discovery refresh. */
export function refreshWindowsDesktopCodexCommand(
  environment: NodeJS.ProcessEnv,
  homeDir = homedir(),
): Promise<string | undefined> {
  const root = desktopBinDirectory(environment, homeDir);
  let snapshot = snapshots.get(root);
  if (!snapshot) {
    snapshot = {};
    snapshots.set(root, snapshot);
  }
  if (snapshot.pending) return snapshot.pending;
  const current = snapshot;
  current.pending = discoverDesktopCli(root, environment)
    .then((command) => {
      current.command = command;
      return command;
    })
    .finally(() => {
      current.pending = undefined;
    });
  return current.pending;
}

async function discoverDesktopCli(root: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[windows-discovery] cannot read desktop CLI directory ${root}: ${String(error)}`);
    }
    return undefined;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const command = join(root, entry.name, "codex.exe");
        try {
          const file = await stat(command);
          return file.isFile() ? { command, modifiedAt: file.mtimeMs } : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn(`[windows-discovery] cannot inspect desktop CLI ${command}: ${String(error)}`);
          }
          return undefined;
        }
      }),
  );
  // Hash directory names have no version ordering. Prefer recently updated
  // files, and keep trying older candidates when one cannot actually execute.
  const ordered = candidates
    .filter((candidate) => candidate !== undefined)
    .sort((left, right) => right.modifiedAt - left.modifiedAt || left.command.localeCompare(right.command));
  for (const { command } of ordered) {
    if (await validateDesktopCli(command, environment)) return command;
  }
  return undefined;
}

function validateDesktopCli(command: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = execFile(
      command,
      ["--version"],
      { env: environment, encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const valid = !error && /^codex(?:-cli)?\s+\d+\.\d+\.\d+\b/im.test(`${stdout}\n${stderr}`);
        if (!valid) {
          console.warn(
            `[windows-discovery] desktop CLI validation failed for ${command}: ${error?.code ?? "unrecognized version output"}`,
          );
        }
        resolve(valid);
      },
    );
    child.stdin?.end();
  }).catch((error: unknown) => {
    console.warn(`[windows-discovery] cannot start desktop CLI ${command}: ${String(error)}`);
    return false;
  });
}
