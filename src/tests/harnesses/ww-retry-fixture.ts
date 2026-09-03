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

export interface WwRetryClaudeCliFixture {
  path: string;
  calls(): number;
}

export function createWwRetryClaudeCliFixture(directory: string): WwRetryClaudeCliFixture {
  const path = join(directory, "ww-retry-claude.mjs");
  const countPath = join(directory, "ww-retry-claude-count.txt");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "if (process.argv.includes('--version')) { console.log('2.1.81'); process.exit(0); }",
      `const countPath = ${JSON.stringify(countPath)};`,
      "let count = 0;",
      "try { count = Number.parseInt(readFileSync(countPath, 'utf8'), 10) || 0; } catch {}",
      "count += 1;",
      "writeFileSync(countPath, String(count));",
      "if (count === 1) {",
      "  console.log(JSON.stringify({ type: 'result', result: 'API Error: 401 API_KEY_INVALID (110203)', is_error: true }));",
      "} else {",
      "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'recovered WW answer' }] } }));",
      "  console.log(JSON.stringify({ type: 'result', result: 'recovered WW answer', is_error: false }));",
      "}",
    ].join("\n"),
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
