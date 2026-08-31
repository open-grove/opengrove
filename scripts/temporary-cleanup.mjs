import { rmSync } from "node:fs";

const transientWindowsRemovalErrors = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

export function removeTemporaryTree(path, { platform = process.platform, remove = rmSync, warn = console.warn } = {}) {
  try {
    remove(path, {
      recursive: true,
      force: true,
      maxRetries: platform === "win32" ? 20 : 3,
      retryDelay: 250,
    });
  } catch (error) {
    if (platform === "win32" && transientWindowsRemovalErrors.has(error?.code)) {
      warn(`temporary Windows release-gate directory remained locked and will be discarded with the runner: ${path}`);
      return;
    }
    throw error;
  }
}
