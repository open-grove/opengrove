import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Stats } from "node:fs";

const execFileAsync = promisify(execFile);

export type LocalPathAction = "system" | "reveal";

export interface LocalPathActionDependencies {
  platform: NodeJS.Platform;
  stat(path: string): Promise<Pick<Stats, "isDirectory">>;
  run(file: string, args: string[]): Promise<void>;
  launch(file: string, args: string[]): Promise<void>;
}

const defaultDependencies: LocalPathActionDependencies = {
  platform: process.platform,
  stat,
  run: async (file, args) => {
    await execFileAsync(file, args, { timeout: 10_000 });
  },
  launch: launchDetached,
};

export async function openLocalPath(
  path: string,
  action: LocalPathAction,
  dependencies: LocalPathActionDependencies = defaultDependencies,
): Promise<void> {
  if (dependencies.platform === "darwin") {
    await dependencies.run("open", action === "reveal" ? ["-R", path] : [path]);
    return;
  }

  if (dependencies.platform === "win32") {
    if (action === "system") {
      await dependencies.run("cmd", ["/d", "/s", "/c", "start", "", path]);
      return;
    }
    const directory = (await dependencies.stat(path)).isDirectory();
    await dependencies.launch("explorer.exe", directory ? [path] : [`/select,${path}`]);
    return;
  }

  const target = action === "reveal" && !(await dependencies.stat(path)).isDirectory() ? dirname(path) : path;
  await dependencies.run("xdg-open", [target]);
}

async function launchDetached(file: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      child.unref();
      resolve();
    });
  });
}
