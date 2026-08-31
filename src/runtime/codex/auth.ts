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
    const idToken = readString(tokens, "id_token") ?? readString(tokens, "idToken");
    const accessToken = readString(tokens, "access_token") ?? readString(tokens, "accessToken");
    const refreshToken = readString(tokens, "refresh_token") ?? readString(tokens, "refreshToken");
    const accountId = readString(tokens, "account_id") ?? readString(tokens, "accountId");
    const cleanTokens: JsonObject = {
      ...(idToken ? { id_token: idToken, idToken } : {}),
      ...(accessToken ? { access_token: accessToken, accessToken } : {}),
      ...(refreshToken ? { refresh_token: refreshToken, refreshToken } : {}),
      ...(accountId ? { account_id: accountId, accountId } : {}),
    };
    return {
      ...cleanTokens,
      tokens: cleanTokens,
      chatgptAuthTokens: cleanTokens,
      ...(typeof object?.last_refresh === "string" ? { last_refresh: object.last_refresh } : {}),
    };
  } catch {
    return {};
  }
}

function resolveCodexAuthPath(env?: NodeJS.ProcessEnv): string {
  const codexHome = env?.CODEX_HOME ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
  return resolve(codexHome, "auth.json");
}
