import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { startLocalBridgeServer } from "../../server/local-bridge.js";
import { startRemoteAgentService } from "./remote-agent-service.js";
import type { RoomChannelMessage } from "../../rooms/channel-store.js";

export async function startRemoteRoomHost() {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-remote-room-"));
  const fixture = await startRemoteAgentService();
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    OPENGROVE_AGENT_ROUTER_URL: fixture.serviceUrl,
    OPENGROVE_AGENT_ROUTER_PROVIDER: "opengrove",
    OPENGROVE_AGENT_ROUTER_ALLOW_LOCAL_HTTP: "1",
    OPENGROVE_WW_BASE_URL: fixture.baseUrl,
    OPENGROVE_WEB_AUTH_MODE: "bridge-token",
    OPENGROVE_DATA_DIR: directory,
    OPENGROVE_USER_DATA_DIR: join(directory, "user"),
    OPENGROVE_DIAGNOSTICS_DIR: join(directory, "diagnostics"),
    OPENGROVE_RELEASE_CONTROL_URL: fixture.baseUrl,
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  let cookies = "";
  let server = start();
  let baseUrl = "";
  const headers = { "content-type": "application/json", "x-opengrove-token": "remote-room-test" };
  async function ready() {
    if (!server.listening) await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }
  function start() {
    return startLocalBridgeServer({
      host: "127.0.0.1",
      port: 0,
      statePath: join(directory, "state.sqlite"),
      bridgeToken: "remote-room-test",
    });
  }
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { ...headers, cookie: cookies },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) {
      const jar = new Map(
        cookies
          .split("; ")
          .filter(Boolean)
          .map((entry) => entry.split("=") as [string, string]),
      );
      for (const entry of setCookies) {
        const [key, value] = entry.split(";")[0]!.split("=");
        jar.set(key!, value!);
      }
      cookies = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
    }
    const result = await response.json();
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  const sendCalls = () => fixture.calls.filter((call) => call.method === "SendMessage");
  const login = (user: string) => request("/auth/login", { email: `${user}@example.test`, code: "123456" });
  async function waitMessage(id: string, predicate: (message: RoomChannelMessage) => boolean) {
    let observed: RoomChannelMessage | undefined;
    for (let attempt = 0; attempt < 160; attempt++) {
      // Events are read-only; polling must not itself retry failed requests.
      const { events } = await request<{ events: { payload: { message?: RoomChannelMessage } }[] }>(
        "/rooms/events?limit=1000",
      );
      const message = events
        .map((event) => event.payload.message)
        .reverse()
        .find((message) => message?.id === id);
      observed = message;
      if (message && predicate(message)) return message;
      await delay(50);
    }
    throw new Error(
      `message timed out: ${id}; last=${JSON.stringify(observed)}; calls=${JSON.stringify(fixture.calls.slice(-5))}`,
    );
  }
  await ready();
  return {
    directory,
    fixture,
    request,
    login,
    waitMessage,
    sendCalls,
    get baseUrl() {
      return baseUrl;
    },
    get cookies() {
      return cookies;
    },
    headers,
    async restart() {
      await close();
      server = start();
      await ready();
    },
    async dispose() {
      await close();
      await fixture.close();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
