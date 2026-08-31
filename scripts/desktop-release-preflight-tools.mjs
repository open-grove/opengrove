import { execFileSync } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { delimiter } from "node:path";

export function macReleaseToolProblems({
  ossutilBin = process.env.OPENGROVE_OSSUTIL_BIN || "ossutil",
  commandAvailable = defaultCommandAvailable,
  xcrunToolAvailable = defaultXcrunToolAvailable,
} = {}) {
  const problems = [];
  if (!commandAvailable(ossutilBin)) problems.push(`ossutil is not executable: ${ossutilBin}`);
  if (!commandAvailable("spctl")) problems.push("spctl is not available in PATH");
  if (!commandAvailable("hdiutil")) problems.push("hdiutil is not available in PATH");
  if (!commandAvailable("xcrun")) problems.push("xcrun is not available in PATH");
  if (!xcrunToolAvailable("stapler")) problems.push("stapler is not discoverable via xcrun --find stapler");
  return problems;
}

function defaultCommandAvailable(command) {
  const candidates = command.includes("/")
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => `${directory}/${command}`);
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function defaultXcrunToolAvailable(tool) {
  const candidates = [
    "/usr/bin/xcrun",
    ...(process.env.PATH ?? "").split(delimiter).map((directory) => `${directory}/xcrun`),
  ];
  const xcrun = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!xcrun) return false;
  try {
    execFileSync(xcrun, ["--find", tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
