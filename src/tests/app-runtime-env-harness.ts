import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { BridgeState } from "../server/bridge-types.js";
import { resolveMountedAppRuntimeEnv } from "../server/app-runtime-env.js";
import { normalizeCustomProviderProfiles } from "../server/provider-profiles.js";

const tmp = mkdtempSync(join(tmpdir(), "opengrove-app-runtime-env-"));
const appRoot = join(tmp, "mounted-app");
const appWorkspaceRoot = join(tmp, "persistent-workspaces", "env-app");
const appTempRoot = join(appWorkspaceRoot, "runs", ".tmp");
process.env.AWS_BEARER_TOKEN_BEDROCK = "ABSKenv-bedrock-test-key";
mkdirSync(appRoot, { recursive: true });
mkdirSync(appWorkspaceRoot, { recursive: true });
writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "env-app",
      title: "Env App",
      ui: { surface: "file-workbench", workspace: "workspace" },
      workspace: { path: "workspace" },
      runtimeEnv: {
        providerKeys: [
          {
            providerId: "aws-bedrock-api-key",
            env: { apiKey: "AWS_BEARER_TOKEN_BEDROCK" },
          },
          {
            providerId: "gemini",
            env: { apiKey: ["GOOGLE_API_KEY", "GEMINI_API_KEY"] },
          },
          {
            providerId: "missing-provider",
            env: { apiKey: "MISSING_PROVIDER_KEY" },
            required: true,
          },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);
writeFileSync(
  join(appRoot, "secrets.schema.json"),
  JSON.stringify(
    {
      version: 1,
      secrets: [
        {
          id: "shared-token",
          env: "APP_SHARED_TOKEN",
          required: true,
        },
        {
          id: "clipper-token",
          env: "APP_CLIPPER_TOKEN",
          aliases: ["APP_CLIPPER_TOKEN_ALIAS"],
          employees: ["clipper"],
          required: true,
        },
        {
          id: "clipper-missing-token",
          env: "APP_CLIPPER_MISSING_TOKEN",
          employees: ["clipper"],
          required: true,
        },
        {
          id: "material-token",
          env: "APP_MATERIAL_TOKEN",
          employees: ["material"],
        },
      ],
    },
    null,
    2,
  ),
  "utf8",
);
writeFileSync(
  join(appRoot, ".env.local"),
  [
    "APP_SHARED_TOKEN=shared-local-secret",
    "APP_CLIPPER_TOKEN_ALIAS=clipper-local-secret",
    "APP_MATERIAL_TOKEN=material-local-secret",
    "",
  ].join("\n"),
  "utf8",
);

const state = {
  settings: {
    languagePreference: "en",
    mountedApps: [
      {
        id: "env-app",
        path: appRoot,
        workspacePath: appWorkspaceRoot,
        enabled: true,
      },
    ],
    customProviders: [
      {
        id: "aws-bedrock-api-key",
        name: "AWS Bedrock (API Key)",
        protocol: "anthropic-compatible",
        credentialKind: "api-key",
        apiKey: "ark-invalid-bedrock-test-key",
        models: [],
      },
      {
        id: "gemini",
        name: "Google AI Studio (Gemini API Key)",
        protocol: "gemini-compatible",
        credentialKind: "api-key",
        apiKey: "gemini-test-key",
        models: [],
      },
    ],
  },
} as unknown as BridgeState;

const resolved = resolveMountedAppRuntimeEnv(state, "env-app");
assert.ok(resolved);
assert.equal(resolved.appId, "env-app");
assert.equal(resolved.env.OPENGROVE_APP_ID, "env-app");
assert.equal(resolved.env.OPENGROVE_APP_ROOT, appRoot);
assert.equal(resolved.env.OPENGROVE_APP_WORKSPACE_ROOT, appWorkspaceRoot);
assert.equal(resolved.env.OPENGROVE_WORKSPACE_PROVIDER, "local");
assert.equal(resolved.env.OPENGROVE_LOCALE, "en");
assert.equal(resolved.env.TMPDIR, appTempRoot);
assert.equal(resolved.env.TMP, appTempRoot);
assert.equal(resolved.env.TEMP, appTempRoot);
const expectedUserCliDir =
  process.platform === "win32" ? join(homedir(), "scoop", "shims") : join(homedir(), ".local", "bin");
assert.ok(
  resolved.env.PATH?.split(delimiter).includes(expectedUserCliDir),
  "mounted App Agents should receive common user-level CLI install directories",
);
assert.equal(resolved.env.AWS_BEARER_TOKEN_BEDROCK, "ABSKenv-bedrock-test-key");
assert.equal(resolved.env.GOOGLE_API_KEY, "gemini-test-key");
assert.equal(resolved.env.GEMINI_API_KEY, "gemini-test-key");
assert.equal(resolved.env.APP_SHARED_TOKEN, "shared-local-secret");
assert.equal(resolved.env.APP_CLIPPER_TOKEN, undefined);
assert.deepEqual(resolved.injectedEnv, [
  "APP_SHARED_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENGROVE_APP_ID",
  "OPENGROVE_APP_ROOT",
  "OPENGROVE_APP_WORKSPACE_ROOT",
  "OPENGROVE_LOCALE",
  "OPENGROVE_WORKSPACE_PROVIDER",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
]);
assert.deepEqual(resolved.missing, [
  {
    providerId: "missing-provider",
    env: ["MISSING_PROVIDER_KEY"],
    required: true,
    reason: "provider-not-found",
  },
]);

const clipperResolved = resolveMountedAppRuntimeEnv(state, "env-app", "member-app-env-app-clipper");
assert.ok(clipperResolved);
assert.equal(clipperResolved.env.APP_SHARED_TOKEN, "shared-local-secret");
assert.equal(clipperResolved.env.APP_CLIPPER_TOKEN, "clipper-local-secret");
assert.equal(clipperResolved.env.APP_CLIPPER_TOKEN_ALIAS, undefined);
assert.equal(clipperResolved.env.APP_MATERIAL_TOKEN, undefined);
assert.ok(clipperResolved.injectedEnv.includes("APP_CLIPPER_TOKEN"));
assert.ok(
  clipperResolved.missing.some(
    (item) =>
      item.secretId === "clipper-missing-token" && item.reason === "secret-not-configured" && item.required === true,
  ),
);

const materialResolved = resolveMountedAppRuntimeEnv(state, "env-app", "member-app-env-app-material");
assert.ok(materialResolved);
assert.equal(materialResolved.env.APP_MATERIAL_TOKEN, "material-local-secret");
assert.equal(materialResolved.env.APP_CLIPPER_TOKEN, undefined);

const wwAuth = {
  baseUrl: "https://ww.example.test",
  accessToken: "access-test-token",
  userId: "user-test",
  email: "user@example.test",
};
const undeclaredWwResolved = resolveMountedAppRuntimeEnv(state, "env-app", undefined, wwAuth);
assert.ok(undeclaredWwResolved);
assert.equal(undeclaredWwResolved.env.OPENGROVE_WW_BASE_URL, undefined);
assert.equal(undeclaredWwResolved.env.OPENGROVE_WW_ACCESS_TOKEN, undefined);

writeFileSync(
  join(appRoot, "opengrove.app.json"),
  JSON.stringify(
    {
      id: "env-app",
      title: "Env App",
      runtimeEnv: {
        wwAuth: true,
        providerKeys: [
          {
            providerId: "aws-bedrock-api-key",
            env: { apiKey: "AWS_BEARER_TOKEN_BEDROCK" },
          },
        ],
      },
    },
    null,
    2,
  ),
  "utf8",
);
const declaredWwResolved = resolveMountedAppRuntimeEnv(state, "env-app", undefined, wwAuth);
assert.ok(declaredWwResolved);
assert.equal(declaredWwResolved.env.OPENGROVE_WW_BASE_URL, "https://ww.example.test");
assert.equal(declaredWwResolved.env.OPENGROVE_WW_ACCESS_TOKEN, "access-test-token");
assert.equal(declaredWwResolved.env.OPENGROVE_WW_USER_ID, "user-test");
assert.equal(declaredWwResolved.env.OPENGROVE_WW_USER_EMAIL, "user@example.test");
assert.ok(declaredWwResolved.injectedEnv.includes("OPENGROVE_WW_ACCESS_TOKEN"));

const inlineBedrockProviders = normalizeCustomProviderProfiles([
  {
    id: "aws-bedrock-api-key",
    name: "AWS Bedrock (API Key)",
    protocol: "anthropic-compatible",
    credentialKind: "api-key",
    apiKey: "AWS_BEARER_TOKEN_BEDROCK=ABSKinline-bedrock-test-key",
    models: [],
  },
]);
assert.equal(inlineBedrockProviders[0]?.apiKey, "ABSKinline-bedrock-test-key");

console.log("app-runtime-env harness passed");
