import { readAppEnv } from "../../identity.js";
import { resolveCommandPath } from "../../kernel/discovery.js";
import type {
  BridgeBrowserSttSettings,
  BridgeCloudSttProviderSettings,
  BridgeLocalWhisperSettings,
  BridgeSttProviderId,
  BridgeSttProviderInfo,
  BridgeVoiceSettings,
} from "../bridge-types.js";
import { BRIDGE_STT_PROVIDER_IDS } from "../bridge-types.js";

const DEFAULT_STT_PROVIDER: BridgeSttProviderId = "openai";

export function defaultBridgeVoiceSettings(): BridgeVoiceSettings {
  const language = readAppEnv("VOICE_STT_LANGUAGE")?.trim() || "auto";
  return {
    stt: {
      provider: normalizeSttProviderId(readAppEnv("VOICE_STT_PROVIDER"), DEFAULT_STT_PROVIDER),
      language,
      openai: {
        model: readAppEnv("VOICE_STT_OPENAI_MODEL")?.trim() || "gpt-4o-mini-transcribe",
        baseUrl: readAppEnv("VOICE_STT_OPENAI_BASE_URL")?.trim() || "https://api.openai.com/v1",
        apiKeyEnv: readAppEnv("VOICE_STT_OPENAI_API_KEY_ENV")?.trim() || "OPENAI_API_KEY",
      },
      groq: {
        model: readAppEnv("VOICE_STT_GROQ_MODEL")?.trim() || "whisper-large-v3-turbo",
        baseUrl: readAppEnv("VOICE_STT_GROQ_BASE_URL")?.trim() || "https://api.groq.com/openai/v1",
        apiKeyEnv: readAppEnv("VOICE_STT_GROQ_API_KEY_ENV")?.trim() || "GROQ_API_KEY",
      },
      localWhisper: {
        model: readAppEnv("VOICE_STT_LOCAL_MODEL")?.trim() || "base",
        command: readAppEnv("VOICE_STT_LOCAL_COMMAND")?.trim() || undefined,
        language,
      },
      browser: {
        language,
      },
    },
  };
}

export function normalizeBridgeVoiceSettings(
  input: unknown,
  fallback: BridgeVoiceSettings = defaultBridgeVoiceSettings(),
): BridgeVoiceSettings {
  const source = record(input);
  const sttSource = record(source.stt);
  const fallbackStt = fallback.stt;
  const language = stringValue(sttSource.language) || fallbackStt.language || "auto";

  return {
    stt: {
      provider: normalizeSttProviderId(sttSource.provider, fallbackStt.provider),
      language,
      openai: normalizeCloudSttProviderSettings(sttSource.openai, fallbackStt.openai),
      groq: normalizeCloudSttProviderSettings(sttSource.groq, fallbackStt.groq),
      localWhisper: normalizeLocalWhisperSettings(sttSource.localWhisper, {
        ...fallbackStt.localWhisper,
        language,
      }),
      browser: normalizeBrowserSttSettings(sttSource.browser, {
        ...fallbackStt.browser,
        language,
      }),
    },
  };
}

export function getBridgeSttProviderCatalog(settings: BridgeVoiceSettings): BridgeSttProviderInfo[] {
  const stt = settings.stt;
  return [
    {
      id: "openai",
      label: "OpenAI",
      mode: "recorded-upload",
      configured: Boolean(resolveCloudApiKey(stt.openai, "OPENAI_API_KEY")),
      defaultModel: stt.openai.model,
      notes: [stt.openai.apiKeyEnv || "OPENAI_API_KEY"],
    },
    {
      id: "groq",
      label: "Groq",
      mode: "recorded-upload",
      configured: Boolean(resolveCloudApiKey(stt.groq, "GROQ_API_KEY")),
      defaultModel: stt.groq.model,
      notes: [stt.groq.apiKeyEnv || "GROQ_API_KEY"],
    },
    {
      id: "local-whisper",
      label: "Local Whisper",
      mode: "local-command",
      configured: Boolean(stt.localWhisper.command?.trim() || resolveCommandPath("whisper")),
      defaultModel: stt.localWhisper.model,
      notes: stt.localWhisper.command ? ["custom command"] : ["whisper CLI"],
    },
    {
      id: "browser",
      label: "Browser",
      mode: "browser",
      configured: true,
      notes: ["Web Speech API"],
    },
  ];
}

export function resolveCloudApiKey(
  settings: BridgeCloudSttProviderSettings,
  fallbackEnvName: string,
): string | undefined {
  const direct = settings.apiKey?.trim();
  if (direct) return direct;
  const names = [settings.apiKeyEnv?.trim(), fallbackEnvName, `OPENGROVE_${fallbackEnvName}`].filter(
    (item): item is string => Boolean(item),
  );
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const appValue = readAppEnv(fallbackEnvName)?.trim();
  return appValue || undefined;
}

export function normalizeSttProviderId(
  value: unknown,
  fallback: BridgeSttProviderId = DEFAULT_STT_PROVIDER,
): BridgeSttProviderId {
  return typeof value === "string" && (BRIDGE_STT_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as BridgeSttProviderId)
    : fallback;
}

function normalizeCloudSttProviderSettings(
  input: unknown,
  fallback: BridgeCloudSttProviderSettings,
): BridgeCloudSttProviderSettings {
  const source = record(input);
  const apiKey = Object.prototype.hasOwnProperty.call(source, "apiKey")
    ? stringOrUndefined(source.apiKey)
    : fallback.apiKey;
  return {
    model: stringValue(source.model) || fallback.model,
    baseUrl: trimTrailingSlash(stringValue(source.baseUrl) || fallback.baseUrl),
    apiKey,
    apiKeyEnv: stringValue(source.apiKeyEnv) || fallback.apiKeyEnv,
  };
}

function normalizeLocalWhisperSettings(
  input: unknown,
  fallback: BridgeLocalWhisperSettings,
): BridgeLocalWhisperSettings {
  const source = record(input);
  return {
    model: stringValue(source.model) || fallback.model,
    command: Object.prototype.hasOwnProperty.call(source, "command")
      ? stringOrUndefined(source.command)
      : fallback.command,
    language: stringValue(source.language) || fallback.language || "auto",
  };
}

function normalizeBrowserSttSettings(input: unknown, fallback: BridgeBrowserSttSettings): BridgeBrowserSttSettings {
  const source = record(input);
  return {
    language: stringValue(source.language) || fallback.language || "auto",
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringOrUndefined(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized || undefined;
}
