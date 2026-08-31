import type {
  BridgeSettings,
  KernelOption,
  KernelProxySettings,
  MountedAppSettings,
  ProviderProfile,
  VoiceSttProviderId,
} from "../../bridge";
import { LOGIN_PROVIDER_BINDING_ID } from "../../bridge";
import type { TranslationFn } from "../../i18n";
import { modelOfferingKey } from "../../runtime/kernel-models";

export type ProviderFormState = {
  id: string;
  name: string;
  protocol: string;
  description: string;
  descriptionCode?: ProviderProfile["descriptionCode"];
  descriptionEdited: boolean;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  geminiBaseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  models: string;
  modelsPinned: boolean;
};

export const PROVIDER_PROTOCOL_OPTIONS = [
  { id: "openai-compatible", label: "OpenAI" },
  { id: "anthropic-compatible", label: "Anthropic" },
  { id: "gemini-compatible", label: "Gemini" },
];

const KERNEL_PRODUCT_NAMES: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Agent",
  hermes: "Hermes",
  pi: "Pi",
  openclaw: "OpenClaw",
  opencode: "OpenCode",
  kimi: "Kimi Code",
};

export function emptyProviderForm(): ProviderFormState {
  return {
    id: "",
    name: "",
    protocol: "openai-compatible",
    description: "",
    descriptionEdited: false,
    openaiBaseUrl: "",
    anthropicBaseUrl: "",
    geminiBaseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    models: "",
    modelsPinned: false,
  };
}

export function updateProviderForm<K extends keyof ProviderFormState>(
  state: ProviderFormState,
  key: K,
  value: ProviderFormState[K],
): ProviderFormState {
  const next = { ...state, [key]: value };
  if (key === "models" && value !== state.models) {
    next.modelsPinned = Boolean(
      String(value)
        .split(",")
        .some((item) => item.trim()),
    );
  }
  if (key === "description" && value !== state.description) {
    next.descriptionEdited = true;
  }
  if (key === "name" && !state.id.trim()) {
    next.id = slug(String(value));
  }
  return next;
}

export function providerProfileFromForm(form: ProviderFormState): ProviderProfile | undefined {
  const id = slug(form.id || form.name);
  const name = form.name.trim();
  if (!id || !name) return undefined;
  const loginProtocol = isLoginProtocol(form.protocol);
  const apiKey = normalizeProviderApiKey(form.apiKey);
  const apiKeyEnv = form.apiKeyEnv.trim();
  const models = form.models
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
  const modelsPinned = form.modelsPinned && models.length > 0;
  return {
    id,
    name,
    custom: true,
    enabled: true,
    origin: "user",
    routeKind: "provider",
    protocol: form.protocol,
    descriptionCode: form.descriptionCode && !form.descriptionEdited ? form.descriptionCode : undefined,
    description: form.descriptionCode && !form.descriptionEdited ? undefined : form.description.trim() || undefined,
    openaiBaseUrl: loginProtocol ? undefined : form.openaiBaseUrl.trim() || undefined,
    anthropicBaseUrl: loginProtocol ? undefined : form.anthropicBaseUrl.trim() || undefined,
    geminiBaseUrl: loginProtocol ? undefined : form.geminiBaseUrl.trim() || undefined,
    apiKey: loginProtocol ? undefined : apiKey || undefined,
    apiKeyEnv: loginProtocol ? undefined : apiKeyEnv || undefined,
    credentialKind: providerCredentialKindFromForm(id, apiKey, apiKeyEnv),
    modelsPinned,
    models: modelsPinned ? models : [],
  };
}

