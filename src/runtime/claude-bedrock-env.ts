import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readClaudeDesktopBedrockConfig } from "./claude-desktop-config.js";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const DEFAULT_BEDROCK_TOKEN_HELPER = join(homedir(), ".local", "bin", "aws-bedrock-token");
const DEFAULT_BEDROCK_PROXY_HOST = "127.0.0.1";
const DEFAULT_BEDROCK_PROXY_PORT = "7897";
const DEFAULT_BEDROCK_HTTP_PROXY = `http://${DEFAULT_BEDROCK_PROXY_HOST}:${DEFAULT_BEDROCK_PROXY_PORT}`;
const DEFAULT_BEDROCK_ALL_PROXY = `socks5://${DEFAULT_BEDROCK_PROXY_HOST}:${DEFAULT_BEDROCK_PROXY_PORT}`;

const CLAUDE_SETTINGS_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_REGION",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

const BEDROCK_ONLY_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

// Keep this aligned with the provider-routing variables understood by the
// bundled Claude Code. A host-managed binding must not retain a second
// provider inherited from the parent process or a per-turn app environment.
const CLAUDE_PROVIDER_ROUTING_ENV_KEYS = [
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_BASE_URL",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

export function isClaudeProviderManagedByHost(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST?.trim() === "1";
}

export function applyClaudeHostManagedProviderEnv(
  input: NodeJS.ProcessEnv,
  configuredProviderEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const env = { ...input };
  if (!isClaudeProviderManagedByHost(configuredProviderEnv)) return env;

  const inheritedHostAuthEnv = input.CLAUDE_CODE_HOST_AUTH_ENV_VAR?.trim();
  if (inheritedHostAuthEnv && /^[A-Za-z_][A-Za-z0-9_]*$/.test(inheritedHostAuthEnv)) {
    delete env[inheritedHostAuthEnv];
  }
  for (const key of CLAUDE_PROVIDER_ROUTING_ENV_KEYS) {
    delete env[key];
  }
  for (const key of CLAUDE_PROVIDER_ROUTING_ENV_KEYS) {
    const value = configuredProviderEnv?.[key];
    if (value !== undefined) env[key] = value;
  }
  if (configuredProviderEnv?.AWS_REGION !== undefined) {
    env.AWS_REGION = configuredProviderEnv.AWS_REGION;
  }
  const configuredHostAuthEnv = configuredProviderEnv?.CLAUDE_CODE_HOST_AUTH_ENV_VAR?.trim();
  if (configuredHostAuthEnv && /^[A-Za-z_][A-Za-z0-9_]*$/.test(configuredHostAuthEnv)) {
    const value = configuredProviderEnv?.[configuredHostAuthEnv];
    if (value !== undefined) env[configuredHostAuthEnv] = value;
  }
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  return env;
}

export function applyClaudeBedrockHelperEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...input };
  if (env.ANTHROPIC_BASE_URL?.trim()) {
    clearBedrockOnlyEnv(env);
    return env;
  }
  const inheritNativeProviderConfig = !isClaudeProviderManagedByHost(env);
  const settingsEnv = inheritNativeProviderConfig ? readClaudeSettingsEnv() : {};
  const desktopBedrock = inheritNativeProviderConfig ? readClaudeDesktopBedrockConfig() : undefined;
  for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
    if (!env[key] && settingsEnv[key]) env[key] = settingsEnv[key];
  }
  if (desktopBedrock) {
    if (!env.CLAUDE_CODE_USE_BEDROCK) env.CLAUDE_CODE_USE_BEDROCK = "1";
    if (!env.AWS_REGION && desktopBedrock.region) env.AWS_REGION = desktopBedrock.region;
  }
  if (isBedrockEnabled(env) && env.AWS_REGION && !env.ANTHROPIC_BEDROCK_BASE_URL) {
    env.ANTHROPIC_BEDROCK_BASE_URL = `https://bedrock-runtime.${env.AWS_REGION}.amazonaws.com`;
  }
  if (!isBedrockEnabled(env)) return env;

  applyClaudeBedrockProxyEnv(env);
  if (hasAwsCredential(env)) return env;

  const helper =
    env.OPENGROVE_CLAUDE_BEDROCK_TOKEN_HELPER?.trim() ||
    desktopBedrock?.credentialHelper ||
    DEFAULT_BEDROCK_TOKEN_HELPER;
  if (!existsSync(helper)) return env;
  try {
    const token = execFileSync(helper, {
      encoding: "utf8",
      env,
      timeout: 60_000,
      maxBuffer: 8 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) env.AWS_BEARER_TOKEN_BEDROCK = token;
  } catch {
    return env;
  }
  return env;
}

