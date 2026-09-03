import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AgentEvent } from "../core.js";
import { createBridgeState } from "../server/bridge-state.js";
import { LOGIN_PROVIDER_BINDING_ID } from "../server/bridge-types.js";
import {
  blockWwApiKeyRecoveryForExecution,
  isSafeWwApiKeyRetry,
  isWwApiKeyInvalidError,
  recoverWwApiKeyForExecution,
} from "../server/ww-provider-recovery.js";
import {
  claimWwProviderAccount,
  clearWwProviderRecoveryBlock,
  isWwProviderRecoveryBlocked,
  readWwProviderLocalState,
} from "../server/ww-provider-local-state.js";

const dir = mkdtempSync(join(tmpdir(), "opengrove-ww-recovery-"));
let createRequests = 0;
let listRequests = 0;
let listMode: "active" | "access-error" = "active";
let requestOrder: string[] = [];
const fakeWw = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/api-keys") {
    listRequests += 1;
    requestOrder.push("GET");
    assert.ok(
      request.headers.authorization === "Bearer access-current" ||
        request.headers.authorization === "Bearer access-refreshed",
    );
    if (listMode === "access-error" && request.headers.authorization === "Bearer access-current") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: 110201, message: "Invalid or expired access token" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          {
            id: "key-invalid",
            name: "OpenGrove WW Provider",
            key_prefix: "ww_sk_invalid",
            status: "active",
            created_at: "2026-07-09T00:00:00Z",
          },
        ],
        request_id: "req-list",
      }),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/api-keys") {
    createRequests += 1;
    requestOrder.push("POST");
    assert.ok(
      request.headers.authorization === "Bearer access-current" ||
        request.headers.authorization === "Bearer access-refreshed",
    );
    assert.ok(request.headers["idempotency-key"]);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: {
          id: "key-repaired",
          name: "OpenGrove WW Provider",
          api_key: "ww_sk_repaired_secret_material",
          key_prefix: "ww_sk_repaired",
          status: "active",
          created_at: "2026-07-10T00:00:00Z",
        },
        request_id: "req-repair",
      }),
    );
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: 404, message: "not found" } }));
});