export function mergeProviderProfileWithExisting(
  profile: ProviderProfile,
  existing: ProviderProfile | undefined,
): ProviderProfile {
  const merged: ProviderProfile = {
    ...profile,
    enabled: existing?.enabled ?? profile.enabled,
  };
  if (!existing || (!existing.sourceKernel && existing.origin !== "discovered")) {
    return merged;
  }
  return {
    ...merged,
    origin: existing.origin,
    sourceKernel: existing.sourceKernel,
    source: existing.source,
    sourcePaths: existing.sourcePaths,
    routeKind: existing.routeKind ?? merged.routeKind,
    credentialKind: existing.credentialKind ?? merged.credentialKind,
    provisioningBlocked: existing.provisioningBlocked,
  };
}

export function providerFormFromProfile(provider: ProviderProfile, t?: TranslationFn): ProviderFormState {
  return {
    id: provider.id,
    name: provider.name,
    protocol: editableProviderProtocol(provider),
    description: localizedProviderDescription(provider, t),
    descriptionCode: provider.descriptionCode,
    descriptionEdited: false,
    openaiBaseUrl: provider.openaiBaseUrl || "",
    anthropicBaseUrl: provider.anthropicBaseUrl || "",
    geminiBaseUrl: provider.geminiBaseUrl || "",
    apiKey: provider.apiKey || "",
    apiKeyEnv: provider.apiKeyEnv || "",
    models: (provider.models ?? []).map((model) => model.id).join(", "),
    modelsPinned: providerModelsArePinned(provider),
  };
}

export function customProvidersAfterDelete(
  customProviders: ProviderProfile[],
  provider: ProviderProfile | undefined,
): ProviderProfile[] {
  if (!provider) return customProviders;
  const existing = customProviders.find((item) => item.id === provider.id);
  const next = customProviders.filter((item) => item.id !== provider.id);
  if (!provider.custom || provider.origin === "discovered") {
    next.push({
      ...(existing ? providerSettingsOnly(existing) : providerPreferenceShell(provider)),
      custom: true,
      deleted: true,
    });
  }
  return next;
}

export function customProvidersAfterEnabledChange(
  customProviders: ProviderProfile[],
  provider: ProviderProfile,
  enabled: boolean,
): ProviderProfile[] {
  const existing = customProviders.find((item) => item.id === provider.id);
  const nextProvider: ProviderProfile = {
    ...(existing ? providerSettingsOnly(existing) : providerPreferenceShell(provider)),
    custom: true,
    deleted: false,
    enabled,
  };
  return [...customProviders.filter((item) => item.id !== provider.id), nextProvider];
}

function providerSettingsOnly(provider: ProviderProfile): ProviderProfile {
  const { runtime: _runtime, authConfigured: _legacyRuntimeValue, ...settings } = provider;
  return settings;
}

function providerPreferenceShell(provider: ProviderProfile): ProviderProfile {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    custom: true,
    origin: provider.origin,
    sourceKernel: provider.sourceKernel,
    source: provider.source,
    sourcePaths: provider.sourcePaths,
    routeKind: provider.routeKind,
    credentialKind: provider.credentialKind,
    models: [],
  };
}

function localizedProviderDescription(provider: ProviderProfile, t: TranslationFn | undefined): string {
  if (!t || !provider.descriptionCode) return provider.description || "";
  switch (provider.descriptionCode) {
    case "openai":
      return t("settings.providerDescriptionOpenAI");
    case "anthropic":
      return t("settings.providerDescriptionAnthropic");
    case "bedrock":
      return t("settings.providerDescriptionBedrock");
    case "vertex":
      return t("settings.providerDescriptionVertex");
    case "gemini":
      return t("settings.providerDescriptionGemini");
    case "compatible":
      return t("settings.providerDescriptionCompatible", { name: provider.name });
  }
}

export function providerModelsArePinned(provider: ProviderProfile): boolean {
  if (typeof provider.modelsPinned === "boolean") return provider.modelsPinned;
  return provider.custom === true && Boolean(provider.models?.length);
}

export function primaryBaseUrl(form: ProviderFormState): string {
  if (form.protocol === "anthropic-compatible") return form.anthropicBaseUrl;
  if (form.protocol === "gemini-compatible") return form.geminiBaseUrl;
  return form.openaiBaseUrl;
}

