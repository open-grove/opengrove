import { CodexAppServerClient as Client } from "@open-grove/agent-host/codex";
import { readCodexAuthRefreshResponse } from "./auth.js";
export {
  CodexRequestFailure,
  buildCodexAppServerEnv,
  CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS,
} from "@open-grove/agent-host/codex";
export type CodexAppServerClient = Client;
export const CodexAppServerClient = {
  start(options: Parameters<typeof Client.start>[0]): Promise<Client> {
    return Client.start({
      ...options,
      fallbackRequest: (request) =>
        request.method === "account/chatgptAuthTokens/refresh" ? readCodexAuthRefreshResponse(options.env) : undefined,
    });
  },
};
