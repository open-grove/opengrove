import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { JsonObject } from "../../core.js";
import { isJsonObject, readString } from "./json.js";

export function readCodexAuthRefreshResponse(env?: NodeJS.ProcessEnv): JsonObject {
  const authPath = resolveCodexAuthPath(env);
  if (!existsSync(authPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    const object = isJsonObject(parsed) ? parsed : undefined;
    const tokens = isJsonObject(object?.tokens) ? object.tokens : object;
    if (!tokens) {
      return {};
    }
    const accessToken = readString(tokens, "access_token") ?? readString(tokens, "accessToken");
    const accountId = readString(tokens, "account_id") ?? readString(tokens, "accountId");
    if (!accessToken || !accountId) return {};
    // Codex 0.162 ChatgptAuthTokensRefreshResponse requires these two fields.
    // The native server does not request the refresh token or ID token.
    return { accessToken, chatgptAccountId: accountId };
  } catch {
    return {};
  }
}

function resolveCodexAuthPath(env?: NodeJS.ProcessEnv): string {
  const codexHome = env?.CODEX_HOME ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
  return resolve(codexHome, "auth.json");
}