export function sortAvailableKernelsFirst(options: KernelOption[]): KernelOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      if (left.option.available !== right.option.available) {
        return left.option.available ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ option }) => option);
}

export function sortEnabledProvidersFirst(providers: ProviderProfile[]): ProviderProfile[] {
  return providers
    .map((provider, index) => ({
      provider,
      index,
      enabled: isProviderEnabled(provider),
    }))
    .sort((left, right) => {
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ provider }) => provider);
}

export function emptyKernelProxySettings(): KernelProxySettings {
  return {
    enabled: false,
    injected: false,
    proxyUrl: "http://127.0.0.1:7890",
    noProxy: "127.0.0.1,localhost,::1",
    nodeUseEnvProxy: false,
    environmentProxyUrl: "",
    source: "none",
  };
}

export function normalizeKernelProxySettings(input: Partial<KernelProxySettings> | undefined): KernelProxySettings {
  const defaults = emptyKernelProxySettings();
  return {
    ...defaults,
    ...input,
    enabled: Boolean(input?.enabled),
    proxyUrl: input?.proxyUrl?.trim() || defaults.proxyUrl,
    noProxy: input?.noProxy?.trim() || defaults.noProxy,
    nodeUseEnvProxy: Boolean(input?.nodeUseEnvProxy),
  };
}

