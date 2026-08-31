import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startOpenGroveServer } from "../server/create-server.js";
import { LOGIN_PROVIDER_BINDING_ID } from "../server/bridge-types.js";
import { CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION } from "../server/migrations/implicit-provider-routes-v1.js";
import { WW_DEFAULT_MODEL_ID, wwDefaultProviderModels } from "../server/provider-profiles.js";
import { withEnv } from "./env.js";

const dir = mkdtempSync(join(tmpdir(), "opengrove-ww-provider-"));
const previousWwBaseUrl = process.env.OPENGROVE_WW_BASE_URL;
const previousWwApiKey = process.env.OPENGROVE_WW_API_KEY;
const previousWebAuthMode = process.env.OPENGROVE_WEB_AUTH_MODE;
const previousClaudeCliPath = process.env.OPENGROVE_CLAUDE_CLI_PATH;
const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

assert.equal(
  wwDefaultProviderModels()[0]?.id,
  WW_DEFAULT_MODEL_ID,
  "the WW catalog order must agree with the default consumed by existing Kernel and Provider fallbacks",
);

let apiKeyRequests = 0;
let apiKeyScenario: "retry-twice" | "success" | "fail" = "retry-twice";
let apiKeyScenarioAttempts = 0;
let apiKeyResponseDelayMs = 0;
let apiKeyListRequests = 0;
let apiKeyListScenario: "success" | "empty-null" | "fail" = "empty-null";
const apiKeyAuthHeaders: string[] = [];
const apiKeyIdempotencyHeaders: string[] = [];
const issuedApiKeys = [
  {
    id: "key-existing",
    name: "OpenGrove WW Provider",
    key_prefix: "ww_sk_existing",
    status: "active",
    created_at: "2026-07-05T00:00:00Z",
  },
];