try {
  fakeWw.listen(0, "127.0.0.1");
  await once(fakeWw, "listening");
  const baseUrl = `http://127.0.0.1:${(fakeWw.address() as AddressInfo).port}`;
  const state = createBridgeState({ statePath: join(dir, "state.json") });
  state.kernel = "claude-code";
  state.model = "claude-opus-4-8";
  state.settings = {
    ...state.settings,
    kernel: "claude-code",
    modelProviderBindings: [
      {
        modelId: "claude-opus-4-8",
        providerId: "ww",
      },
    ],
    customProviders: [
      {
        id: "ww",
        name: "WW",
        custom: true,
        enabled: true,
        origin: "user",
        protocol: "anthropic-compatible",
        anthropicBaseUrl: baseUrl,
        apiKey: "ww_sk_invalid_secret_material",
        credentialKind: "api-key",
        models: [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }],
      },
    ],
  };
  state.kernelProviderId = "ww";

  assert.equal(isWwApiKeyInvalidError("API Error: 401 { code: 110203, name: API_KEY_INVALID }"), true);
  assert.equal(isWwApiKeyInvalidError("Invalid, expired, or revoked API key"), true);
  assert.equal(isWwApiKeyInvalidError("Invalid or expired access token"), false);

  const safeEvents: AgentEvent[] = [{ type: "error", runId: "run-1", message: "API_KEY_INVALID" }];
  assert.equal(isSafeWwApiKeyRetry(safeEvents), true);
  assert.equal(
    isSafeWwApiKeyRetry([
      {
        type: "skill.discovered",
        runId: "run-1",
        skills: [
          {
            id: "story-seed",
            name: "story-seed",
            title: "Story Seed",
            description: "Installed App skill discovered before the model request.",
            format: "markdown-v2",
            entry: "SKILL.md",
            skillRoot: "/fixtures/story-seed",
            activities: ["chat"],
            toolIds: [],
            memoryHooks: [],
            allowedTools: [],
            userInvocable: true,
            disableModelInvocation: false,
            context: "inline",
            source: "project",
            trust: "trusted",
          },
        ],
      },
      ...safeEvents,
    ]),
    true,
    "skill discovery is read-only context assembly and must not make an otherwise safe WW retry unsafe",
  );
  assert.equal(
    isSafeWwApiKeyRetry([
      {
        type: "model.requested",
        runId: "run-1",
        request: {
          systemPrompt: "",
          userInput: "hello",
          modelId: "claude-opus-4-8",
          tools: [],
          skills: [],
          packs: [],
          capabilities: [],
        },
      },
      {
        type: "runtime.diagnostic",
        runId: "run-1",
        at: new Date().toISOString(),
        name: "claude.host_tools.configured",
        data: { runtimeMode: "cli", available: false, transport: "none" },
      },
      ...safeEvents,
      { type: "model.response", runId: "run-1", response: { text: "API_KEY_INVALID" } },
      {
        type: "assistant.final",
        runId: "run-1",
        text: "API_KEY_INVALID",
        at: new Date().toISOString(),
        source: "adapter",
      },
      {
        type: "turn.finished",
        runId: "run-1",
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_FAILED", reasonCode: "claude_code_failed" },
      },
    ]),
    true,
    "a withheld credential failure may include the adapter's read-only response and final events",
  );
  assert.equal(
    isSafeWwApiKeyRetry([
      { type: "model.response", runId: "run-1", response: { text: "partial answer" } },
      ...safeEvents,
    ]),
    false,
    "model output before the credential failure must still block an automatic retry",
  );
  assert.equal(
    isSafeWwApiKeyRetry([...safeEvents, { type: "assistant.delta", runId: "run-1", text: "partial" }]),
    false,
  );
  assert.equal(
    isSafeWwApiKeyRetry([
      ...safeEvents,
      {
        type: "runtime.diagnostic",
        runId: "run-1",
        at: new Date().toISOString(),
        name: "claude.sdk.hook_response",
        data: {},
      },
    ]),
    false,
  );

  const unsafe = await recoverWwApiKeyForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: [...safeEvents, { type: "assistant.delta", runId: "run-1", text: "partial" }],
    error: "API_KEY_INVALID",
  });
  assert.deepEqual(unsafe, { repaired: false, reason: "unsafe_retry" });
  assert.equal(listRequests, 0);
  assert.equal(createRequests, 0);

  listMode = "access-error";
  const expiredAccess = await recoverWwApiKeyForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: safeEvents,
    error: "API_KEY_INVALID",
  });
  assert.deepEqual(expiredAccess, { repaired: false, reason: "repair_failed", error: "access_token_invalid" });
  assert.equal(listRequests, 1);
  assert.equal(createRequests, 0, "a failed key-list check must never create a replacement");
  listMode = "active";
  requestOrder = [];

  state.kernelProviderId = "ww";
  state.model = "gpt-5.6-root-model-that-does-not-match-the-ww-binding";
  const repaired = await recoverWwApiKeyForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: safeEvents,
    error: "API Error: 401 API_KEY_INVALID (110203)",
  });
  assert.deepEqual(repaired, { repaired: true, keyState: "active-but-rejected" });
  assert.deepEqual(requestOrder, ["GET", "POST"], "recovery must reconcile before creating");
  assert.equal(createRequests, 1);
  assert.equal(state.settings.modelProviderBindings[0]?.providerId, "ww");
  const wwProvider = state.settings.customProviders.find((provider) => provider.id === "ww");
  assert.equal(wwProvider?.apiKey, "ww_sk_repaired_secret_material");
  assert.equal(wwProvider?.provisioningBlocked, undefined);
  assert.equal(
    state.model,
    "gpt-5.6-root-model-that-does-not-match-the-ww-binding",
    "Key repair must not change the user's selected model",
  );

  state.kernelProviderId = "ww";
  const blocked = blockWwApiKeyRecoveryForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: safeEvents,
    error: "API_KEY_INVALID",
  });
  assert.equal(blocked, true);
  assert.equal(isWwProviderRecoveryBlocked(state, { issuer: baseUrl, userId: "user-current" }), true);
  const blockedProvider = state.settings.customProviders.find((provider) => provider.id === "ww");
  assert.equal(blockedProvider?.apiKey, undefined);
  assert.equal(blockedProvider?.provisioningBlocked, true);

  state.kernelProviderId = "ww";
  const blockedRecovery = await recoverWwApiKeyForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: safeEvents,
    error: "API_KEY_INVALID",
  });
  assert.deepEqual(blockedRecovery, { repaired: false, reason: "repair_failed", error: "recovery_blocked" });
  assert.equal(createRequests, 1, "later messages must not mint another key after the circuit opens");

  clearWwProviderRecoveryBlock(state, { issuer: baseUrl, userId: "user-current" });
  state.kernelProviderId = "ww";
  requestOrder = [];
  const afterRelogin = await recoverWwApiKeyForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: safeEvents,
    error: "API_KEY_INVALID",
  });
  assert.deepEqual(afterRelogin, { repaired: true, keyState: "no-local-key" });
  assert.deepEqual(requestOrder, ["GET", "POST"]);
  assert.equal(createRequests, 2);

  state.settings.modelProviderBindings = [
    {
      modelId: "claude-opus-4-8",
      providerId: LOGIN_PROVIDER_BINDING_ID,
    },
  ];
  state.kernelProviderId = LOGIN_PROVIDER_BINDING_ID;
  const native = await recoverWwApiKeyForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: safeEvents,
    error: "API_KEY_INVALID",
  });
  assert.deepEqual(native, { repaired: false, reason: "not_ww" });
  assert.equal(createRequests, 2);

  state.settings.modelProviderBindings = [
    {
      modelId: "claude-opus-4-8",
      providerId: "ww",
    },
  ];
  state.kernelProviderId = "ww";
  claimWwProviderAccount(state, { issuer: baseUrl, userId: "user-other" });
  const settingsBeforeStaleRecovery = JSON.stringify(state.settings);
  const requestsBeforeStaleRecovery = { createRequests, listRequests };
  const staleRecovery = await recoverWwApiKeyForExecution({
    state,
    auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
    attemptEvents: safeEvents,
    error: "API_KEY_INVALID",
  });
  assert.deepEqual(staleRecovery, { repaired: false, reason: "account_changed" });
  assert.deepEqual(
    { createRequests, listRequests },
    requestsBeforeStaleRecovery,
    "a run captured under the old account must not inspect or replace the new account's key",
  );
  assert.equal(JSON.stringify(state.settings), settingsBeforeStaleRecovery);
  assert.equal(readWwProviderLocalState(state).ownerUserId, "user-other");
  assert.equal(
    blockWwApiKeyRecoveryForExecution({
      state,
      auth: { baseUrl, accessToken: "access-current", userId: "user-current" },
      attemptEvents: safeEvents,
      error: "API_KEY_INVALID",
    }),
    false,
    "a stale run must not circuit-break the new account",
  );
  assert.equal(readWwProviderLocalState(state).ownerUserId, "user-other");

  state.store.close?.();
  console.log("ww-provider-recovery-harness ok");
} finally {
  await new Promise<void>((resolve, reject) => {
    fakeWw.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