export function emptyVoiceSettings(): NonNullable<BridgeSettings["voice"]> {
  return {
    stt: {
      provider: "openai",
      language: "auto",
      openai: {
        model: "gpt-4o-mini-transcribe",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      groq: {
        model: "whisper-large-v3-turbo",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKeyEnv: "GROQ_API_KEY",
      },
      localWhisper: {
        model: "base",
        command: "",
        language: "auto",
      },
      browser: {
        language: "auto",
      },
    },
    sttProviders: [
      {
        id: "openai",
        label: "OpenAI",
        mode: "recorded-upload",
        configured: false,
        defaultModel: "gpt-4o-mini-transcribe",
      },
      { id: "groq", label: "Groq", mode: "recorded-upload", configured: false, defaultModel: "whisper-large-v3-turbo" },
      { id: "local-whisper", label: "Local Whisper", mode: "local-command", configured: false, defaultModel: "base" },
      { id: "browser", label: "Browser", mode: "browser", configured: true },
    ],
  };
}

export function normalizeVoiceSettings(
  input: Partial<NonNullable<BridgeSettings["voice"]>> | undefined,
): NonNullable<BridgeSettings["voice"]> {
  const defaults = emptyVoiceSettings();
  const stt = input?.stt ?? defaults.stt;
  const provider = normalizeVoiceProviderId(stt.provider, defaults.stt.provider);
  const language = stt.language?.trim() || defaults.stt.language;
  return {
    ...defaults,
    ...input,
    stt: {
      provider,
      language,
      openai: {
        ...defaults.stt.openai,
        ...stt.openai,
        model: stt.openai?.model?.trim() || defaults.stt.openai.model,
        baseUrl: stt.openai?.baseUrl?.trim() || defaults.stt.openai.baseUrl,
        apiKeyEnv: stt.openai?.apiKeyEnv?.trim() || defaults.stt.openai.apiKeyEnv,
      },
      groq: {
        ...defaults.stt.groq,
        ...stt.groq,
        model: stt.groq?.model?.trim() || defaults.stt.groq.model,
        baseUrl: stt.groq?.baseUrl?.trim() || defaults.stt.groq.baseUrl,
        apiKeyEnv: stt.groq?.apiKeyEnv?.trim() || defaults.stt.groq.apiKeyEnv,
      },
      localWhisper: {
        ...defaults.stt.localWhisper,
        ...stt.localWhisper,
        model: stt.localWhisper?.model?.trim() || defaults.stt.localWhisper.model,
        command: stt.localWhisper?.command?.trim() || "",
        language,
      },
      browser: {
        ...defaults.stt.browser,
        ...stt.browser,
        language,
      },
    },
    sttProviders: input?.sttProviders?.length ? input.sttProviders : defaults.sttProviders,
  };
}

export function defaultVoiceProviderOptions(): Array<{ id: string; label: string }> {
  return emptyVoiceSettings().sttProviders?.map((provider) => ({ id: provider.id, label: provider.label })) ?? [];
}

export function effectiveProxyValue(proxy: KernelProxySettings, t: TranslationFn): string {
  if (proxy.enabled) return proxy.proxyUrl || t("settings.proxySourceNone");
  return proxy.environmentProxyUrl || t("settings.proxySourceNone");
}

export function effectiveProxyDescription(proxy: KernelProxySettings, t: TranslationFn): string {
  if (proxy.enabled) return t("settings.effectiveProxyOpenGrove");
  if (proxy.environmentProxyUrl) return t("settings.effectiveProxyEnvironment");
  return t("settings.effectiveProxyNone");
}

export function nextModelProviderBindings(
  bindings: import("../../bridge").ModelProviderBinding[],
  modelId: string,
  providerId: string,
  providers: ProviderProfile[] = [],
): import("../../bridge").ModelProviderBinding[] {
  const next = bindings.filter(
    (binding) => !modelIdsEquivalent(binding.modelId, modelId, providers, binding.providerId),
  );
  return providerId ? [...next, { modelId, providerId }] : next;
}

export function providerSupportsKernel(provider: ProviderProfile, kernelId: string): boolean {
  return Boolean(providerProtocolForKernel(provider, kernelId));
}

export function providerRouteIdForKernel(provider: ProviderProfile, kernelId: string): string {
  if (isLoginStateProvider(provider) && provider.sourceKernel === kernelId) {
    return LOGIN_PROVIDER_BINDING_ID;
  }
  return provider.id;
}

export function providerRouteIdForStoredBinding(
  providerId: string | undefined,
  providers: ProviderProfile[],
): string | undefined {
  if (!providerId) return undefined;
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider?.sourceKernel ? providerRouteIdForKernel(provider, provider.sourceKernel) : providerId;
}

export function providerBindingLabel(provider: ProviderProfile, kernelId: string, t: TranslationFn): string {
  const protocol = providerProtocolForKernel(provider, kernelId);
  const protocolLabel = isAwsBedrockProvider(provider)
    ? "AWS Bedrock"
    : isWwProvider(provider)
      ? "Gateway"
      : isGoogleVertexProviderId(provider.id)
        ? "Google Vertex"
        : protocol === "native-oauth"
          ? t("settings.accountLogin")
          : protocol === "anthropic-compatible"
            ? "Anthropic"
            : protocol === "gemini-compatible"
              ? "Gemini"
              : "OpenAI";
  return `${provider.name} · ${protocolLabel}`;
}

export function providerMetaLabel(provider: ProviderProfile, t: TranslationFn): string {
  if (isLoginStateProvider(provider)) return t("settings.accountLogin");
  if (isLoginProtocol(provider.protocol)) return t("settings.accountLogin");
  if (provider.apiKey) return t("settings.apiKeyConfigured");
  if (provider.apiKeyEnv) return provider.apiKeyEnv;
  if (provider.credentialKind === "gateway-managed") return t("settings.gatewayManagedProvider");
  if (provider.origin === "discovered" || provider.sourceKernel) {
    return t("settings.kernelManagedProvider", {
      kernel: KERNEL_PRODUCT_NAMES[provider.sourceKernel || ""] || provider.sourceKernel || provider.name,
    });
  }
  return provider.apiKeyEnv || provider.protocol;
}

export function formatModelCount(count: number, t: TranslationFn): string {
  return t("settings.modelsCount", { count });
}

export function mountedAppId(path: string, title: string, existing: MountedAppSettings[]): string {
  const raw = title || path.split(/[\\/]/).filter(Boolean).pop() || "app";
  const base = slug(raw) || "app";
  const taken = new Set(existing.map((item) => item.id));
  let candidate = base;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function formatKernelLabel(value: string | undefined, t: TranslationFn): string {
  const productName = KERNEL_PRODUCT_NAMES[value || ""];
  return productName ? t("workspace.namedKernel", { name: productName }) : "";
}

function normalizeProviderApiKey(value: string): string {
  const trimmed = value.trim();
  const assignment = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  return stripShellValue(assignment?.[1] ?? trimmed);
}

function stripShellValue(value: string): string {
  let next = value.trim();
  if (next.endsWith(";")) next = next.slice(0, -1).trim();
  if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1).trim();
  }
  return next;
}