const fakeWw = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/v1/auth/email-login") {
    void readJsonBody(request)
      .then((body) => {
        const otherAccount = body.email === "other-ww-user@example.test";
        sendJson(response, 200, {
          data: {
            access_token: otherAccount ? "access-other" : "access-login",
            access_token_expires_in: 60,
            refresh_token: otherAccount ? "refresh-other" : "refresh-login",
            refresh_token_expires_in: 3600,
            token_type: "Bearer",
            is_new_user: body.email !== "existing-ww-user@example.test",
          },
          request_id: "req-login",
        });
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/users/me") {
    const otherAccount = request.headers.authorization === "Bearer access-other";
    sendJson(response, 200, {
      data: {
        user_id: otherAccount ? "user_other" : "user_ww",
        email: otherAccount ? "other-ww-user@example.test" : "ww-user@example.test",
        role: "member",
      },
      request_id: "req-me",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/api-keys") {
    apiKeyListRequests += 1;
    if (apiKeyListScenario === "fail") {
      sendJson(response, 503, {
        error: { code: 100004, message: "temporarily unavailable" },
        request_id: `req-api-key-list-${apiKeyListRequests}`,
      });
      return;
    }
    sendJson(response, 200, {
      data: apiKeyListScenario === "empty-null" ? null : issuedApiKeys,
      request_id: "req-api-key-list",
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/api-keys") {
    apiKeyRequests += 1;
    apiKeyScenarioAttempts += 1;
    apiKeyAuthHeaders.push(String(request.headers.authorization || ""));
    apiKeyIdempotencyHeaders.push(String(request.headers["idempotency-key"] || ""));
    void readJsonBody(request)
      .then((body) => {
        assert.equal(body.name, "OpenGrove WW Provider");
        if (apiKeyScenario === "fail" || (apiKeyScenario === "retry-twice" && apiKeyScenarioAttempts < 3)) {
          sendJson(response, 503, {
            error: {
              code: 100004,
              message: "temporarily unavailable",
            },
            request_id: `req-api-key-retry-${apiKeyRequests}`,
          });
          return;
        }
        const createdIndex = issuedApiKeys.length;
        const createdKey = {
          id: `key-${createdIndex}`,
          name: body.name,
          api_key: `ww_sk_auto_${createdIndex}_secret_material`,
          key_prefix: `ww_sk_auto_${createdIndex}`,
          status: "active",
          created_at: "2026-07-06T00:00:00Z",
        };
        const complete = () => {
          issuedApiKeys.push(createdKey);
          sendJson(response, 201, {
            data: createdKey,
            request_id: "req-api-key",
          });
        };
        if (apiKeyResponseDelayMs > 0) {
          setTimeout(complete, apiKeyResponseDelayMs);
        } else {
          complete();
        }
      })
      .catch((error) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  sendJson(response, 404, { error: { code: 404, message: "not found" } });
});

try {
  fakeWw.listen(0, "127.0.0.1");
  await once(fakeWw, "listening");
  const fakeAddress = fakeWw.address() as AddressInfo;
  const fakeClaude = join(dir, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.sh");
  writeFileSync(
    fakeClaude,
    process.platform === "win32"
      ? [
          "@echo off",
          'if "%~1"=="--version" ( echo claude-fake 0.0.0 & exit /b 0 )',
          'echo {"type":"result","result":"claude fake ok","is_error":false}',
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          '  echo "claude-fake 0.0.0"',
          "  exit 0",
          "fi",
          'echo \'{"type":"result","result":"claude fake ok","is_error":false}\'',
        ].join("\n"),
    "utf8",
  );
  chmodSync(fakeClaude, 0o755);

  process.env.OPENGROVE_WW_BASE_URL = `http://127.0.0.1:${fakeAddress.port}`;
  process.env.OPENGROVE_CLAUDE_CLI_PATH = fakeClaude;
  process.env.ANTHROPIC_API_KEY = "local-claude-key-that-must-not-be-used-by-ww";
  delete process.env.OPENGROVE_WW_API_KEY;
  delete process.env.OPENGROVE_WEB_AUTH_MODE;

  await withOpenGroveServer(join(dir, "local-state.json"), "local", async (baseUrl) => {
    const firstLoginResponse = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    const firstLogin = firstLoginResponse.body;
    const sessionCookie = firstLoginResponse.cookie;
    assert.equal(firstLogin.user.email, "ww-user@example.test");
    assert.equal(firstLogin.providerProvisioning.status, "configured");
    assert.equal(firstLogin.providerProvisioning.providerId, "ww");
    assert.equal(firstLogin.providerProvisioning.createdApiKey, true);
    assert.deepEqual(firstLogin.providerProvisioning.defaultedKernels, ["claude-code"]);
    assert.equal(apiKeyListRequests, 1, "WW data:null must be treated as an empty key list");
    assert.equal(apiKeyRequests, 3);
    assert.deepEqual(apiKeyAuthHeaders, ["Bearer access-login", "Bearer access-login", "Bearer access-login"]);
    assert.ok(apiKeyIdempotencyHeaders[0], "WW API Key creation should carry an idempotency key");
    assert.equal(new Set(apiKeyIdempotencyHeaders).size, 1, "all retries should reuse one idempotency key");
    assert.match(
      apiKeyIdempotencyHeaders[0] ?? "",
      /^og-[0-9a-f-]{36}-[0-9a-f-]{36}$/,
      "the stable installation id should namespace each persisted WW provisioning operation",
    );

    const settings = readSettings(join(dir, "bridge-settings.json"));
    const wwProvider = (settings.customProviders as any[]).find((provider) => provider.id === "ww");
    assert.equal(settings.kernel, "claude-code");
    assert.equal(wwProvider.apiKey, "ww_sk_auto_1_secret_material");
    assert.equal(wwProvider.apiKeyEnv, undefined);
    assert.equal(wwProvider.anthropicBaseUrl, process.env.OPENGROVE_WW_BASE_URL);
    assert.deepEqual(wwProvider.models, wwDefaultProviderModels());
    assert.ok((settings.modelProviderBindings as any[]).every((binding) => binding.providerId === "ww"));
    assert.equal(
      (settings.modelProviderBindings as any[]).length,
      3,
      "WW persists one global model-default row per advertised WW model",
    );
    assert.equal(
      (settings.modelProviderBindings as any[]).some((binding) => binding.modelId === "native"),
      false,
      "WW must not replace any Kernel's native/default model route",
    );
    assert.equal(
      new Set((settings.modelProviderBindings as any[]).map((binding) => binding.modelId)).size,
      (settings.modelProviderBindings as any[]).length,
      "re-provisioning must never append duplicate WW model defaults",
    );
    apiKeyListScenario = "success";
    const wwLocalStateText = readFileSync(join(dir, "ww-provider.json"), "utf8");
    assert.equal(
      wwLocalStateText.includes("ww_sk_auto_1_secret_material"),
      false,
      "local owner metadata must not duplicate the raw WW key",
    );
    assert.equal(
      JSON.parse(wwLocalStateText).productDefaults?.status,
      "completed",
      "product defaults must be recorded once so later Session checks cannot reapply them",
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, "bridge-settings.json")).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "ww-provider.json")).mode & 0o777, 0o600);
    }

    const runtimeSettings = await getJson(`${baseUrl}/api/settings`, sessionCookie);
    assert.equal(runtimeSettings.settings.kernel, "claude-code");
    assert.equal(runtimeSettings.settings.activeKernel, "claude-code");
    const claudeKernel = findKernelOption(runtimeSettings.settings, "claude-code");
    assert.equal(claudeKernel.available, true);
    assert.equal(claudeKernel.reason, "");
    assert.equal(claudeKernel.providerId, "ww");

    const rooms = await getJson(`${baseUrl}/api/rooms`, sessionCookie);
    const expectedSystemEmployeeModels = new Map([
      ["grove-guide", "deepseek-v4-flash"],
      ["app-builder", "claude-opus-4-8"],
      ["pm", "deepseek-v4-flash"],
    ]);
    for (const [memberId, model] of expectedSystemEmployeeModels) {
      const member = (rooms.members as any[]).find((candidate) => candidate.id === memberId);
      assert.ok(member, `new users should receive the built-in ${memberId} employee`);
      assert.equal(member.kernel, "claude-code");
      assert.equal(member.model, model);
      assert.equal(member.providerId, undefined, "built-in employees should inherit the model's WW default");
    }

    const explicitClaudeSettings = await patchJson(
      `${baseUrl}/api/settings`,
      {
        kernel: "claude-code",
      },
      sessionCookie,
    );
    assert.equal(explicitClaudeSettings.ok, true);
    assert.equal(explicitClaudeSettings.settings.kernel, "claude-code");
    assert.equal(explicitClaudeSettings.settings.activeKernel, "claude-code");

    const retiredAutoSettings = await patchJson(
      `${baseUrl}/api/settings`,
      {
        kernel: "auto",
      },
      sessionCookie,
    );
    assert.equal(retiredAutoSettings.ok, true);
    assert.equal(retiredAutoSettings.settings.kernel, "claude-code");

    const nativeSettings = await patchJson(
      `${baseUrl}/api/settings`,
      {
        modelProviderBindings: withProviderRoute(
          retiredAutoSettings.settings.modelProviderBindings,
          "claude-opus-4-8",
          LOGIN_PROVIDER_BINDING_ID,
        ),
      },
      sessionCookie,
    );
    assert.equal(nativeSettings.ok, true);
    assert.equal(providerFor(nativeSettings.settings, "claude-opus-4-8"), LOGIN_PROVIDER_BINDING_ID);

    const listsBeforeOutage = apiKeyListRequests;
    apiKeyListScenario = "fail";
    const failedValidation = await getJson(`${baseUrl}/api/auth/session`, sessionCookie);
    assert.equal(failedValidation.authenticated, true);
    assert.equal(failedValidation.providerProvisioning.status, "failed");
    assert.equal(failedValidation.providerProvisioning.diagnosticFacts.attemptCount, 3);
    assert.deepEqual(
      failedValidation.providerProvisioning.diagnosticFacts.httpResponses.map((response: Record<string, unknown>) => ({
        method: response.method,
        endpoint: response.endpoint,
        httpStatus: response.httpStatus,
        envelopeKind: response.envelopeKind,
        envelopeFields: response.envelopeFields,
        dataKind: response.dataKind,
        validationCode: response.validationCode,
      })),
      Array.from({ length: 3 }, () => ({
        method: "GET",
        endpoint: "/v1/api-keys",
        httpStatus: 503,
        envelopeKind: "object",
        envelopeFields: { error: "object", request_id: "string" },
        dataKind: "missing",
        validationCode: "http_error",
      })),
    );
    const provisioningProblems = readFileSync(join(dir, "diagnostics", "problems.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((problem) => problem.code === "ww_provider_provision_failed");
    assert.deepEqual(provisioningProblems.at(-1)?.facts, failedValidation.providerProvisioning.diagnosticFacts);
    assert.equal(apiKeyListRequests - listsBeforeOutage, 3);
    const quarantinedSettings = readSettings(join(dir, "bridge-settings.json"));
    const quarantinedWw = (quarantinedSettings.customProviders as any[]).find((provider) => provider.id === "ww");
    assert.equal(quarantinedWw.apiKey, "ww_sk_auto_1_secret_material", "a list outage must retain the recoverable key");
    assert.equal(
      quarantinedWw.provisioningBlocked,
      true,
      "the retained key must stay quarantined until owner validation succeeds",
    );

    apiKeyListScenario = "success";
    const restoredSession = await getJson(`${baseUrl}/api/auth/session`, sessionCookie);
    assert.equal(restoredSession.authenticated, true);
    assert.equal(restoredSession.providerProvisioning.status, "configured");
    assert.equal(restoredSession.providerProvisioning.createdApiKey, false);
    assert.equal(apiKeyRequests, 3);
    const restoredSettings = await getJson(`${baseUrl}/api/settings`, sessionCookie);
    assert.equal(restoredSettings.settings.kernel, "claude-code");
    assert.equal(
      providerFor(restoredSettings.settings, "claude-opus-4-8"),
      LOGIN_PROVIDER_BINDING_ID,
      "session restore must preserve the user's explicit Login choice",
    );
    const restoredWw = (readSettings(join(dir, "bridge-settings.json")).customProviders as any[]).find(
      (provider) => provider.id === "ww",
    );
    assert.equal(restoredWw.provisioningBlocked, undefined);

    const externalProviders = [
      ...(readSettings(join(dir, "bridge-settings.json")).customProviders as any[]),
      {
        id: "external-anthropic",
        name: "External Anthropic",
        custom: true,
        enabled: true,
        origin: "user",
        protocol: "anthropic-compatible",
        anthropicBaseUrl: "https://external.example.test",
        apiKey: "external-user-key",
        credentialKind: "api-key",
        models: [{ id: "external-model", label: "External Model" }],
      },
    ];
    const externalSettings = await patchJson(
      `${baseUrl}/api/settings`,
      {
        customProviders: externalProviders,
        modelProviderBindings: withProviderRoute(
          restoredSettings.settings.modelProviderBindings,
          "claude-opus-4-8",
          "external-anthropic",
        ),
      },
      sessionCookie,
    );
    assert.equal(providerFor(externalSettings.settings, "claude-opus-4-8"), "external-anthropic");

    const backToWwSettings = await patchJson(
      `${baseUrl}/api/settings`,
      {
        modelProviderBindings: withProviderRoute(
          externalSettings.settings.modelProviderBindings,
          "claude-opus-4-8",
          "ww",
        ),
      },
      sessionCookie,
    );
    assert.equal(
      providerFor(backToWwSettings.settings, "claude-opus-4-8"),
      "ww",
      "native and external choices must both be able to switch back to WW",
    );

    const secondLogin = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(secondLogin.providerProvisioning.status, "already-configured");
    assert.equal(secondLogin.providerProvisioning.createdApiKey, false);
    assert.equal(apiKeyRequests, 3);
    const reloginSettings = readSettings(join(dir, "bridge-settings.json"));
    assert.equal(reloginSettings.kernel, "claude-code");
  });

  const envKeyDir = join(dir, "env-key");
  process.env.OPENGROVE_WW_API_KEY = "ww_sk_auto_1_secret_material";
  const requestsBeforeEnvKey = apiKeyRequests;
  await withOpenGroveServer(join(envKeyDir, "state.json"), "local", async (baseUrl) => {
    const login = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(login.providerProvisioning.status, "configured");
    assert.equal(login.providerProvisioning.createdApiKey, false);
    assert.equal(apiKeyRequests, requestsBeforeEnvKey);
    const settingsText = readFileSync(join(envKeyDir, "bridge-settings.json"), "utf8");
    const settings = JSON.parse(settingsText) as Record<string, any>;
    const wwProvider = (settings.customProviders as any[]).find((provider) => provider.id === "ww");
    assert.equal(wwProvider.apiKey, undefined, "an env-backed WW key must not be copied inline");
    assert.equal(wwProvider.apiKeyEnv, "OPENGROVE_WW_API_KEY");
    assert.equal(settingsText.includes("ww_sk_auto_1_secret_material"), false);
  });
  delete process.env.OPENGROVE_WW_API_KEY;

  const legacyDir = join(dir, "legacy");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "bridge-settings.json"),
    JSON.stringify(
      {
        settingsSchemaVersion: 1,
        kernel: "auto",
        modelProviderBindings: [],
        customProviders: [
          {
            id: "ww",
            name: "WW",
            custom: true,
            enabled: true,
            origin: "user",
            protocol: "anthropic-compatible",
            anthropicBaseUrl: "https://old-ww.example.test",
            apiKey: "ww_sk_existing",
            credentialKind: "api-key",
            models: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await withOpenGroveServer(join(legacyDir, "state.json"), "local", async (baseUrl) => {
    const login = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(login.providerProvisioning.status, "configured");
    assert.equal(login.providerProvisioning.createdApiKey, false);
    assert.deepEqual(login.providerProvisioning.defaultedKernels, ["claude-code"]);
    assert.equal(apiKeyRequests, 3, "legacy configured provider should not create another WW API key");

    const settings = readSettings(join(legacyDir, "bridge-settings.json"));
    const wwProvider = (settings.customProviders as any[]).find((provider) => provider.id === "ww");
    assert.equal(settings.kernel, "claude-code");
    assert.equal(wwProvider.apiKey, "ww_sk_existing");
    assert.equal(wwProvider.anthropicBaseUrl, process.env.OPENGROVE_WW_BASE_URL);
    assert.deepEqual(wwProvider.models, wwDefaultProviderModels());
  });

  const foreignKeyDir = join(dir, "foreign-key");
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  mkdirSync(foreignKeyDir, { recursive: true });
  writeFileSync(
    join(foreignKeyDir, "bridge-settings.json"),
    JSON.stringify(
      {
        settingsSchemaVersion: 1,
        kernel: "auto",
        modelProviderBindings: [],
        customProviders: [
          {
            id: "ww",
            name: "WW",
            custom: true,
            enabled: true,
            origin: "user",
            protocol: "anthropic-compatible",
            anthropicBaseUrl: "https://old-ww.example.test",
            apiKey: "ww_sk_foreign_account",
            credentialKind: "api-key",
            models: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await withOpenGroveServer(join(foreignKeyDir, "state.json"), "local", async (baseUrl) => {
    const login = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(login.providerProvisioning.status, "configured");
    assert.equal(login.providerProvisioning.createdApiKey, true);
    assert.equal(apiKeyRequests, 4, "a WW key not owned by the current account must not be reused");

    const settings = readSettings(join(foreignKeyDir, "bridge-settings.json"));
    const wwProvider = (settings.customProviders as any[]).find((provider) => provider.id === "ww");
    assert.equal(wwProvider.apiKey, "ww_sk_auto_2_secret_material");
  });

  const unrelatedClaudeRouteDir = join(dir, "unrelated-claude-route");
  mkdirSync(unrelatedClaudeRouteDir, { recursive: true });
  writeFileSync(
    join(unrelatedClaudeRouteDir, "bridge-settings.json"),
    JSON.stringify(
      {
        settingsSchemaVersion: 1,
        providerSetupVersion: 2,
        providerRouteMigrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
        kernel: "auto",
        modelProviderBindings: [
          {
            modelId: "unrelated-external-model",
            providerId: "external-anthropic",
          },
        ],
        customProviders: [
          {
            id: "external-anthropic",
            name: "External Anthropic",
            custom: true,
            enabled: true,
            origin: "user",
            protocol: "anthropic-compatible",
            anthropicBaseUrl: "https://external.example.test",
            apiKey: "external-user-key",
            credentialKind: "api-key",
            models: [{ id: "unrelated-external-model", label: "Unrelated External Model" }],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(unrelatedClaudeRouteDir, "state.json"), "local", async (baseUrl) => {
    const login = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(login.providerProvisioning.status, "configured");
    const settings = readSettings(join(unrelatedClaudeRouteDir, "bridge-settings.json"));
    assert.equal(settings.kernel, "claude-code", "product defaults must not replace a preconfigured runtime");
    assert.equal(
      providerFor(settings, "unrelated-external-model"),
      "external-anthropic",
      "WW auto-binding must preserve the unrelated explicit model route",
    );
    assert.deepEqual(
      ["deepseek-v4-flash", "claude-opus-4-8", "deepseek-v4-pro"].map((modelId) => providerFor(settings, modelId)),
      ["ww", "ww", "ww"],
      "one-time product initialization must fill missing WW models without requiring an empty binding table",
    );
  });

  const revokedKeyDir = join(dir, "revoked-key");
  mkdirSync(revokedKeyDir, { recursive: true });
  writeFileSync(
    join(revokedKeyDir, "bridge-settings.json"),
    JSON.stringify(
      {
        settingsSchemaVersion: 1,
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
            anthropicBaseUrl: process.env.OPENGROVE_WW_BASE_URL,
            apiKey: "ww_sk_revoked",
            credentialKind: "api-key",
            models: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(revokedKeyDir, "ww-provider.json"),
    JSON.stringify(
      {
        version: 1,
        installationId: "11111111-1111-4111-8111-111111111111",
        ownerIssuer: process.env.OPENGROVE_WW_BASE_URL,
        ownerUserId: "user_ww",
        apiKeyId: "key-revoked",
        apiKeyPrefix: "ww_sk_revoked",
        pending: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  const requestsBeforeRevokedKey = apiKeyRequests;
  const listsBeforeRevokedKey = apiKeyListRequests;
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(revokedKeyDir, "state.json"), "local", async (baseUrl) => {
    const login = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(login.providerProvisioning.createdApiKey, true);
    assert.equal(apiKeyListRequests - listsBeforeRevokedKey, 1, "same-owner metadata must still be verified by WW");
    assert.equal(apiKeyRequests - requestsBeforeRevokedKey, 1, "a revoked/missing key should be replaced");
    const settings = readSettings(join(revokedKeyDir, "bridge-settings.json"));
    assert.notEqual(
      (settings.customProviders as any[]).find((provider) => provider.id === "ww")?.apiKey,
      "ww_sk_revoked",
    );
  });

  const wrongIssuerDir = join(dir, "wrong-issuer");
  mkdirSync(wrongIssuerDir, { recursive: true });
  writeFileSync(
    join(wrongIssuerDir, "bridge-settings.json"),
    JSON.stringify(
      {
        settingsSchemaVersion: 1,
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
            anthropicBaseUrl: process.env.OPENGROVE_WW_BASE_URL,
            apiKey: "ww_sk_auto_1_secret_material",
            credentialKind: "api-key",
            models: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(wrongIssuerDir, "ww-provider.json"),
    JSON.stringify(
      {
        version: 1,
        installationId: "22222222-2222-4222-8222-222222222222",
        ownerIssuer: "https://another-ww.example.test",
        ownerUserId: "user_ww",
        apiKeyId: "key-1",
        apiKeyPrefix: "ww_sk_auto_1",
        pending: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  const requestsBeforeWrongIssuer = apiKeyRequests;
  const listsBeforeWrongIssuer = apiKeyListRequests;
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(wrongIssuerDir, "state.json"), "local", async (baseUrl) => {
    const login = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(login.providerProvisioning.createdApiKey, true);
    assert.equal(
      apiKeyListRequests - listsBeforeWrongIssuer,
      1,
      "the current account must still be reconciled before replacing a foreign key",
    );
    assert.equal(apiKeyRequests - requestsBeforeWrongIssuer, 1);
  });

  const concurrentDir = join(dir, "concurrent");
  const requestsBeforeConcurrentLogin = apiKeyRequests;
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  apiKeyResponseDelayMs = 100;
  await withOpenGroveServer(join(concurrentDir, "state.json"), "local", async (baseUrl) => {
    const [first, second] = await Promise.all([
      postJson(`${baseUrl}/api/auth/login`, { email: "ww-user@example.test", code: "123456" }),
      postJson(`${baseUrl}/api/auth/login`, { email: "ww-user@example.test", code: "123456" }),
    ]);
    assert.equal(first.providerProvisioning.status, "configured");
    assert.equal(second.providerProvisioning.status, "configured");
    assert.equal(
      apiKeyRequests - requestsBeforeConcurrentLogin,
      1,
      "concurrent login/session provisioning should collapse into one WW key operation",
    );
  });
  apiKeyResponseDelayMs = 0;

  const pendingDefaultsDir = join(dir, "pending-defaults");
  apiKeyScenario = "fail";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(pendingDefaultsDir, "state.json"), "local", async (baseUrl) => {
    const failed = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(failed.body.providerProvisioning.status, "failed");
    await patchJson(
      `${baseUrl}/api/rooms/members/grove-guide`,
      {
        kernel: "claude-code",
        model: "user-selected-model",
        providerId: LOGIN_PROVIDER_BINDING_ID,
      },
      failed.cookie,
    );
    const settings = readSettings(join(pendingDefaultsDir, "bridge-settings.json"));
    assert.equal(settings.kernel, "claude-code");
    assert.deepEqual(settings.modelProviderBindings, []);
    assert.equal(readSettings(join(pendingDefaultsDir, "ww-provider.json")).productDefaults?.status, "pending");
  });
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(pendingDefaultsDir, "state.json"), "local", async (baseUrl) => {
    const recovered = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(recovered.body.providerProvisioning.status, "configured");
    const settings = readSettings(join(pendingDefaultsDir, "bridge-settings.json"));
    assert.equal(settings.kernel, "claude-code");
    assert.equal(settings.modelProviderBindings.length, 3);
    assert.equal(readSettings(join(pendingDefaultsDir, "ww-provider.json")).productDefaults?.status, "completed");
    const rooms = await getJson(`${baseUrl}/api/rooms`, recovered.cookie);
    const guide = (rooms.members as any[]).find((member) => member.id === "grove-guide");
    assert.equal(guide.kernel, "claude-code");
    assert.equal(guide.model, "user-selected-model");
    assert.equal(
      guide.providerId,
      LOGIN_PROVIDER_BINDING_ID,
      "product defaults must preserve an Employee Login chosen after a failed attempt",
    );
  });

  const failedDir = join(dir, "failed");
  const requestsBeforeFailedLogin = apiKeyRequests;
  apiKeyScenario = "fail";
  apiKeyScenarioAttempts = 0;
  let failedIdempotencyKey = "";
  await withOpenGroveServer(join(failedDir, "state.json"), "local", async (baseUrl) => {
    const response = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(response.body.providerProvisioning.status, "failed");
    assert.equal(
      apiKeyRequests - requestsBeforeFailedLogin,
      3,
      "failed WW provisioning should stop after three attempts",
    );
    failedIdempotencyKey = apiKeyIdempotencyHeaders.at(-1) ?? "";

    const settings = readSettings(join(failedDir, "bridge-settings.json"));
    const wwProvider = (settings.customProviders as any[]).find((provider) => provider.id === "ww");
    assert.equal(settings.kernel, "claude-code", "failed onboarding must not change the user's Kernel");
    assert.equal(
      providerFor(settings, "claude-opus-4-8"),
      undefined,
      "failed onboarding must not publish WW model defaults before the Key is ready",
    );
    assert.equal(wwProvider.apiKey, undefined, "a failed or foreign WW key must never remain usable");

    const runtimeSettings = await getJson(`${baseUrl}/api/settings`, response.cookie);
    assert.equal(findKernelOption(runtimeSettings.settings, "claude-code").available, false);
    assert.equal(
      findKernelOption(runtimeSettings.settings, "claude-code").unavailableCode,
      "provider_selection_required",
      "failed WW provisioning must require an explicit route instead of falling back to Login",
    );

    const nativeSettings = await patchJson(
      `${baseUrl}/api/settings`,
      {
        modelProviderBindings: withProviderRoute(
          runtimeSettings.settings.modelProviderBindings,
          "claude-opus-4-8",
          LOGIN_PROVIDER_BINDING_ID,
        ),
      },
      response.cookie,
    );
    assert.equal(nativeSettings.ok, true, "the user must still be able to explicitly choose local Claude");
    assert.equal(providerFor(nativeSettings.settings, "claude-opus-4-8"), LOGIN_PROVIDER_BINDING_ID);
    assert.equal(
      findKernelOption(nativeSettings.settings, "claude-code").available,
      false,
      "an explicit Login choice must remain selected without pretending missing account credentials are usable",
    );
  });

  const requestsBeforeRestartRecovery = apiKeyRequests;
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(failedDir, "state.json"), "local", async (baseUrl) => {
    const response = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(response.body.providerProvisioning.status, "configured");
    assert.equal(response.body.providerProvisioning.createdApiKey, true);
    assert.equal(apiKeyRequests - requestsBeforeRestartRecovery, 1);
    assert.equal(
      apiKeyIdempotencyHeaders.at(-1),
      failedIdempotencyKey,
      "a restart after failed provisioning must reuse the persisted operation id",
    );
    const recoveredSettings = await getJson(`${baseUrl}/api/settings`, response.cookie);
    assert.equal(recoveredSettings.settings.kernel, "claude-code", "recovery must preserve the user's Kernel choice");
    assert.equal(
      providerFor(recoveredSettings.settings, "claude-opus-4-8"),
      LOGIN_PROVIDER_BINDING_ID,
      "successful background recovery must not overwrite the user's Login choice",
    );

    const switchedBack = await patchJson(
      `${baseUrl}/api/settings`,
      {
        modelProviderBindings: withProviderRoute(
          recoveredSettings.settings.modelProviderBindings,
          "claude-opus-4-8",
          "ww",
        ),
      },
      response.cookie,
    );
    assert.equal(providerFor(switchedBack.settings, "claude-opus-4-8"), "ww");
    const switchedBackKernel = findKernelOption(switchedBack.settings, "claude-code");
    assert.equal(
      switchedBack.settings.activeModel,
      recoveredSettings.settings.activeModel,
      "changing the active model's route must not silently replace the selected model",
    );
    assert.equal(switchedBackKernel.available, true, "switching the active model back to WW must restore the Kernel");
    assert.equal(switchedBackKernel.providerId, "ww");
  });

  const expiredReplayDir = join(dir, "expired-replay");
  mkdirSync(expiredReplayDir, { recursive: true });
  writeFileSync(
    join(expiredReplayDir, "ww-provider.json"),
    JSON.stringify(
      {
        version: 1,
        installationId: "33333333-3333-4333-8333-333333333333",
        pending: [
          {
            issuer: process.env.OPENGROVE_WW_BASE_URL,
            userId: "user_ww",
            idempotencyKey: "og-expired-replay-must-not-be-sent",
            startedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const requestsBeforeExpiredReplay = apiKeyRequests;
  const listsBeforeExpiredReplay = apiKeyListRequests;
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(expiredReplayDir, "state.json"), "local", async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(response.providerProvisioning.status, "failed");
    assert.equal(response.providerProvisioning.error, "ww_api_key_provisioning_replay_expired");
    assert.equal(
      apiKeyRequests,
      requestsBeforeExpiredReplay,
      "a pending request beyond WW's replay window must not mint a duplicate key",
    );
    assert.equal(
      apiKeyListRequests,
      listsBeforeExpiredReplay,
      "an expired pending request has no safe local key identity to reconcile",
    );
  });

  const accountSwitchDir = join(dir, "account-switch");
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(accountSwitchDir, "state.json"), "local", async (baseUrl) => {
    const firstAccount = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "ww-user@example.test",
      code: "123456",
    });
    assert.equal(firstAccount.body.providerProvisioning.status, "configured");
    const secondAccount = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "other-ww-user@example.test",
      code: "123456",
    });
    assert.equal(secondAccount.body.providerProvisioning.status, "configured");

    const staleSession = await getJson(`${baseUrl}/api/auth/session`, firstAccount.cookie);
    assert.equal(staleSession.authenticated, false);
    assert.equal(staleSession.reason, "account_switched");

    const staleAccountResponse = await fetch(`${baseUrl}/api/settings`, {
      headers: { cookie: firstAccount.cookie },
    });
    assert.equal(
      staleAccountResponse.status,
      401,
      "an old account session must not run against the new account's WW key",
    );
    assert.match(staleAccountResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);

    const activeAccountSettings = await getJson(`${baseUrl}/api/settings`, secondAccount.cookie);
    assert.equal(activeAccountSettings.ok, true);
    const localOwner = readSettings(join(accountSwitchDir, "ww-provider.json"));
    assert.equal(localOwner.ownerUserId, "user_other");
  });

  const existingUserDir = join(dir, "existing-user");
  mkdirSync(existingUserDir, { recursive: true });
  writeFileSync(
    join(existingUserDir, "bridge-settings.json"),
    JSON.stringify(
      {
        settingsSchemaVersion: 1,
        providerRouteMigrationVersion: CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION,
        kernel: "auto",
        modelProviderBindings: [],
        customProviders: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  apiKeyScenario = "fail";
  apiKeyScenarioAttempts = 0;
  await withOpenGroveServer(join(existingUserDir, "state.json"), "local", async (baseUrl) => {
    const failed = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "existing-ww-user@example.test",
      code: "123456",
    });
    assert.equal(
      failed.body.providerProvisioning.status,
      "failed",
      "an existing account without a local WW Key must attempt provisioning",
    );
    await patchJson(
      `${baseUrl}/api/rooms/members/grove-guide`,
      {
        kernel: "kimi",
        model: "existing-user-model",
        providerId: LOGIN_PROVIDER_BINDING_ID,
      },
      failed.cookie,
    );
  });
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  const requestsBeforeExistingUserLogin = apiKeyRequests;
  await withOpenGroveServer(join(existingUserDir, "state.json"), "local", async (baseUrl) => {
    const response = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
      email: "existing-ww-user@example.test",
      code: "123456",
    });
    assert.equal(response.body.providerProvisioning.status, "configured");
    assert.equal(response.body.providerProvisioning.createdApiKey, true);
    assert.deepEqual(response.body.providerProvisioning.defaultedKernels, ["claude-code"]);
    assert.equal(
      apiKeyRequests - requestsBeforeExistingUserLogin,
      1,
      "an existing account on a fresh installation must receive a WW Key",
    );
    const session = await getJson(`${baseUrl}/api/auth/session`, response.cookie);
    assert.equal(session.providerProvisioning.status, "already-configured");
    assert.equal(session.providerProvisioning.createdApiKey, false);
    const settings = readSettings(join(existingUserDir, "bridge-settings.json"));
    assert.equal(settings.kernel, "claude-code", "an existing user login must not change the Kernel");
    assert.deepEqual(
      (settings.modelProviderBindings as any[]).map((binding) => [binding.modelId, binding.providerId]),
      [
        ["deepseek-v4-flash", "ww"],
        ["claude-opus-4-8", "ww"],
        ["deepseek-v4-pro", "ww"],
      ],
      "an existing WW account on a fresh installation must receive the same one-time product model defaults",
    );
    const wwProvider = (settings.customProviders as any[]).find((provider) => provider.id === "ww");
    assert.match(
      wwProvider.apiKey,
      /^ww_sk_auto_/,
      "the authenticated account must receive its local WW Provider and Key",
    );
    const liveSettings = await getJson(`${baseUrl}/api/settings`, response.cookie);
    assert.equal(liveSettings.settings.activeModel, "deepseek-v4-flash");
    assert.equal(findKernelOption(liveSettings.settings, "claude-code").providerId, "ww");
    const rooms = await getJson(`${baseUrl}/api/rooms`, response.cookie);
    const guide = (rooms.members as any[]).find((member) => member.id === "grove-guide");
    assert.equal(guide.kernel, "kimi");
    assert.equal(guide.model, "existing-user-model");
    assert.equal(
      guide.providerId,
      LOGIN_PROVIDER_BINDING_ID,
      "WW Key setup must preserve existing Employee routing choices",
    );
  });

  const legacyCompletedDefaultsDir = join(dir, "legacy-completed-defaults");
  mkdirSync(legacyCompletedDefaultsDir, { recursive: true });
  writeFileSync(
    join(legacyCompletedDefaultsDir, "bridge-settings.json"),
    JSON.stringify(
      {
        settingsSchemaVersion: 1,
        kernel: "claude-code",
        modelProviderBindings: [{ modelId: "claude-opus-4-8", providerId: "$native" }],
        customProviders: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(legacyCompletedDefaultsDir, "ww-provider.json"),
    JSON.stringify(
      {
        version: 1,
        installationId: "44444444-4444-4444-8444-444444444444",
        newUserDefaults: {
          issuer: process.env.OPENGROVE_WW_BASE_URL,
          userId: "user_ww",
          status: "completed",
        },
        pending: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  apiKeyScenario = "success";
  apiKeyScenarioAttempts = 0;
  await withEnv(
    {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: "ABSKlegacy-migration-test-key",
    },
    async () => {
      await withOpenGroveServer(join(legacyCompletedDefaultsDir, "state.json"), "local", async (baseUrl) => {
        const response = await postJsonWithCookie(`${baseUrl}/api/auth/login`, {
          email: "ww-user@example.test",
          code: "123456",
        });
        assert.deepEqual(response.body.providerProvisioning.defaultedKernels, []);
        const settings = readSettings(join(legacyCompletedDefaultsDir, "bridge-settings.json"));
        assert.equal(
          providerFor(settings, "claude-opus-4-8"),
          "aws-bedrock-api-key",
          "a completed 0.6.1 defaults marker must migrate the old local route without reapplying WW over later user choices",
        );
        assert.equal(
          (settings.customProviders as any[]).some(
            (provider) => provider.origin === "discovered" && provider.sourceKernel === "claude-code",
          ),
          false,
          "the compatibility read must not restore Claude-scanned Providers in Host settings",
        );
        assert.equal(settings.providerRouteMigrationVersion, CURRENT_PROVIDER_ROUTE_MIGRATION_VERSION);
        const localState = readSettings(join(legacyCompletedDefaultsDir, "ww-provider.json"));
        assert.equal(localState.newUserDefaults, undefined);
        assert.equal(localState.productDefaults?.status, "completed");
      });
    },
  );

  console.log("ww-provider-provisioning-harness ok");
} finally {
  await new Promise<void>((resolve, reject) => {
    fakeWw.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousWwBaseUrl === undefined) {
    delete process.env.OPENGROVE_WW_BASE_URL;
  } else {
    process.env.OPENGROVE_WW_BASE_URL = previousWwBaseUrl;
  }
  if (previousWwApiKey === undefined) {
    delete process.env.OPENGROVE_WW_API_KEY;
  } else {
    process.env.OPENGROVE_WW_API_KEY = previousWwApiKey;
  }
  if (previousWebAuthMode === undefined) {
    delete process.env.OPENGROVE_WEB_AUTH_MODE;
  } else {
    process.env.OPENGROVE_WEB_AUTH_MODE = previousWebAuthMode;
  }
  if (previousClaudeCliPath === undefined) {
    delete process.env.OPENGROVE_CLAUDE_CLI_PATH;
  } else {
    process.env.OPENGROVE_CLAUDE_CLI_PATH = previousClaudeCliPath;
  }
  if (previousAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
  }
  rmSync(dir, { recursive: true, force: true });
}

async function withOpenGroveServer(
  statePath: string,
  profile: "local",
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  isolateFixtureClaudeConfig(statePath);
  const server = startOpenGroveServer({
    host: "127.0.0.1",
    port: 0,
    profile,
    statePath,
  });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    const databasePath = statePath.endsWith(".json") ? `${statePath.slice(0, -5)}.sqlite` : statePath;
    const lockPaths = [`${databasePath}.lock`, `${statePath}.lock`];
    for (let attempt = 0; attempt < 100 && lockPaths.some((path) => existsSync(path)); attempt += 1) {
      await delay(10);
    }
    assert.equal(
      lockPaths.some((path) => existsSync(path)),
      false,
      "server close must release persisted-state locks before the restart phase",
    );
  }
}

function isolateFixtureClaudeConfig(statePath: string): void {
  const settingsPath = join(dirname(statePath), "bridge-settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = readSettings(settingsPath);
  const configHome = join(dirname(statePath), ".test-claude-config");
  mkdirSync(configHome, { recursive: true });
  const overrides = settings.kernelPathOverrides as Record<string, Record<string, unknown>> | undefined;
  settings.kernelPathOverrides = {
    ...overrides,
    "claude-code": {
      ...(overrides?.["claude-code"] ?? {}),
      configHome,
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  chmodSync(settingsPath, 0o600);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function postJson(url: string, payload: unknown): Promise<Record<string, any>> {
  return (await postJsonWithCookie(url, payload)).body;
}

async function postJsonWithCookie(
  url: string,
  payload: unknown,
): Promise<{ body: Record<string, any>; cookie: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return {
    body: (await response.json()) as Record<string, any>,
    cookie: cookieHeaderFromResponse(response),
  };
}

async function patchJson(url: string, payload: unknown, cookie?: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
}

async function getJson(url: string, cookie?: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    headers: cookie ? { cookie } : undefined,
  });
  if (!response.ok) {
    assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
}

function readSettings(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function findKernelOption(settings: Record<string, any>, id: string): Record<string, any> {
  const kernels = Array.isArray(settings.kernels) ? settings.kernels : [];
  const kernel = kernels.find((item) => item?.id === id);
  assert.ok(kernel, `missing kernel option: ${id}`);
  return kernel as Record<string, any>;
}

function providerFor(settings: Record<string, any>, modelId: string): string | undefined {
  return (settings.modelProviderBindings as any[] | undefined)?.find((binding) => binding.modelId === modelId)
    ?.providerId;
}

function withProviderRoute(bindings: any[], modelId: string, providerId: string): any[] {
  return [...bindings.filter((binding) => binding.modelId !== modelId), { modelId, providerId }];
}

function cookieHeaderFromResponse(response: Response): string {
  const rawCookies =
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    splitSetCookieHeader(response.headers.get("set-cookie"));
  return rawCookies
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function splitSetCookieHeader(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,\s*(?=[^;,]+=)/g);
}
