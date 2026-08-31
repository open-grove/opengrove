import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".bat", ".cmd", ".com", ".exe", ".ps1"]);
export const DIAGNOSTIC_CREDENTIAL_FILE_NAMES = [
  ".env",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  "auth.json",
  "auth-cookies.json",
  "bridge-settings.json",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "local-state.json",
  "local-state.sqlite",
  "local-state.sqlite-shm",
  "local-state.sqlite-wal",
] as const;
export const DIAGNOSTIC_SYSTEM_LOG_FILE_NAMES = [
  "bridge.log",
  "bridge-crash.log",
  "desktop-main.log",
  "desktop-restart.log",
] as const;
const DIAGNOSTIC_CREDENTIAL_FILE_NAME_SET = new Set<string>(DIAGNOSTIC_CREDENTIAL_FILE_NAMES);

export function diagnosticFileUrlToPath(value: string, targetPlatform: NodeJS.Platform = process.platform): string {
  return fileURLToPath(value, { windows: targetPlatform === "win32" });
}

export function isRuntimeExecutableFile(
  path: string,
  mode: number,
  targetPlatform: NodeJS.Platform = process.platform,
): boolean {
  if (targetPlatform === "win32") {
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase());
  }
  return (mode & 0o111) !== 0;
}

export function isDiagnosticCredentialPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (DIAGNOSTIC_CREDENTIAL_FILE_NAME_SET.has(name) || name.startsWith(".env.")) return true;
  const segments = path.replaceAll("\\", "/").toLowerCase().split("/");
  return (
    segments.includes("state-blobs") ||
    segments.includes("credentials") ||
    segments.includes(".ssh") ||
    segments.includes(".aws") ||
    segments.includes(".kube") ||
    segments.includes(".docker") ||
    /(?:^|[._-])(secret|token|credential)s?(?:[._-]|$)/i.test(name)
  );
}
