import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function readHermesFailureDiagnostic(isolatedHome: string | undefined): string | undefined {
  const sessionsDir = isolatedHome ? resolve(isolatedHome, "sessions") : undefined;
  if (!sessionsDir || !existsSync(sessionsDir)) return undefined;
  try {
    const latestDump = readdirSync(sessionsDir)
      .filter((name) => name.startsWith("request_dump_") && name.endsWith(".json"))
      .map((name) => {
        const path = resolve(sessionsDir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
    if (!latestDump) return undefined;
    const parsed = JSON.parse(readFileSync(latestDump, "utf8")) as {
      reason?: unknown;
      error?: {
        message?: unknown;
        status_code?: unknown;
        code?: unknown;
      };
    };
    const reason = typeof parsed.reason === "string" ? parsed.reason : "request_failed";
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : undefined;
    const status = typeof parsed.error?.status_code === "number" ? String(parsed.error.status_code) : undefined;
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
    return [reason, status, code, message].filter(Boolean).join(": ");
  } catch {
    return undefined;
  }
}
