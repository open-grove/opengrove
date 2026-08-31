import { realpathSync } from "node:fs";

export function processCommandMatchesExecutable(command, executablePath, options = {}) {
  const canonicalize = options.canonicalize ?? realpathSync.native;
  const candidates = new Set([executablePath]);
  try {
    candidates.add(canonicalize(executablePath));
  } catch {
    // A process can exit between the process-table read and path resolution.
  }

  const normalized = command.trimStart();
  return [...candidates].some(
    (candidate) =>
      normalized === candidate ||
      normalized.startsWith(`${candidate} `) ||
      normalized === `"${candidate}"` ||
      normalized.startsWith(`"${candidate}" `),
  );
}
