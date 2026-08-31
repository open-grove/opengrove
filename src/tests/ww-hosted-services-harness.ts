import assert from "node:assert/strict";
import {
  WW_API_REQUEST_MAX_ATTEMPTS,
  WW_API_REQUEST_TIMEOUT_MS,
  createWwHostedServices,
  wwDiagnosticFacts,
  type WwApiError,
} from "../server/ww/index.js";

const baseUrl = "https://ww.example.test/root/";

assert.equal(WW_API_REQUEST_TIMEOUT_MS, 10_000);
assert.equal(WW_API_REQUEST_MAX_ATTEMPTS, 3);
testHostedServiceCapabilitiesAreSeparated();

await testAccountProfileMappingAndUpdate();
await testUnavailableProfileMappingAndClearRequest();
await testRegistrationCountryContract();
await testClientActivityUsesExactMinimalContract();
await testCreateApiKeyReusesIdempotencyKeyAndHonorsRetryAfter();
await testCreateApiKeyStopsAfterThreeAttempts();
await testCreateApiKeyRetriesTimeouts();
await testRetryAfterCannotExceedRequestDeadline();
await testCreateApiKeyRetriesMalformedSuccessWithSameOperation();
await testCreateApiKeyRejectsMissingIdempotencyKey();
await testListApiKeysUsesSafeRetry();
await testNullApiKeyListIsEmpty();
await testMalformedApiKeyResponseExposesSafeShape();
await testDeadlineExhaustionPreservesCollectedDiagnostics();
await testDeterministicErrorsAreNotRetried();
await testClientUpdatesUseRawGetContract();
await testClientUpdatesAbortOnTimeout();
await testAuthRequestsUseTimeoutAndPreserveEnvelopeRequestId();

console.log("ww-hosted-services-harness ok");

function testHostedServiceCapabilitiesAreSeparated(): void {
  const services = createWwHostedServices(baseUrl);
  assert.deepEqual(Object.keys(services).sort(), [
    "account",
    "clientActivity",
    "clientUpdates",
    "profile",
    "providerCredentials",
  ]);
  assert.equal("login" in services.account, true);
  assert.equal("updateCurrentUser" in services.account, false);
  assert.equal("createApiKey" in services.providerCredentials, true);
  assert.equal("createApiKey" in services.account, false);
}

