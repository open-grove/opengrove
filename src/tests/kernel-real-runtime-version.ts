import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCommandInvocation } from "../kernel/discovery.js";

const execute = promisify(execFile);

// CI needs a complete engine identity even on a cold runner. The UI discovery
// cache intentionally has a shorter responsiveness deadline and can omit it.
export async function probeRealRuntimeVersion(command: string, args = ["--version"]): Promise<string> {
  const invocation = resolveCommandInvocation(command, args);
  const result = await execute(invocation.command, invocation.args, { timeout: 15_000, maxBuffer: 64 * 1024 });
  const version = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!version) throw new Error("Runtime --version returned no engine identity");
  return version;
}