function providerCredentialKindFromForm(
  id: string,
  apiKey: string,
  apiKeyEnv: string,
): NonNullable<ProviderProfile["credentialKind"]> {
  if (isAwsBedrockProviderId(id)) return "aws";
  if (isGoogleVertexProviderId(id)) return "google-adc";
  if (apiKey) return "api-key";
  if (apiKeyEnv) return "env-key";
  return "none";
}

export function isLoginProtocol(value: string | undefined): boolean {
  return value === "native-oauth";
}

export type ProviderCatalogAuthKind = "api-key" | "account" | "cloud";

export function providerCatalogAuthKind(provider: ProviderProfile): ProviderCatalogAuthKind {
  if (isLoginProtocol(provider.protocol) || provider.routeKind === "login") return "account";
  if (providerUsesAmbientCredentials(provider.id)) return "cloud";
  return "api-key";
}

export function providerCatalogAuthKindLabel(kind: ProviderCatalogAuthKind, t: TranslationFn): string {
  if (kind === "account") return t("settings.accountLogin");
  if (kind === "cloud") return t("settings.providerAuthCloud");
  return t("settings.providerAuthApiKey");
}

export function providerUsesAmbientCredentials(providerId: string): boolean {
  return isAwsBedrockProviderId(providerId) || isGoogleVertexProviderId(providerId);
}

export function isGoogleVertexProviderId(providerId: string | undefined): boolean {
  return providerId === "google-vertex";
}

function editableProviderProtocol(provider: ProviderProfile): string {
  if (provider.protocol === "native-oauth") return "native-oauth";
  if (provider.protocol === "custom-gateway") return "custom-gateway";
  if (provider.protocol === "anthropic-compatible") return "anthropic-compatible";
  if (provider.protocol === "openai-compatible") return "openai-compatible";
  if (provider.anthropicBaseUrl && !provider.openaiBaseUrl) return "anthropic-compatible";
  return "openai-compatible";
}

export function isProviderEnabled(provider: ProviderProfile): boolean {
  if (provider.runtime) return provider.runtime.active;
  if (typeof provider.enabled === "boolean") {
    return provider.enabled;
  }
  return provider.custom === true;
}

export function isProviderAvailable(provider: ProviderProfile): boolean {
  if (provider.runtime) return provider.runtime.credential.configured;
  const sourceCredentialsUnavailable =
    providerSettingsAreSourceManaged(provider) && provider.authConfigured === false && !provider.apiKey?.trim();
  return provider.provisioningBlocked !== true && !sourceCredentialsUnavailable;
}

export function isProviderUsable(provider: ProviderProfile): boolean {
  return isProviderEnabled(provider) && isProviderAvailable(provider);
}

