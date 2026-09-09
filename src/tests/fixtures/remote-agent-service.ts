import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Task } from "@agent-router/sdk";

/** HTTP contract fixture derived only from the SDK's packaged public client. */
export async function startRemoteAgentService() {
  const calls: Array<{
    method: string;
    params: {
      message?: { messageId: string; contextId?: string; taskId?: string; parts: { text: string }[] };
      id?: string;
    };
    sender: string;
  }> = [];
  const exchanges: Array<{ provider: string; accessToken: string }> = [];
  const tasks: Record<string, Task> = {};
  const memories: Record<string, string> = {};
  const credentials = new Map<string, string>();
  const revoked: string[] = [];
  const config = {
    rejectExchange: false,
    rejectExternalOnce: false,
    changedSender: false,
    rejectCredentialOnce: false,
    delayCancellation: false,
    directoryUnavailable: false,
  };
  const directoryRequests: string[] = [];
  let sequence = 0;
  let baseUrl = "";
  let host = "";
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", baseUrl).pathname;
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const productToken = request.headers.authorization?.replace("Bearer ", "") ?? "";
    const user = productToken.split("-")[1] ?? "";
    if (path === "/v1/users/me")
      return send(200, {
        data: {
          user_id: user,
          email: `${user}@example.test`,
          display_name: user,
          roles: user === "regular" ? ["user"] : ["admin"],
        },
      });
    if (path === "/v1/auth/email-login" || path === "/v1/auth/token/refresh") {
      const id = body.email?.split("@")[0] ?? body.refresh_token?.split("-")[1];
      return send(200, {
        data: {
          access_token: `product-${id}-${++sequence}`,
          refresh_token: `refresh-${id}-${sequence}`,
          access_token_expires_in: 3600,
          refresh_token_expires_in: 86400,
          token_type: "Bearer",
        },
      });
    }
    if (path === "/v1/auth/logout") return send(200, { data: {} });
    if (path === "/v1/api-keys")
      return send(200, {
        data:
          request.method === "GET"
            ? []
            : {
                id: `key-${sequence}`,
                name: "OpenGrove WW Provider",
                api_key: "sk-synthetic-sdk-test",
                key_prefix: "sk-test",
                status: "active",
              },
      });
    if (path === "/v1/app-store/install-policy")
      return send(200, { policyKey: "standard", assignmentSource: "default", apps: [] });
    if (path === "/v1/app-store/packages") return send(200, { packages: [] });
    if (path === "/_agent-router/v1/auth/exchange") {
      assert.equal(request.headers.authorization, undefined);
      exchanges.push({ provider: body.provider!, accessToken: body.accessToken! });
      if (config.rejectExternalOnce) {
        config.rejectExternalOnce = false;
        return send(401, { error: "external_session_invalid" });
      }
      if (config.rejectExchange) return send(403, { error: "external_role_required" });
      const owner = body.accessToken?.split("-")[1];
      const sender = config.changedSender ? "changed" : `sender-${owner}`;
      const accessToken = `ars_${++sequence}`;
      credentials.set(accessToken, sender);
      return send(200, {
        serviceUrl: `${baseUrl}/_agent-router/v1`,
        accessToken,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        owner: `@${owner}:${host}`,
        agent: {
          id: sender,
          owner: `@${owner}:${host}`,
          name: "client",
          address: `${owner}/client@${host}`,
          matrixId: `@${sender}:${host}`,
        },
      });
    }
    if (path === "/_agent-router/v1/auth/session" && request.method === "DELETE") {
      revoked.push(productToken);
      credentials.delete(productToken);
      response.writeHead(204);
      response.end();
      return;
    }
    if (path === "/_agent-router/v1/directory") {
      directoryRequests.push(request.url!);
      if (config.directoryUnavailable) return send(503, { error: "directory_unavailable" });
      assert.equal(request.headers.authorization, undefined, "directory requests are unauthenticated");
      const address = new URL(request.url!, baseUrl).searchParams.get("address");
      return send(200, {
        id: "remote-coder",
        owner: `@remote:${host}`,
        name: "coder",
        address,
        matrixId: `@remote-coder:${host}`,
      });
    }
    if (path.endsWith("/a2a/jsonrpc")) {
      if (config.rejectCredentialOnce) {
        config.rejectCredentialOnce = false;
        return send(401, { error: "account_session_invalid" });
      }
      const sender = credentials.get(productToken);
      if (!sender) return send(401, { error: "account_session_invalid" });
      assert.ok(path.includes(`/agents/${sender}/gateway/`));
      const rpc = JSON.parse(raw) as { id: string; method: string; params: (typeof calls)[number]["params"] };
      calls.push({ method: rpc.method, params: rpc.params, sender });
      let task: Task | undefined;
      if (rpc.method === "SendMessage") {
        const message = rpc.params.message!;
        const content = message.parts[0]!.text;
        const text = /<current-message>\n([\s\S]*)\n<\/current-message>/.exec(content)?.[1] ?? content;
        const contextId = message.contextId ?? `context-${message.messageId}`;
        const first = !tasks[message.messageId];
        if (first) {
          if (text.startsWith("remember:")) memories[contextId] = text.slice(9);
          tasks[message.messageId] = {
            id: `task-${message.messageId}`,
            contextId,
            status: {
              state:
                text === "HOLD"
                  ? "TASK_STATE_WORKING"
                  : text === "INPUT"
                    ? "TASK_STATE_INPUT_REQUIRED"
                    : text === "FAIL"
                      ? "TASK_STATE_FAILED"
                      : text === "AUTH"
                        ? "TASK_STATE_AUTH_REQUIRED"
                        : "TASK_STATE_COMPLETED",
            },
            artifacts:
              text === "HOLD"
                ? []
                : [{ parts: [{ text: text === "recall" ? (memories[contextId] ?? "unknown") : `reply:${text}` }] }],
          };
          if (text === "PROGRESS")
            tasks[message.messageId] = {
              id: `task-${message.messageId}`,
              contextId,
              status: {
                state: "TASK_STATE_WORKING",
                message: { role: "ROLE_AGENT", parts: [{ text: "Connecting to the remote worker…" }] },
              },
            };
          if (text === "INPUT" || text === "AUTH")
            tasks[message.messageId]!.status.message = {
              role: "ROLE_AGENT",
              parts: [{ text: "Please confirm the target." }],
            };
        }
        task = tasks[message.messageId];
        if (text === "RECOVER" && first) {
          response.destroy();
          return;
        }
        if (text === "MALFORMED") return send(200, { jsonrpc: "2.0", id: rpc.id, result: { task: { id: 42 } } });
      } else {
        task = Object.values(tasks).find((candidate) => candidate.id === rpc.params.id);
        if (task && rpc.method === "CancelTask") {
          if (!config.delayCancellation) task.status.state = "TASK_STATE_CANCELED";
        }
      }
      if (rpc.method === "SubscribeToTask" && task) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        let previous = "";
        const tick = () => {
          const latest = Object.values(tasks).find((candidate) => candidate.id === rpc.params.id)!;
          const next = JSON.stringify(latest);
          if (next !== previous) {
            previous = next;
            response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { task: latest } })}\n\n`);
          }
          if (!["TASK_STATE_WORKING", "TASK_STATE_SUBMITTED"].includes(latest.status.state)) response.end();
        };
        const timer = setInterval(tick, 25);
        response.on("close", () => clearInterval(timer));
        tick();
        return;
      }
      return send(200, { jsonrpc: "2.0", id: rpc.id, result: rpc.method === "SendMessage" ? { task } : task });
    }
    send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  host = `127.0.0.1:${address.port}`;
  baseUrl = `http://${host}`;
  return {
    baseUrl,
    serviceUrl: `${baseUrl}/_agent-router/v1`,
    address: `owner/coder@${host}`,
    calls,
    exchanges,
    tasks,
    revoked,
    config,
    directoryRequests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
