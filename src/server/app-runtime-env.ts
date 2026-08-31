import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../core.js";
import { hostCommandSearchPath } from "../environment/command-path.js";
import { mountedAppMemberId } from "../rooms/room-pm.js";
import type { BridgeProviderProfile, BridgeState } from "./bridge-types.js";
import { getBridgeTurnContext } from "./bridge-turn-context.js";
import { getAllBridgeProviderProfiles, resolveProviderApiKey } from "./provider-profiles.js";
import { providerRuntimeState } from "./provider-state.js";
import { resolveMountedAppTarget } from "./mounted-apps.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { newProjectArtifactLocale } from "../localization/language-contracts.js";
import type { BridgeWwRuntimeAuth } from "./ww-runtime-auth.js";

export interface AppRuntimeEnvResolution {
  appId: string;
  env: NodeJS.ProcessEnv;
  injectedEnv: string[];
  missing: AppRuntimeEnvMissing[];
}

export interface AppRuntimeEnvMissing {
  providerId?: string;
  secretId?: string;
  env: string[];
  required: boolean;
  reason:
    | "provider-not-found"
    | "provider-disabled"
    | "key-not-configured"
    | "env-not-declared"
    | "secret-not-configured"
    | "secret-env-not-declared";
}

interface ProviderEnvDeclaration {
  providerId: string;
  envNames: string[];
  required: boolean;
}

interface SecretEnvDeclaration {
  id: string;
  envNames: string[];
  aliases: string[];
  employees: string[];
  required: boolean;
}

export function resolveMountedAppRuntimeEnv(
  state: BridgeState,
  appId: string | undefined,
  memberId?: string,
  wwAuth = getBridgeTurnContext()?.wwAuth,
): AppRuntimeEnvResolution | undefined {
  const requestedAppId = appId?.trim();
  if (!requestedAppId) return undefined;
  const target = resolveMountedAppTarget(state, requestedAppId);
  if (!target) return undefined;
  const appTempDir = join(target.workspaceRoot, "runs", ".tmp");
  try {
    mkdirSync(appTempDir, { recursive: true });
  } catch {
    // Best effort: still inject the path so downstream runtime errors stay attributable.
  }
  const declarations = readProviderEnvDeclarations(target.manifest);
  const secretDeclarations = readSecretEnvDeclarations(target.appRoot, target.manifest).filter((declaration) =>
    secretDeclarationAppliesToMember(declaration, target.id, memberId),
  );
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: hostCommandSearchPath(),
    OPENGROVE_APP_ID: target.id,
    OPENGROVE_APP_ROOT: target.appRoot,
    OPENGROVE_APP_WORKSPACE_ROOT: target.workspaceRoot,
    OPENGROVE_WORKSPACE_PROVIDER: target.workspace.kind,
    OPENGROVE_LOCALE: newProjectArtifactLocale(resolveHostLanguageSettings(state.settings)).locale,
    TMPDIR: appTempDir,
    TMP: appTempDir,
    TEMP: appTempDir,
    ...wwRuntimeAuthEnv(target.manifest, wwAuth),
  };
  if (declarations.length === 0 && secretDeclarations.length === 0) {
    return {
      appId: target.id,
      env: baseEnv,
      injectedEnv: Object.keys(baseEnv).sort(),
      missing: [],
    };
  }

  const providers = getAllBridgeProviderProfiles(state.settings.customProviders);
  const localSecrets = readLocalSecretEnv(target.appRoot, target.id);
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const injectedEnv: string[] = Object.keys(baseEnv);
  const missing: AppRuntimeEnvMissing[] = [];

  for (const declaration of declarations) {
    if (declaration.envNames.length === 0) {
      missing.push({
        providerId: declaration.providerId,
        env: [],
        required: declaration.required,
        reason: "env-not-declared",
      });
      continue;
    }
    const provider = providers.find((profile) => profile.id === declaration.providerId);
    if (!provider) {
      missing.push({
        providerId: declaration.providerId,
        env: declaration.envNames,
        required: declaration.required,
        reason: "provider-not-found",
      });
      continue;
    }
    if (!providerRuntimeState(provider).active) {
      missing.push({
        providerId: declaration.providerId,
        env: declaration.envNames,
        required: declaration.required,
        reason: "provider-disabled",
      });
      continue;
    }
    const apiKey = resolveAppProviderApiKey(provider);
    if (!apiKey) {
      missing.push({
        providerId: declaration.providerId,
        env: declaration.envNames,
        required: declaration.required,
        reason: "key-not-configured",
      });
      continue;
    }
    for (const envName of declaration.envNames) {
      env[envName] = apiKey;
      injectedEnv.push(envName);
    }
  }

  for (const declaration of secretDeclarations) {
    if (declaration.envNames.length === 0) {
      missing.push({
        secretId: declaration.id,
        env: [],
        required: declaration.required,
        reason: "secret-env-not-declared",
      });
      continue;
    }
    for (const envName of declaration.envNames) {
      const value = resolveSecretValue(envName, declaration.aliases, localSecrets);
      if (value) {
        env[envName] = value;
        injectedEnv.push(envName);
        continue;
      }
      missing.push({
        secretId: declaration.id,
        env: [envName],
        required: declaration.required,
        reason: "secret-not-configured",
      });
    }
  }

  return {
    appId: target.id,
    env,
    injectedEnv: [...new Set(injectedEnv)].sort(),
    missing,
  };
}

