import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { BridgeProviderProfile } from "../../server/bridge-types.js";

export interface WwRetryFixture {
  apiKey: string;
  auth: { baseUrl: string; accessToken: string; userId: string };
  provider(model: string): BridgeProviderProfile;
  counts(): { list: number; create: number };
  close(): Promise<void>;
}

export interface WwRetryClaudeEngineFixture {
  path: string;
  calls(): number;
}

export function createWwRetryClaudeEngineFixture(directory: string): WwRetryClaudeEngineFixture {
  const path = join(directory, "ww-retry-claude.mjs");
  const countPath = join(directory, "ww-retry-claude-count.txt");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('2.1.263'); process.exit(0); }
const countPath = ${JSON.stringify(countPath)};
const send = value => console.log(JSON.stringify(value));
const sessionId = randomUUID();
let permissionMode = process.argv[process.argv.indexOf('--permission-mode') + 1] || 'default';
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const request = message.request;
    if (request.subtype === 'set_permission_mode') permissionMode = request.mode;
    const response = request.subtype === 'initialize'
      ? { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] }
      : {};
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
    continue;
  }
  if (message.type !== 'user') continue;
  let count = 0;
  try { count = Number.parseInt(readFileSync(countPath, 'utf8'), 10) || 0; } catch {}
  writeFileSync(countPath, String(++count));
  send({ type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), permissionMode,
    claude_code_version: '2.1.263', model: 'claude-opus-4-8', tools: [], mcp_servers: [], slash_commands: [], skills: [] });
  const text = count === 1 ? 'API Error: 401 API_KEY_INVALID (110203)' : 'recovered WW answer';
  if (count > 1) send({ type: 'assistant', uuid: randomUUID(), session_id: sessionId,
    message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], usage: {} } });
  send({ type: 'result', subtype: count === 1 ? 'error_during_execution' : 'success',
    uuid: randomUUID(), session_id: sessionId, result: text, errors: count === 1 ? [text] : [], is_error: count === 1,
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [] });
}
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return {
    path,
    calls() {
      try {
        return Number.parseInt(readFileSync(countPath, "utf8"), 10) || 0;
      } catch {
        return 0;
      }
    },
  };
}

export async function createWwRetryFixture(): Promise<WwRetryFixture> {
  const apiKey = "ww_fixture_repaired_key";
  const accessToken = "ww-fixture-access";
  let listRequests = 0;
  let createRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/api-keys") {
      assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
      listRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              id: "ww-fixture-old-key",
              name: "OpenGrove WW Provider",
              key_prefix: "ww_fixture",
              status: "active",
              created_at: "2026-09-01T00:00:00Z",
            },
          ],
          request_id: "ww-fixture-list",
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/api-keys") {
      assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
      createRequests += 1;
      assert.ok(request.headers["idempotency-key"]);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            id: "ww-fixture-repaired-key",
            name: "OpenGrove WW Provider",
            api_key: apiKey,
            key_prefix: "ww_fixture",
            status: "active",
            created_at: "2026-09-01T00:00:01Z",
          },
          request_id: "ww-fixture-create",
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: 404, message: "not found" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    apiKey,
    auth: { baseUrl, accessToken, userId: "ww-fixture-user" },
    provider(model) {
      return {
        id: "ww",
        name: "WW",
        custom: true,
        deleted: false,
        enabled: true,
        origin: "user",
        protocol: "anthropic-compatible",
        description: "WW Anthropic-compatible provider.",
        anthropicBaseUrl: baseUrl,
        apiKey,
        credentialKind: "api-key",
        models: [{ id: model, label: model }],
      };
    },
    counts: () => ({ list: listRequests, create: createRequests }),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