async function testAccountProfileMappingAndUpdate(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  await withMockFetch(
    async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(200, {
        data: {
          user_id: "user-profile",
          email: "profile@example.test",
          country_code: "JP",
          display_name: "林间用户",
          avatar_url: "https://assets.example.test/ww/user-profiles/user-profile/avatar.jpg",
          profile_updated_at: "2026-07-28T08:00:00Z",
          profile_status: "available",
          role: "member",
          roles: ["storyseed_writer", "member", "storyseed_writer"],
        },
        request_id: "req-profile-update",
      });
    },
    async () => {
      const user = await createWwHostedServices(baseUrl).profile.updateCurrentUser("access-token", {
        displayName: "林间用户",
        avatarDataUrl: "data:image/jpeg;base64,/9j/AA==",
      });
      assert.deepEqual(user, {
        userId: "user-profile",
        email: "profile@example.test",
        countryCode: "JP",
        displayName: "林间用户",
        avatarUrl: "https://assets.example.test/ww/user-profiles/user-profile/avatar.jpg",
        profileUpdatedAt: "2026-07-28T08:00:00Z",
        profileStatus: "available",
        role: "member",
        roles: ["member", "storyseed_writer"],
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://ww.example.test/root/v1/users/me");
  assert.equal(calls[0]?.init?.method, "PATCH");
  assert.equal(headersFor(calls[0]?.init).get("authorization"), "Bearer access-token");
  assert.equal(headersFor(calls[0]?.init).get("content-type"), "application/json");
  assert.equal(
    calls[0]?.init?.body,
    JSON.stringify({
      display_name: "林间用户",
      avatar_data_url: "data:image/jpeg;base64,/9j/AA==",
    }),
  );
}

async function testRegistrationCountryContract(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  await withMockFetch(
    async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/v1/auth/email-codes")) {
        return jsonResponse(202, { data: { requires_invite: true, requires_country: true } });
      }
      return jsonResponse(200, {
        data: {
          access_token: "access",
          access_token_expires_in: 300,
          refresh_token: "refresh",
          refresh_token_expires_in: 1800,
          token_type: "Bearer",
          is_new_user: true,
        },
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl).account;
      assert.deepEqual(await client.sendEmailCode("new@example.test"), {
        requiresInvite: true,
        requiresCountry: true,
      });
      const pair = await client.login({
        email: "new@example.test",
        code: "123456",
        inviteCode: "abcd-2345-wxyz",
        countryCode: " jp ",
      });
      assert.equal(pair.isNewUser, true);
      await client.login({
        email: "new@example.test",
        code: "123456",
        countryCode: " usa ",
      });
    },
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    email: "new@example.test",
    code: "123456",
    device_name: "OpenGrove Web",
    platform: "unknown",
    invite_code: "ABCD-2345-WXYZ",
    country_code: "JP",
  });
  assert.equal(JSON.parse(String(calls[2]?.init?.body)).country_code, "USA");
}

async function testUnavailableProfileMappingAndClearRequest(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  await withMockFetch(
    async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(200, {
        data: {
          user_id: "user-profile",
          email: "profile@example.test",
          profile_status: "unavailable",
          role: "member",
        },
      });
    },
    async () => {
      const user = await createWwHostedServices(baseUrl).profile.updateCurrentUser("access-token", {
        displayName: null,
        avatarDataUrl: null,
      });
      assert.deepEqual(user, {
        userId: "user-profile",
        email: "profile@example.test",
        displayName: "profile@example.test",
        profileStatus: "unavailable",
        role: "member",
        roles: ["member"],
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://ww.example.test/root/v1/users/me");
  assert.equal(
    calls[0]?.init?.body,
    JSON.stringify({
      display_name: null,
      avatar_data_url: null,
    }),
  );
}

async function testClientActivityUsesExactMinimalContract(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  await withMockFetch(
    async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(200, { data: { day: "2026-08-05" }, request_id: "req-activity" });
    },
    async () => {
      const result = await createWwHostedServices(baseUrl).clientActivity.recordClientActivity("access-token", {
        surface: "desktop",
        operatingSystem: "macos",
        architecture: "arm64",
        clientVersion: "0.6.1",
        clientReleaseNumber: 560,
        bridgeVersion: "0.6.1",
        bridgeReleaseNumber: 559,
        releaseChannel: "stable",
      });
      assert.deepEqual(result, { day: "2026-08-05" });
    },
  );

  assert.equal(calls.length, 1, "daily activity must not use the retrying request helper");
  assert.equal(calls[0]?.url, "https://ww.example.test/root/v1/client/activity");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(headersFor(calls[0]?.init).get("authorization"), "Bearer access-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    surface: "desktop",
    operating_system: "macos",
    architecture: "arm64",
    client_version: "0.6.1",
    client_release_number: 560,
    bridge_version: "0.6.1",
    bridge_release_number: 559,
    release_channel: "stable",
  });
}

async function testCreateApiKeyReusesIdempotencyKeyAndHonorsRetryAfter(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined; at: number }> = [];
  await withMockFetch(
    async (input, init) => {
      calls.push({ url: String(input), init, at: Date.now() });
      if (calls.length === 1) {
        return jsonResponse(
          429,
          {
            error: { code: 100002, message: "rate limited", request_id: "req-rate" },
          },
          { "Retry-After": "1" },
        );
      }
      return jsonResponse(201, {
        data: {
          id: "key-1",
          name: "OpenGrove WW Provider",
          api_key: "ww_sk_secret",
          key_prefix: "ww_sk_secret",
          status: "active",
          created_at: "2026-07-10T00:00:00Z",
        },
        request_id: "req-created",
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      const created = await client.createApiKey("access-token", "OpenGrove WW Provider", {
        idempotencyKey: "  provision-attempt-1  ",
      });
      assert.deepEqual(created, {
        id: "key-1",
        name: "OpenGrove WW Provider",
        apiKey: "ww_sk_secret",
        keyPrefix: "ww_sk_secret",
        status: "active",
        createdAt: "2026-07-10T00:00:00Z",
      });
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://ww.example.test/root/v1/api-keys");
  assert.ok((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0) >= 900, "Retry-After delay was not honored");
  for (const call of calls) {
    assert.equal(call.init?.method, "POST");
    assert.equal(headersFor(call.init).get("authorization"), "Bearer access-token");
    assert.equal(headersFor(call.init).get("idempotency-key"), "provision-attempt-1");
    assert.equal(headersFor(call.init).get("content-type"), "application/json");
    assert.equal(call.init?.body, JSON.stringify({ name: "OpenGrove WW Provider" }));
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
}

async function testCreateApiKeyStopsAfterThreeAttempts(): Promise<void> {
  const idempotencyKeys: string[] = [];
  await withMockFetch(
    async (_input, init) => {
      idempotencyKeys.push(headersFor(init).get("idempotency-key") ?? "");
      return jsonResponse(
        503,
        {
          error: { code: 100500, message: "unavailable", request_id: "req-unavailable" },
        },
        { "Retry-After": "0" },
      );
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      await assert.rejects(
        client.createApiKey("access-token", "OpenGrove WW Provider", {
          idempotencyKey: "provision-attempt-2",
        }),
        (error: WwApiError) => {
          assert.equal(error.status, 503);
          assert.equal(error.publicCode, "auth_unavailable");
          return true;
        },
      );
    },
  );

  assert.equal(idempotencyKeys.length, WW_API_REQUEST_MAX_ATTEMPTS);
  assert.deepEqual(idempotencyKeys, ["provision-attempt-2", "provision-attempt-2", "provision-attempt-2"]);
}

async function testCreateApiKeyRetriesTimeouts(): Promise<void> {
  let attempts = 0;
  let firstAttemptAborted = false;
  const startedAt = Date.now();
  await withMockFetch(
    async (_input, init) => {
      attempts += 1;
      if (attempts === 1) {
        const signal = init?.signal;
        assert.ok(signal);
        const response = jsonResponse(201, { data: {} });
        Object.defineProperty(response, "json", {
          value: async () =>
            await new Promise<unknown>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  firstAttemptAborted = true;
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
        });
        return response;
      }
      return jsonResponse(201, {
        data: {
          id: "key-after-timeout",
          name: "OpenGrove WW Provider",
          api_key: "ww_sk_after_timeout",
          key_prefix: "ww_sk_after",
          status: "active",
        },
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      const created = await client.createApiKey("access-token", "OpenGrove WW Provider", {
        idempotencyKey: "provision-attempt-timeout",
        timeoutMs: 80,
      });
      assert.equal(created.apiKey, "ww_sk_after_timeout");
    },
  );

  assert.equal(attempts, 2);
  assert.equal(firstAttemptAborted, true);
  assert.ok(Date.now() - startedAt < 250, "retry attempts must share one bounded deadline");
}

async function testRetryAfterCannotExceedRequestDeadline(): Promise<void> {
  let attempts = 0;
  const startedAt = Date.now();
  await withMockFetch(
    async () => {
      attempts += 1;
      return jsonResponse(
        429,
        {
          error: { code: 100002, message: "rate limited", request_id: "req-long-retry" },
        },
        { "Retry-After": "3600" },
      );
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      await assert.rejects(
        client.createApiKey("access-token", "OpenGrove WW Provider", {
          idempotencyKey: "provision-long-retry",
          timeoutMs: 80,
        }),
        (error: WwApiError) => error.status === 429,
      );
    },
  );
  assert.equal(attempts, WW_API_REQUEST_MAX_ATTEMPTS);
  assert.ok(Date.now() - startedAt < 250, "Retry-After must be capped by the operation deadline");
}

async function testCreateApiKeyRetriesMalformedSuccessWithSameOperation(): Promise<void> {
  const idempotencyKeys: string[] = [];
  await withMockFetch(
    async (_input, init) => {
      idempotencyKeys.push(headersFor(init).get("idempotency-key") ?? "");
      if (idempotencyKeys.length === 1) {
        return jsonResponse(201, {
          data: {
            id: "key-truncated",
            name: "OpenGrove WW Provider",
            key_prefix: "ww_sk_truncated",
            status: "active",
          },
        });
      }
      return jsonResponse(201, {
        data: {
          id: "key-complete",
          name: "OpenGrove WW Provider",
          api_key: "ww_sk_complete_secret",
          key_prefix: "ww_sk_complete",
          status: "active",
        },
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      const created = await client.createApiKey("access-token", "OpenGrove WW Provider", {
        idempotencyKey: "provision-attempt-malformed",
      });
      assert.equal(created.apiKey, "ww_sk_complete_secret");
    },
  );
  assert.deepEqual(idempotencyKeys, ["provision-attempt-malformed", "provision-attempt-malformed"]);
}

async function testCreateApiKeyRejectsMissingIdempotencyKey(): Promise<void> {
  let calls = 0;
  await withMockFetch(
    async () => {
      calls += 1;
      throw new Error("unexpected fetch");
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      await assert.rejects(
        client.createApiKey("access-token", "OpenGrove WW Provider", { idempotencyKey: "   " }),
        /ww_idempotency_key_required/,
      );
    },
  );
  assert.equal(calls, 0);
}

async function testListApiKeysUsesSafeRetry(): Promise<void> {
  const calls: Array<RequestInit | undefined> = [];
  await withMockFetch(
    async (_input, init) => {
      calls.push(init);
      if (calls.length === 1) {
        return jsonResponse(
          503,
          {
            error: { code: 100500, message: "unavailable", request_id: "req-list-unavailable" },
          },
          { "Retry-After": "0" },
        );
      }
      return jsonResponse(200, {
        data: [
          {
            id: "key-owned",
            name: "OpenGrove WW Provider",
            key_prefix: "ww_sk_owned",
            status: "active",
            created_at: "2026-07-09T00:00:00Z",
            updated_at: "2026-07-10T00:00:00Z",
          },
        ],
        request_id: "req-list",
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      assert.deepEqual(await client.listApiKeys("owner-access", { timeoutMs: 50 }), [
        {
          id: "key-owned",
          name: "OpenGrove WW Provider",
          keyPrefix: "ww_sk_owned",
          status: "active",
          createdAt: "2026-07-09T00:00:00Z",
        },
      ]);
    },
  );

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call?.method, "GET");
    assert.equal(headersFor(call).get("authorization"), "Bearer owner-access");
    assert.equal(headersFor(call).get("idempotency-key"), null);
    assert.ok(call?.signal instanceof AbortSignal);
  }
}

async function testNullApiKeyListIsEmpty(): Promise<void> {
  let calls = 0;
  await withMockFetch(
    async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "GET");
      return jsonResponse(200, {
        data: null,
        request_id: "req-empty-list",
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      assert.deepEqual(await client.listApiKeys("owner-access"), []);
    },
  );
  assert.equal(calls, 1, "a successful empty list response must not be retried");
}

async function testMalformedApiKeyResponseExposesSafeShape(): Promise<void> {
  let attempts = 0;
  const secret = "ww_sk_must_not_appear_secret";
  await withMockFetch(
    async () => {
      attempts += 1;
      return jsonResponse(201, {
        data: {
          id: "key-malformed",
          name: "OpenGrove WW Provider",
          key_prefix: "ww_sk_prefix",
          status: "active",
          unexpected_token: secret,
        },
        request_id: `req-shape-${attempts}`,
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl).providerCredentials;
      await assert.rejects(
        client.createApiKey("access-token", "OpenGrove WW Provider", {
          idempotencyKey: "provision-shape-evidence",
          timeoutMs: 120,
        }),
        (
          error: Error & {
            responseDiagnostics?: {
              attempts?: Array<Record<string, unknown>>;
            };
          },
        ) => {
          assert.equal(error.message, "ww_api_key_response_invalid");
          assert.equal(error.responseDiagnostics?.attempts?.length, WW_API_REQUEST_MAX_ATTEMPTS);
          assert.deepEqual(error.responseDiagnostics?.attempts?.[0], {
            attempt: 1,
            method: "POST",
            endpoint: "/v1/api-keys",
            httpStatus: 201,
            upstreamRequestId: "req-shape-1",
            contentType: "application/json",
            envelopeKind: "object",
            envelopeFields: {
              data: "object",
              request_id: "string",
            },
            dataKind: "object",
            dataFields: {
              id: "string",
              key_prefix: "string",
              name: "string",
              status: "string",
              unexpected_token: "string",
            },
            validationCode: "missing_required_fields",
            missingFields: ["api_key"],
          });
          assert.doesNotMatch(JSON.stringify(error.responseDiagnostics), new RegExp(secret));
          const facts = wwDiagnosticFacts(error);
          assert.equal(facts?.attemptCount, WW_API_REQUEST_MAX_ATTEMPTS);
          assert.equal(facts?.httpStatus, 201);
          assert.equal(facts?.upstreamRequestId, "req-shape-3");
          assert.deepEqual(facts?.httpResponses, error.responseDiagnostics?.attempts);
          return true;
        },
      );
    },
  );
  assert.equal(attempts, WW_API_REQUEST_MAX_ATTEMPTS);
}

async function testDeadlineExhaustionPreservesCollectedDiagnostics(): Promise<void> {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    await withMockFetch(
      async () => {
        const response = jsonResponse(503, {
          error: { code: 100500, message: "unavailable", request_id: "req-before-deadline" },
        });
        Object.defineProperty(response, "json", {
          value: async () => {
            now = 1_200;
            return {
              error: { code: 100500, message: "unavailable", request_id: "req-before-deadline" },
            };
          },
        });
        return response;
      },
      async () => {
        const client = createWwHostedServices(baseUrl).providerCredentials;
        await assert.rejects(client.listApiKeys("access-token", { timeoutMs: 100 }), (error: Error) => {
          const facts = wwDiagnosticFacts(error);
          assert.equal(facts?.attemptCount, 1);
          assert.equal(facts?.httpStatus, 503);
          assert.equal(facts?.upstreamRequestId, "req-before-deadline");
          return true;
        });
      },
    );
  } finally {
    Date.now = realNow;
  }
}

async function testDeterministicErrorsAreNotRetried(): Promise<void> {
  for (const testCase of [
    { status: 401, code: 110201, publicCode: "access_token_invalid" },
    { status: 401, code: 110203, publicCode: "api_key_invalid" },
    { status: 409, code: 100409, publicCode: "auth_unavailable" },
  ]) {
    let calls = 0;
    await withMockFetch(
      async () => {
        calls += 1;
        const response = jsonResponse(testCase.status, {
          error: { code: testCase.code, message: "deterministic error", request_id: "req-deterministic" },
        });
        if (testCase.status === 409) {
          Object.defineProperty(response, "json", {
            value: async () => {
              throw new SyntaxError("truncated conflict response");
            },
          });
        }
        return response;
      },
      async () => {
        const client = createWwHostedServices(baseUrl).providerCredentials;
        await assert.rejects(client.listApiKeys("access-token"), (error: WwApiError) => {
          assert.equal(error.status, testCase.status);
          assert.equal(error.publicCode, testCase.publicCode);
          return true;
        });
      },
    );
    assert.equal(calls, 1);
  }
}

async function testClientUpdatesUseRawGetContract(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  await withMockFetch(
    async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/v1/public/client/latest-version")) {
        return jsonResponse(200, {
          mac_arm64: {
            version: 888,
            download_url: "https://downloads.example.test/opengrove-888-arm64.dmg",
          },
        });
      }
      return jsonResponse(200, {
        mac_arm64: {
          version: 888,
          download_url: "https://downloads.example.test/opengrove-888-arm64.dmg",
          updater_feed_url: "https://updates.example.test/macos/arm64",
          release_notes: "Capability-specific WW clients",
        },
        windows_x64: {
          version: 889,
        },
      });
    },
    async () => {
      const latest = await createWwHostedServices(baseUrl).clientUpdates.readLatestClientVersion("access-token");
      assert.deepEqual(latest.macArm64, {
        version: 888,
        downloadUrl: "https://downloads.example.test/opengrove-888-arm64.dmg",
        updaterBaseUrl: undefined,
        updaterFeedUrl: "https://updates.example.test/macos/arm64",
        releasedAt: undefined,
        releaseNotes: "Capability-specific WW clients",
      });
      assert.equal(latest.windowsX64, undefined, "versions without a download URL must be ignored");
      const publicLatest = await createWwHostedServices(baseUrl).clientUpdates.readPublicLatestClientVersion();
      assert.deepEqual(publicLatest.macArm64, {
        version: 888,
        downloadUrl: "https://downloads.example.test/opengrove-888-arm64.dmg",
        updaterBaseUrl: undefined,
        updaterFeedUrl: undefined,
        releasedAt: undefined,
        releaseNotes: undefined,
      });
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://ww.example.test/root/v1/client/latest-version");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(headersFor(calls[0]?.init).get("authorization"), "Bearer access-token");
  assert.equal(headersFor(calls[0]?.init).get("content-type"), null);
  assert.equal(calls[0]?.init?.body, undefined);
  assert.equal(calls[1]?.url, "https://ww.example.test/root/v1/public/client/latest-version");
  assert.equal(calls[1]?.init?.method, "GET");
  assert.equal(headersFor(calls[1]?.init).get("authorization"), null);
}

async function testClientUpdatesAbortOnTimeout(): Promise<void> {
  let timeoutSignal: AbortSignal | undefined;
  await withMockFetch(
    async (_input, init) => {
      timeoutSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        timeoutSignal?.addEventListener("abort", () => reject(timeoutSignal?.reason), { once: true });
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl, { requestTimeoutMs: 10 }).clientUpdates;
      await assert.rejects(client.readLatestClientVersion("access-token"), /ww_request_timeout/);
    },
  );
  assert.equal(timeoutSignal?.aborted, true);
}

async function testAuthRequestsUseTimeoutAndPreserveEnvelopeRequestId(): Promise<void> {
  let timeoutSignal: AbortSignal | undefined;
  await withMockFetch(
    async (_input, init) => {
      timeoutSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        timeoutSignal?.addEventListener("abort", () => reject(timeoutSignal?.reason), { once: true });
      });
    },
    async () => {
      const client = createWwHostedServices(baseUrl, { requestTimeoutMs: 10 }).account;
      await assert.rejects(client.sendEmailCode("timeout@example.test"), /ww_request_timeout/);
    },
  );
  assert.equal(timeoutSignal?.aborted, true);

  await withMockFetch(
    async () =>
      jsonResponse(429, {
        error: { code: 100002, message: "rate limited" },
        request_id: "req-envelope-rate",
      }),
    async () => {
      const client = createWwHostedServices(baseUrl).account;
      await assert.rejects(client.sendEmailCode("limited@example.test"), (error: WwApiError) => {
        assert.equal(error.publicCode, "rate_limited");
        assert.equal(error.requestId, "req-envelope-rate");
        return true;
      });
    },
  );
}

async function withMockFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function headersFor(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}