function clearBedrockOnlyEnv(env: NodeJS.ProcessEnv): void {
  for (const key of BEDROCK_ONLY_ENV_KEYS) {
    delete env[key];
  }
}

function applyClaudeBedrockProxyEnv(env: NodeJS.ProcessEnv): void {
  const explicitProxy = env.OPENGROVE_CLAUDE_BEDROCK_PROXY_URL?.trim();
  if (explicitProxy) {
    applyProxyEnv(env, explicitProxy);
    return;
  }
  if (hasProxyEnv(env) || !isLocalProxyListening()) {
    return;
  }
  applyProxyEnv(env, DEFAULT_BEDROCK_HTTP_PROXY);
  if (!env.ALL_PROXY && !env.all_proxy) {
    env.ALL_PROXY = DEFAULT_BEDROCK_ALL_PROXY;
  }
}

function applyProxyEnv(env: NodeJS.ProcessEnv, proxyUrl: string): void {
  if (!env.HTTPS_PROXY && !env.https_proxy) env.HTTPS_PROXY = proxyUrl;
  if (!env.HTTP_PROXY && !env.http_proxy) env.HTTP_PROXY = proxyUrl;
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.HTTPS_PROXY?.trim() ||
      env.https_proxy?.trim() ||
      env.HTTP_PROXY?.trim() ||
      env.http_proxy?.trim() ||
      env.ALL_PROXY?.trim() ||
      env.all_proxy?.trim(),
  );
}

function isLocalProxyListening(): boolean {
  try {
    execFileSync("/usr/bin/nc", ["-z", DEFAULT_BEDROCK_PROXY_HOST, DEFAULT_BEDROCK_PROXY_PORT], {
      timeout: 1_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isBedrockEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.CLAUDE_CODE_USE_BEDROCK?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function hasAwsCredential(env: NodeJS.ProcessEnv): boolean {
  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim() || (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim())) {
    return true;
  }
  const profile = env.AWS_PROFILE?.trim();
  if (profile && awsProfileExists(env, profile)) return true;
  const webIdentityTokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim();
  return Boolean(
    webIdentityTokenFile && env.AWS_ROLE_ARN?.trim() && existsSync(resolveAwsPath(webIdentityTokenFile, env)),
  );
}

function awsProfileExists(env: NodeJS.ProcessEnv, profile: string): boolean {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const credentialsPath = resolveAwsPath(
    env.AWS_SHARED_CREDENTIALS_FILE?.trim() || join(home, ".aws", "credentials"),
    env,
  );
  const configPath = resolveAwsPath(env.AWS_CONFIG_FILE?.trim() || join(home, ".aws", "config"), env);
  return (
    iniSectionHasCredentialRoute(readIniSection(credentialsPath, profile), env) ||
    iniSectionHasCredentialRoute(
      readIniSection(configPath, profile === "default" ? "default" : `profile ${profile}`),
      env,
    )
  );
}

function readIniSection(path: string, section: string): Record<string, string> {
  try {
    const normalized = section.trim().toLowerCase();
    const output: Record<string, string> = {};
    let active = false;
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        active = sectionMatch[1]?.trim().toLowerCase() === normalized;
        continue;
      }
      if (!active || !line || line.startsWith("#") || line.startsWith(";")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      output[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    return output;
  } catch {
    return {};
  }
}

function iniSectionHasCredentialRoute(section: Record<string, string>, env: NodeJS.ProcessEnv): boolean {
  if (section.aws_access_key_id && section.aws_secret_access_key) return true;
  if (section.credential_process) return true;
  if (section.sso_account_id && section.sso_role_name && (section.sso_session || section.sso_start_url)) return true;
  if (section.role_arn && (section.source_profile || section.credential_source)) return true;
  return Boolean(
    section.role_arn &&
      section.web_identity_token_file &&
      existsSync(resolveAwsPath(section.web_identity_token_file, env)),
  );
}

function resolveAwsPath(path: string, env: NodeJS.ProcessEnv): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
    return join(home, path.slice(2));
  }
  return path;
}

function readClaudeSettingsEnv(): NodeJS.ProcessEnv {
  try {
    const parsed = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const rawEnv = (parsed as { env?: unknown }).env;
    if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) return {};
    const output: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value === "string" && value.trim()) output[key] = value.trim();
    }
    return output;
  } catch {
    return {};
  }
}
