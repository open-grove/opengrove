import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCookieAuthSession, type OpenGroveCookieAuthSession } from "#client";
import { APP_CONFIG_DIR } from "../identity.js";
import { writePrivateJsonAtomically } from "../storage/private-file.js";

const CLI_AUTH_STATE_VERSION = 1;
const AUTH_COOKIE_NAME = /^opengrove_auth_[a-z0-9_]+$/u;

export interface CliAuthState {
  version: 1;
  bridgeApiUrl: string;
  stateId: string;
  email?: string;
  cookies: Record<string, string>;
  savedAt: string;
}

export function defaultCliAuthPath(): string {
  return join(homedir(), APP_CONFIG_DIR, "cli-auth.json");
}

export function readCliAuthState(path = defaultCliAuthPath()): CliAuthState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== CLI_AUTH_STATE_VERSION) return undefined;
    if (typeof parsed.bridgeApiUrl !== "string" || typeof parsed.stateId !== "string") return undefined;
    const bridgeApiUrl = parsed.bridgeApiUrl.trim();
    const stateId = parsed.stateId.trim();
    if (!bridgeApiUrl || !stateId) return undefined;
    const cookies = Object.fromEntries(
      Object.entries(isRecord(parsed.cookies) ? parsed.cookies : {}).filter(
        (entry): entry is [string, string] =>
          AUTH_COOKIE_NAME.test(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1]),
      ),
    );
    return {
      version: CLI_AUTH_STATE_VERSION,
      bridgeApiUrl,
      stateId,
      ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
      cookies,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

export function writeCliAuthState(state: Omit<CliAuthState, "version" | "savedAt">, path = defaultCliAuthPath()): void {
  writePrivateJsonAtomically(path, {
    version: CLI_AUTH_STATE_VERSION,
    ...state,
    savedAt: new Date().toISOString(),
  } satisfies CliAuthState);
}

export function deleteCliAuthState(path = defaultCliAuthPath()): void {
  rmSync(path, { force: true });
}

export function createPersistedCliAuthSession(
  state: CliAuthState,
  path = defaultCliAuthPath(),
): OpenGroveCookieAuthSession {
  return createCookieAuthSession({
    cookies: state.cookies,
    onChange: (cookies) => {
      writeCliAuthState(
        {
          bridgeApiUrl: state.bridgeApiUrl,
          stateId: state.stateId,
          ...(state.email ? { email: state.email } : {}),
          cookies: { ...cookies },
        },
        path,
      );
    },
  });
}

export function hasCliAuthCookies(state: CliAuthState | undefined): state is CliAuthState {
  return Boolean(state && Object.keys(state.cookies).length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
