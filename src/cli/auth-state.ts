import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCookieAuthSession, type OpenGroveCookieAuthSession } from "#client";
import { APP_CONFIG_DIR } from "../identity.js";
import { writePrivateJsonAtomically } from "../storage/private-file.js";
import { acquireStateFileLock, isStateFileLockError } from "../storage/state-file-lock.js";
import { OpenGroveCliError } from "./errors.js";

const CLI_AUTH_STATE_VERSION = 1;
const AUTH_COOKIE_NAME = /^opengrove_auth_[a-z0-9_]+$/u;
const AUTH_STATE_LOCK_TIMEOUT_MS = 5_000;
const AUTH_STATE_LOCK_RETRY_MS = 20;

export interface CliAuthState {
  version: 1;
  revision: string;
  bridgeApiUrl: string;
  stateId: string;
  email?: string;
  cookies: Record<string, string>;
  savedAt: string;
}

export type PersistedCliAuthSession = OpenGroveCookieAuthSession &
  Readonly<{
    clearIfCurrent(): Promise<boolean>;
  }>;

type NewCliAuthState = Omit<CliAuthState, "version" | "revision" | "savedAt">;

export function defaultCliAuthPath(): string {
  return join(homedir(), APP_CONFIG_DIR, "cli-auth.json");
}

export function readCliAuthState(path = defaultCliAuthPath()): CliAuthState | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
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
      revision:
        typeof parsed.revision === "string" && parsed.revision
          ? parsed.revision
          : `legacy-${createHash("sha256").update(raw).digest("hex")}`,
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

export async function writeCliAuthState(state: NewCliAuthState, path = defaultCliAuthPath()): Promise<CliAuthState> {
  return withAuthStateLock(path, () => persistCliAuthState(state, path));
}

export function createPersistedCliAuthSession(
  state: CliAuthState,
  path = defaultCliAuthPath(),
): PersistedCliAuthSession {
  let current: CliAuthState | undefined = state;
  const auth = createCookieAuthSession({
    cookies: state.cookies,
    onChange: async (cookies) => {
      if (!current) return;
      current = await replaceCliAuthCookiesIfCurrent(current, cookies, path);
    },
  });
  return {
    ...auth,
    async clearIfCurrent() {
      if (!current) return false;
      const deleted = await deleteCliAuthStateIfCurrent(current, path);
      if (deleted) current = undefined;
      return deleted;
    },
  };
}

export function hasCliAuthCookies(state: CliAuthState | undefined): state is CliAuthState {
  return Boolean(state && Object.keys(state.cookies).length > 0);
}

async function replaceCliAuthCookiesIfCurrent(
  expected: CliAuthState,
  cookies: Readonly<Record<string, string>>,
  path: string,
): Promise<CliAuthState | undefined> {
  return withAuthStateLock(path, () => {
    const current = readCliAuthState(path);
    if (!sameRevision(current, expected)) return undefined;
    if (Object.keys(cookies).length === 0) {
      rmSync(path, { force: true });
      return undefined;
    }
    return persistCliAuthState(
      {
        bridgeApiUrl: expected.bridgeApiUrl,
        stateId: expected.stateId,
        ...(expected.email ? { email: expected.email } : {}),
        cookies: { ...cookies },
      },
      path,
    );
  });
}

async function deleteCliAuthStateIfCurrent(expected: CliAuthState, path: string): Promise<boolean> {
  return withAuthStateLock(path, () => {
    if (!sameRevision(readCliAuthState(path), expected)) return false;
    rmSync(path, { force: true });
    return true;
  });
}

function persistCliAuthState(state: NewCliAuthState, path: string): CliAuthState {
  const persisted = {
    version: CLI_AUTH_STATE_VERSION,
    revision: randomUUID(),
    ...state,
    savedAt: new Date().toISOString(),
  } satisfies CliAuthState;
  writePrivateJsonAtomically(path, persisted);
  return persisted;
}

async function withAuthStateLock<T>(path: string, action: () => T): Promise<T> {
  const deadline = Date.now() + AUTH_STATE_LOCK_TIMEOUT_MS;
  for (;;) {
    let lock: ReturnType<typeof acquireStateFileLock>;
    try {
      lock = acquireStateFileLock(path);
    } catch (error) {
      if (isStateFileLockError(error) && error.code === "STATE_LOCKED" && !error.selfHeld && Date.now() < deadline) {
        await delay(AUTH_STATE_LOCK_RETRY_MS);
        continue;
      }
      throw new OpenGroveCliError(
        "config",
        "cli_auth_state_locked",
        `Could not safely update the CLI login state at ${path}.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    try {
      return action();
    } finally {
      lock.release();
    }
  }
}

function sameRevision(current: CliAuthState | undefined, expected: CliAuthState): current is CliAuthState {
  return Boolean(current && current.revision === expected.revision && current.stateId === expected.stateId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
