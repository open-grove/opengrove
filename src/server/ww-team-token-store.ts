import { readFileSync } from "node:fs";
import { writePrivateJsonAtomically } from "../storage/private-file.js";
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

interface WwTeamTokenState {
  version: typeof WW_TEAM_TOKEN_VERSION;
  issuer: string;
  token: string;
}

/**
 * Returns the stored team token, but only for the ww deployment it was accepted
 * by. Scoping to the issuer means repointing the bridge at another backend
 * never forwards this deployment's shared credential to it.
 */
export function readWwTeamToken(state: BridgeState, baseUrl: string): string | undefined {
  const stored = readState(state);
  if (!stored) return undefined;
  return stored.issuer === canonicalWwIssuer(baseUrl) ? stored.token : undefined;
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