function wwRuntimeAuthEnv(manifest: JsonObject, auth: BridgeWwRuntimeAuth | undefined): NodeJS.ProcessEnv {
  if (!auth || !manifestDeclaresWwAuth(manifest)) return {};
  return {
    OPENGROVE_WW_BASE_URL: auth.baseUrl,
    OPENGROVE_WW_ACCESS_TOKEN: auth.accessToken,
    OPENGROVE_WW_USER_ID: auth.userId,
    ...(auth.email ? { OPENGROVE_WW_USER_EMAIL: auth.email } : {}),
  };
}

function manifestDeclaresWwAuth(manifest: JsonObject): boolean {
  const runtimeEnv = recordValue(manifest.runtimeEnv);
  const capabilities = recordValue(manifest.capabilities);
  return runtimeEnv.wwAuth === true || capabilities.wwAuth === true;
}

function readProviderEnvDeclarations(manifest: JsonObject): ProviderEnvDeclaration[] {
  const runtimeEnv = recordValue(manifest.runtimeEnv);
  const legacyEnv = recordValue(manifest.env);
  return [
    ...providerEnvArray(runtimeEnv.providerKeys),
    ...providerEnvArray(runtimeEnv.providers),
    ...providerEnvArray(legacyEnv.providerKeys),
    ...providerEnvArray(legacyEnv.providers),
  ];
}

function readSecretEnvDeclarations(appRoot: string, manifest: JsonObject): SecretEnvDeclaration[] {
  const runtimeEnv = recordValue(manifest.runtimeEnv);
  const legacyEnv = recordValue(manifest.env);
  const schema = readSecretsSchema(appRoot);
  return [
    ...secretEnvArray(schema.secrets),
    ...secretEnvArray(schema.secretKeys),
    ...secretEnvArray(runtimeEnv.secrets),
    ...secretEnvArray(runtimeEnv.secretKeys),
    ...secretEnvArray(legacyEnv.secrets),
    ...secretEnvArray(legacyEnv.secretKeys),
    ...employeeSecretDeclarations(manifest),
  ];
}