export function providerSettingsSections(providers: ProviderProfile[]): {
  main: ProviderProfile[];
  addable: ProviderProfile[];
  logins: ProviderProfile[];
} {
  const main: ProviderProfile[] = [];
  const addable: ProviderProfile[] = [];
  const logins: ProviderProfile[] = [];
  for (const provider of providers) {
    if (isLoginStateProvider(provider)) {
      logins.push(provider);
      continue;
    }
    const explicitlyConfigured = provider.runtime?.credential.status === "configured";
    const added = provider.custom === true || provider.origin === "user";
    if (isProviderEnabled(provider) || explicitlyConfigured || added) {
      main.push(provider);
    } else {
      addable.push(provider);
    }
  }
  return { main, addable, logins };
}

export function providerServesModel(
  provider: ProviderProfile,
  kernelId: string,
  modelId: string,
  providers: ProviderProfile[] = [provider],
): boolean {
  const models = provider.models ?? [];
  const selectedOffering = modelOfferingKeyForProviders(modelId, providers);
  return (
    models.some(
      (model) => modelOptionServesSelection(model, modelId) || modelOfferingKey(model) === selectedOffering,
    ) ||
    (providerRouteIdForKernel(provider, kernelId) === LOGIN_PROVIDER_BINDING_ID &&
      models.length === 0 &&
      modelId === `${kernelId}-default`)
  );
}

export function modelIdsEquivalent(
  left: string,
  right: string,
  providers: ProviderProfile[],
  providerId?: string,
): boolean {
  if (left === right) return true;
  const boundProvider = providerId ? providers.find((provider) => provider.id === providerId) : undefined;
  if (boundProvider) {
    const leftModel = providerModelForSelection(boundProvider, left);
    const rightModel = providerModelForSelection(boundProvider, right);
    if (leftModel && rightModel) {
      return modelOfferingKey(leftModel) === modelOfferingKey(rightModel);
    }
  }
  return modelOfferingKeyForProviders(left, providers) === modelOfferingKeyForProviders(right, providers);
}

function modelOfferingKeyForProviders(modelId: string, providers: ProviderProfile[]): string {
  const normalized = modelId.trim();
  for (const provider of providers) {
    const exact = (provider.models ?? []).find(
      (candidate) => candidate.id === normalized || candidate.apiModelId === normalized,
    );
    if (exact) return modelOfferingKey(exact);
  }
  for (const provider of providers) {
    const canonical = providerModelForSelection(provider, normalized);
    if (canonical) return modelOfferingKey(canonical);
  }
  return normalized;
}

function providerModelForSelection(provider: ProviderProfile, modelId: string) {
  const normalized = modelId.trim();
  const models = provider.models ?? [];
  return (
    models.find((candidate) => candidate.id === normalized || candidate.apiModelId === normalized) ??
    models.find((candidate) => candidate.canonicalModelId === normalized)
  );
}

export function modelOptionServesSelection(
  model: NonNullable<ProviderProfile["models"]>[number],
  modelId: string,
): boolean {
  const normalized = modelId.trim();
  return model.id === normalized || model.apiModelId === normalized || model.canonicalModelId === normalized;
}

export function providerSettingsAreSourceManaged(provider: ProviderProfile): boolean {
  return provider.origin === "discovered" || Boolean(provider.sourceKernel);
}

export function providerDisplayName(provider: ProviderProfile, t: TranslationFn): string {
  if (!isLoginStateProvider(provider)) return provider.name;
  const kernelName = KERNEL_PRODUCT_NAMES[provider.sourceKernel || ""];
  if (!kernelName) return t("settings.providerLoginName", { provider: provider.name });
  return t("settings.kernelLoginName", { kernel: kernelName });
}

function normalizeVoiceProviderId(value: string | undefined, fallback: VoiceSttProviderId): VoiceSttProviderId {
  return value === "openai" || value === "groq" || value === "local-whisper" || value === "browser" ? value : fallback;
}

