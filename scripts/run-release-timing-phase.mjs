import { execFileSync } from "node:child_process";
import { openReleaseTiming, runTimedPhase } from "./release-timing.mjs";

const args = parseArgs(process.argv.slice(2));
const timing = openReleaseTiming({
  path: args.timingFile,
  command: args.command,
  version: args.version,
  reset: args.reset,
});
try {
  runTimedPhase(timing, args.phase, () => {
    execFileSync(args.executable, args.executableArgs, { stdio: "inherit" });
  });
  if (args.finishRun) timing.finishRun();
} catch (error) {
  timing.finishRun({ status: "failed", error });
  process.exitCode = Number.isSafeInteger(error?.status) && error.status > 0 ? error.status : 1;
}

function parseArgs(values) {
  const result = { executableArgs: [], finishRun: false, reset: false };
  let separator = -1;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      separator = index;
      break;
    }
    if (value === "--reset") result.reset = true;
    else if (value === "--finish-run") result.finishRun = true;
    else if (value === "--timing-file") result.timingFile = readRequired(values, ++index, value);
    else if (value === "--command") result.command = readRequired(values, ++index, value);
    else if (value === "--version") result.version = readRequired(values, ++index, value);
    else if (value === "--phase") result.phase = readRequired(values, ++index, value);
    else throw new Error(`Unknown release timing phase option: ${value}`);
  }
  if (separator === -1 || !values[separator + 1]) {
    throw new Error("release timing phase requires a command after --");
  }
  result.executable = values[separator + 1];
  result.executableArgs = values.slice(separator + 2);
  for (const name of ["timingFile", "command", "version", "phase"]) {
    if (!result[name]) throw new Error(`release timing phase requires --${camelToKebab(name)}`);
  }
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}