function readSecretsSchema(appRoot: string): Record<string, unknown> {
  for (const fileName of ["secrets.schema.json"]) {
    const path = join(appRoot, fileName);
    if (!existsSync(path)) continue;
    try {
      return recordValue(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return {};
    }
  }
  return {};
}

function secretEnvArray(value: unknown, inheritedEmployees: string[] = []): SecretEnvDeclaration[] {
  return Array.isArray(value)
    ? value
        .map((item) => secretEnvDeclaration(item, inheritedEmployees))
        .filter((item): item is SecretEnvDeclaration => Boolean(item))
    : [];
}

function secretEnvDeclaration(value: unknown, inheritedEmployees: string[] = []): SecretEnvDeclaration | undefined {
  if (typeof value === "string") {
    const envNames = normalizeEnvNames([value]);
    if (envNames.length === 0) return undefined;
    return {
      id: envNames[0] ?? value,
      envNames,
      aliases: [],
      employees: uniqueStrings(inheritedEmployees),
      required: false,
    };
  }
  const object = recordValue(value);
  const envNames = envNameList(object.env ?? object.envKey ?? object.envKeys);
  const id = stringValue(object.id) || stringValue(object.name) || stringValue(object.title) || envNames[0] || "";
  if (!id) return undefined;
  return {
    id,
    envNames,
    aliases: normalizeEnvNames([
      ...rawEnvNames(object.alias),
      ...rawEnvNames(object.aliases),
      ...rawEnvNames(object.sourceEnv),
      ...rawEnvNames(object.sourceEnvKeys),
    ]),
    employees: uniqueStrings([
      ...inheritedEmployees,
      ...rawStringArray(object.employees),
      ...rawStringArray(object.agents),
      ...rawStringArray(object.employeeIds),
      ...rawStringArray(object.scopes),
    ]),
    required: object.required === true,
  };
}

function employeeSecretDeclarations(manifest: JsonObject): SecretEnvDeclaration[] {
  const declarations: SecretEnvDeclaration[] = [];
  for (const employee of manifestEmployeeInputs(manifest)) {
    const employeeScopes = uniqueStrings(
      [stringValue(employee.id), stringValue(employee.name), stringValue(employee.title)].filter(Boolean),
    );
    declarations.push(...secretEnvArray(employee.secrets, employeeScopes));
    declarations.push(...secretEnvArray(employee.secretKeys, employeeScopes));
  }
  return declarations;
}

function manifestEmployeeInputs(manifest: JsonObject): Record<string, unknown>[] {
  return [
    ...recordArray(recordValue(manifest).employees),
    ...recordArray(recordValue(manifest).agents),
    ...recordArray(recordValue(recordValue(manifest).rooms).employees),
    ...recordArray(recordValue(recordValue(manifest).rooms).agents),
    ...recordArray(recordValue(recordValue(manifest).capabilities).employees),
    ...recordArray(recordValue(recordValue(manifest).capabilities).agents),
    ...recordArray(recordValue(recordValue(manifest).agentPack).employees),
    ...recordArray(recordValue(recordValue(manifest).agentPack).agents),
  ];
}

function providerEnvArray(value: unknown): ProviderEnvDeclaration[] {
  return Array.isArray(value)
    ? value.map(providerEnvDeclaration).filter((item): item is ProviderEnvDeclaration => Boolean(item))
    : [];
}

function providerEnvDeclaration(value: unknown): ProviderEnvDeclaration | undefined {
  const object = recordValue(value);
  const providerId = stringValue(object.providerId) || stringValue(object.id);
  if (!providerId) return undefined;
  return {
    providerId,
    envNames: envNameList(object.env ?? object.apiKeyEnv ?? object.apiKeyEnvs),
    required: object.required === true,
  };
}

function envNameList(value: unknown): string[] {
  if (typeof value === "string") {
    return normalizeEnvNames([value]);
  }
  if (Array.isArray(value)) {
    return normalizeEnvNames(value);
  }
  const object = recordValue(value);
  return normalizeEnvNames([
    ...rawEnvNames(object.apiKey),
    ...rawEnvNames(object.apiKeyEnv),
    ...rawEnvNames(object.apiKeyEnvs),
  ]);
}

function rawEnvNames(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function readLocalSecretEnv(appRoot: string, appId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const path of localSecretEnvCandidates(appRoot, appId)) {
    if (!existsSync(path)) continue;
    Object.assign(env, parseEnvFile(readFileSync(path, "utf8")));
  }
  return env;
}

function localSecretEnvCandidates(appRoot: string, appId: string): string[] {
  const appEnvSuffix = envVarSuffix(appId);
  const explicitAppFile = process.env[`OPENGROVE_APP_SECRETS_FILE_${appEnvSuffix}`]?.trim();
  const explicitFile = process.env.OPENGROVE_APP_SECRETS_FILE?.trim();
  const explicitDir = process.env.OPENGROVE_APP_SECRETS_DIR?.trim();
  return uniqueStrings(
    [
      explicitAppFile,
      explicitFile,
      explicitDir ? join(explicitDir, `${appId}.env`) : "",
      join(homedir(), ".opengrove", "secrets", `${appId}.env`),
      join(appRoot, ".env.local"),
    ].filter((value): value is string => Boolean(value)),
  );
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!isEnvironmentVariableName(key)) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveSecretValue(
  envName: string,
  aliases: string[],
  localSecrets: Record<string, string>,
): string | undefined {
  for (const candidate of [envName, ...aliases]) {
    const processValue = process.env[candidate]?.trim();
    if (processValue) return processValue;
    const localValue = localSecrets[candidate]?.trim();
    if (localValue) return localValue;
  }
  return undefined;
}

function secretDeclarationAppliesToMember(
  declaration: SecretEnvDeclaration,
  appId: string,
  memberId: string | undefined,
): boolean {
  if (declaration.employees.length === 0) return true;
  if (!memberId) return false;
  return declaration.employees.some((employee) => {
    return memberId === employee || memberId === mountedAppMemberId(appId, employee);
  });
}

function normalizeEnvNames(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(isEnvironmentVariableName),
    ),
  ];
}

function resolveAppProviderApiKey(profile: BridgeProviderProfile): string | undefined {
  if (profile.id === "aws-bedrock-api-key") {
    const configured = resolveProviderApiKey(profile);
    return configured?.startsWith("ABSK") ? configured : providerAliasApiKey(profile.id);
  }
  return resolveProviderApiKey(profile) || providerAliasApiKey(profile.id);
}

function providerAliasApiKey(providerId: string): string | undefined {
  if (providerId === "gemini") {
    return process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || undefined;
  }
  if (providerId === "aws-bedrock-api-key") {
    return process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() || undefined;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function rawStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((item) => Object.keys(item).length > 0) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function envVarSuffix(value: string): string {
  return (
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "APP"
  );
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
