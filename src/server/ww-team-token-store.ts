import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writePrivateJsonAtomically } from "../storage/private-file.js";
import { appendSetCookie, parseCookieHeader, serializeCookie } from "./bridge-security.js";
import type { BridgeState } from "./bridge-types.js";
import { bridgeDataPath } from "./storage-paths.js";
import { canonicalWwIssuer } from "./ww-provider-local-state.js";

// A sibling of ww-provider.json rather than a field inside it. Every mutator in
// ww-provider-local-state.ts rebuilds the whole record field by field, so a new
// field there has to be carried forward in seven places and silently vanishes
// wherever it is forgotten. Keeping this in its own file also leaves that
// versioned production record untouched by what is purely a test-surface
// credential.
const WW_TEAM_TOKEN_FILE = "ww-team-token.json";
const WW_TEAM_TOKEN_VERSION = 1;
const TEAM_ADMISSION_COOKIE = "opengrove_auth_team";
const TEAM_ADMISSION_SECONDS = 24 * 60 * 60;
const MAX_TEAM_ADMISSIONS = 256;

interface TeamAdmission {
  issuer: string;
  tokenFingerprint: string;
  expiresAt: number;
}

// Possessing the install's stored token is not proof that a browser supplied it.
// Grants are per browser, expire after a day, and end when the Bridge restarts.
const admissionsByState = new WeakMap<BridgeState, Map<string, TeamAdmission>>();

interface WwTeamTokenState {
  version: typeof WW_TEAM_TOKEN_VERSION;
  issuer: string;
  token: string;
}

/**
 * Returns the stored team token only for a browser admitted to that issuer.
 * Repointing the Bridge or changing the shared token invalidates its grants.
 */
export function readWwTeamToken(state: BridgeState, baseUrl: string, request: IncomingMessage): string | undefined {
  const admissionId = parseCookieHeader(request.headers.cookie).get(TEAM_ADMISSION_COOKIE);
  if (!admissionId) return undefined;
  const admissions = admissionsByState.get(state);
  const admission = admissions?.get(admissionId);
  if (!admission) return undefined;
  const stored = readState(state);
  if (
    admission.expiresAt <= Date.now() ||
    !stored ||
    admission.issuer !== canonicalWwIssuer(baseUrl) ||
    admission.issuer !== stored.issuer ||
    admission.tokenFingerprint !== createHash("sha256").update(stored.token).digest("hex")
  ) {
    admissions?.delete(admissionId);
    return undefined;
  }
  return stored.token;
}

export function grantWwTeamAdmission(
  state: BridgeState,
  request: IncomingMessage,
  response: ServerResponse,
  input: { baseUrl: string; token: string },
): void {
  const admissions = admissionsByState.get(state) ?? new Map<string, TeamAdmission>();
  admissionsByState.set(state, admissions);
  const previousId = parseCookieHeader(request.headers.cookie).get(TEAM_ADMISSION_COOKIE);
  if (previousId) admissions.delete(previousId);
  const now = Date.now();
  for (const [id, admission] of admissions) {
    if (admission.expiresAt <= now) admissions.delete(id);
  }
  while (admissions.size >= MAX_TEAM_ADMISSIONS) {
    const oldest = admissions.keys().next().value;
    if (oldest) admissions.delete(oldest);
  }
  const id = randomBytes(32).toString("base64url");
  admissions.set(id, {
    issuer: canonicalWwIssuer(input.baseUrl),
    tokenFingerprint: createHash("sha256").update(input.token.trim()).digest("hex"),
    expiresAt: now + TEAM_ADMISSION_SECONDS * 1000,
  });
  appendSetCookie(response, serializeCookie(TEAM_ADMISSION_COOKIE, id, TEAM_ADMISSION_SECONDS));
}

export function clearWwTeamAdmission(state: BridgeState, request: IncomingMessage, response: ServerResponse): void {
  const id = parseCookieHeader(request.headers.cookie).get(TEAM_ADMISSION_COOKIE);
  if (id) admissionsByState.get(state)?.delete(id);
  appendSetCookie(response, serializeCookie(TEAM_ADMISSION_COOKIE, "", 0));
}

export function saveWwTeamToken(state: BridgeState, input: { baseUrl: string; token: string }): void {
  const token = input.token.trim();
  if (!token) throw new Error("ww_team_token_missing");
  const next: WwTeamTokenState = {
    version: WW_TEAM_TOKEN_VERSION,
    issuer: canonicalWwIssuer(input.baseUrl),
    token,
  };
  writePrivateJsonAtomically(wwTeamTokenPath(state), next);
}

export function clearWwTeamToken(state: BridgeState): void {
  writePrivateJsonAtomically(wwTeamTokenPath(state), { version: WW_TEAM_TOKEN_VERSION, issuer: "", token: "" });
  admissionsByState.delete(state);
}

/**
 * Reads the file, treating anything unreadable as "no token stored". A corrupt
 * or stale-version file must not stop the bridge from starting: the only cost
 * of ignoring it is that someone re-enters the token, whereas throwing here
 * would take down sign-in entirely.
 */
function readState(state: BridgeState): WwTeamTokenState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(wwTeamTokenPath(state), "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const source = parsed as Record<string, unknown>;
  if (source.version !== WW_TEAM_TOKEN_VERSION) return undefined;
  const issuer = typeof source.issuer === "string" ? source.issuer.trim() : "";
  const token = typeof source.token === "string" ? source.token.trim() : "";
  if (!issuer || !token) return undefined;
  return { version: WW_TEAM_TOKEN_VERSION, issuer, token };
}

function wwTeamTokenPath(state: BridgeState): string {
  return bridgeDataPath(state, WW_TEAM_TOKEN_FILE);
}