function providerProtocolForKernel(
  provider: ProviderProfile,
  kernelId: string,
): "native-oauth" | "openai-compatible" | "anthropic-compatible" | "gemini-compatible" | "custom-gateway" | undefined {
  if (isLoginStateProvider(provider)) {
    return provider.sourceKernel === kernelId && providerCredentialConfigured(provider) ? "native-oauth" : undefined;
  }
  if (provider.sourceKernel === kernelId && providerCredentialConfigured(provider)) {
    if (provider.protocol === "custom-gateway") return "custom-gateway";
    if (provider.protocol === "anthropic-compatible") return "anthropic-compatible";
    if (provider.protocol === "gemini-compatible") return "gemini-compatible";
    return "openai-compatible";
  }
  if (kernelId === "claude-code") {
    return provider.anthropicBaseUrl &&
      providerCredentialIsSupported(provider, ["api-key", "env-key", "aws", "google-adc"])
      ? "anthropic-compatible"
      : undefined;
  }
  if (kernelId === "codex") {
    return provider.openaiBaseUrl && providerCredentialIsSupported(provider, ["api-key", "env-key"])
      ? "openai-compatible"
      : undefined;
  }
  if (kernelId === "pi") {
    if (provider.protocol === "native-oauth") return undefined;
    if (provider.openaiBaseUrl && providerCredentialIsSupported(provider, ["api-key", "env-key"]))
      return "openai-compatible";
    if (provider.anthropicBaseUrl && providerCredentialIsSupported(provider, ["api-key", "env-key"]))
      return "anthropic-compatible";
    return provider.geminiBaseUrl && providerCredentialIsSupported(provider, ["api-key", "env-key"])
      ? "gemini-compatible"
      : undefined;
  }
  if (kernelId === "hermes") {
    if (!providerCredentialIsSupported(provider, ["api-key", "env-key"])) return undefined;
    if (provider.protocol === "anthropic-compatible" && provider.anthropicBaseUrl) return "anthropic-compatible";
    if (provider.openaiBaseUrl) return "openai-compatible";
    return provider.anthropicBaseUrl ? "anthropic-compatible" : undefined;
  }
  if (kernelId === "opencode") {
    if (provider.openaiBaseUrl && providerCredentialIsSupported(provider, ["api-key", "env-key"]))
      return "openai-compatible";
    return isAwsBedrockProvider(provider) && provider.anthropicBaseUrl ? "anthropic-compatible" : undefined;
  }
  return provider.openaiBaseUrl && providerCredentialIsSupported(provider, ["api-key", "env-key"])
    ? "openai-compatible"
    : undefined;
}

function providerCredentialIsSupported(provider: ProviderProfile, allowed: string[]): boolean {
  return allowed.includes(providerCredentialKind(provider));
}

function providerCredentialKind(provider: ProviderProfile): string {
  if (isAwsBedrockProvider(provider)) return "aws";
  if (provider.credentialKind) return provider.credentialKind;
  if (provider.protocol === "native-oauth") return "native-login";
  if (provider.apiKey) return "api-key";
  if (provider.apiKeyEnv) return "env-key";
  const text = `${provider.id} ${provider.name}`.toLowerCase();
  if (text.includes("bedrock")) return "aws";
  if (text.includes("vertex")) return "google-adc";
  return providerCredentialConfigured(provider) && provider.sourceKernel ? "kernel-managed" : "none";
}

function providerCredentialConfigured(provider: ProviderProfile): boolean {
  return provider.runtime?.credential.configured ?? provider.authConfigured === true;
}

function isAwsBedrockProvider(provider: ProviderProfile): boolean {
  return isAwsBedrockProviderId(provider.id);
}

function isAwsBedrockProviderId(providerId: string | undefined): boolean {
  return providerId === "aws-bedrock" || providerId === "aws-bedrock-api-key" || providerId === "amazon-bedrock";
}

function isWwProvider(provider: ProviderProfile): boolean {
  const tokens = `${provider.id} ${provider.name}`
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  return tokens.includes("ww");
}

export function isLoginStateProvider(provider: ProviderProfile): boolean {
  return provider.routeKind === "login" && Boolean(provider.sourceKernel);
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
