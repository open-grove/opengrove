import { createHash } from "node:crypto";
import type {
  BridgeKernelId,
  BridgeProviderCredentialKind,
  BridgeProviderProfile,
  BridgeProviderProtocol,
} from "./bridge-types.js";
import {
  getBridgeKernelDescriptor,
  type BridgeKernelBindingMode,
  type BridgeKernelExternalProviderRoute,
} from "./kernel-registry.js";

export interface BridgeProviderBindingPlan {
  kernelId: BridgeKernelId;
  providerId?: string;
  kind: "login" | "kernel-provider" | "external-provider" | "gateway-provider" | "unsupported";
  supported: boolean;
  protocol?: BridgeProviderProtocol;
  credentialKind: BridgeProviderCredentialKind;
  mode: BridgeKernelBindingMode;
  preserveNativeControls: boolean;
  reason: string;
}

export function planProviderBinding(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile | undefined,
): BridgeProviderBindingPlan {
  const descriptor = getBridgeKernelDescriptor(kernelId);
  if (!profile) {
    if (!descriptor.accountLogin) {
      return {
        kernelId,
        kind: "unsupported",
        supported: false,
        credentialKind: "none",
        mode: descriptor.bindingMode,
        preserveNativeControls: false,
        reason: `${descriptor.label} has no product-account Login route; choose a Provider.`,
      };
    }
    return {
      kernelId,
      kind: "login",
      supported: true,
      credentialKind: "kernel-native",
      mode: "native",
      preserveNativeControls: true,
      reason: `${descriptor.label} uses its account login.`,
    };
  }

  const credentialKind = providerCredentialKind(profile);
  if (profile.routeKind === "login") {
    if (profile.sourceKernel !== kernelId || !profile.authConfigured || !descriptor.accountLogin) {
      return unsupportedPlan(kernelId, profile, credentialKind, `${descriptor.label} cannot use this account login.`);
    }
    return {
      kernelId,
      providerId: profile.id,
      kind: "login",
      supported: true,
      protocol: profile.protocol,
      credentialKind,
      mode: "native",
      preserveNativeControls: true,
      reason: `${descriptor.label} can use its account login.`,
    };
  }

  if (profile.sourceKernel === kernelId && (profile.authConfigured || credentialKind === "gateway-managed")) {
    return {
      kernelId,
      providerId: profile.id,
      kind: credentialKind === "gateway-managed" ? "gateway-provider" : "kernel-provider",
      supported: true,
      protocol: profile.protocol,
      credentialKind,
      mode: credentialKind === "gateway-managed" ? "gateway" : "native",
      preserveNativeControls: true,
      reason: `${descriptor.label} can use this Provider from its own configuration.`,
    };
  }

  const routesWithEndpoint = externalProviderRoutesWithEndpoint(kernelId, profile);
  if (!routesWithEndpoint.length) {
    return unsupportedPlan(
      kernelId,
      profile,
      credentialKind,
      `${descriptor.label} does not support this provider protocol.`,
    );
  }

  const compatibleRoutes = preferDeclaredProtocol(routesWithEndpoint, profile.protocol);
  const route = compatibleRoutes.find((candidate) => candidate.credentialKinds.includes(credentialKind));
  if (!route) {
    return unsupportedPlan(
      kernelId,
      profile,
      credentialKind,
      `${descriptor.label} cannot reuse this provider credential type.`,
      compatibleRoutes[0]?.protocol,
    );
  }
  const protocol = route.protocol;

  if (!providerHasTransferableCredential(profile) && credentialKind !== "aws" && credentialKind !== "google-adc") {
    return unsupportedPlan(
      kernelId,
      profile,
      credentialKind,
      `${descriptor.label} provider binding requires a transferable API key or environment variable.`,
      protocol,
    );
  }

  return {
    kernelId,
    providerId: profile.id,
    kind: "external-provider",
    supported: true,
    protocol,
    credentialKind,
    mode: descriptor.bindingMode,
    preserveNativeControls: false,
    reason: `${descriptor.label} can use this provider through ${protocol}.`,
  };
}

export function providerCredentialKind(profile: BridgeProviderProfile): BridgeProviderCredentialKind {
  if (isAwsBedrockProviderId(profile.id)) return "aws";
  if (profile.credentialKind) return profile.credentialKind;
  if (profile.protocol === "native-oauth") return "native-login";
  if (profile.apiKey) return "api-key";
  if (profile.apiKeyEnv) return "env-key";
  if (profile.id.includes("bedrock") || profile.name.toLowerCase().includes("bedrock")) return "aws";
  if (profile.id.includes("vertex") || profile.name.toLowerCase().includes("vertex")) return "google-adc";
  if (profile.authConfigured && profile.sourceKernel) return "kernel-native";
  return "none";
}

export function providerHasTransferableCredential(profile: BridgeProviderProfile): boolean {
  return Boolean(profile.apiKey || profile.apiKeyEnv);
}

export function usesKernelManagedProviderConfig(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile | undefined,
): boolean {
  const kind = planProviderBinding(kernelId, profile).kind;
  return kind === "login" || kind === "kernel-provider" || kind === "gateway-provider";
}

export function isLoginProviderProfile(kernelId: BridgeKernelId, profile: BridgeProviderProfile | undefined): boolean {
  return planProviderBinding(kernelId, profile).kind === "login";
}

export function providerBindingFingerprint(input: {
  kernelId: BridgeKernelId;
  provider: BridgeProviderProfile | undefined;
  providerModel?: string;
  kernelModel?: string;
  cwd?: string;
  dynamicToolsFingerprint?: string;
}): string {
  const plan = planProviderBinding(input.kernelId, input.provider);
  const descriptor = getBridgeKernelDescriptor(input.kernelId);
  const includeModel = !descriptor.thread.reuseAcrossModelChanges;
  return shortHash(
    stableJson({
      kernelId: input.kernelId,
      kind: plan.kind,
      providerId: input.provider?.id ?? "login",
      sourceKernel: input.provider?.sourceKernel,
      protocol: plan.protocol,
      credentialKind: plan.credentialKind,
      openaiBaseUrl: input.provider?.openaiBaseUrl,
      anthropicBaseUrl: input.provider?.anthropicBaseUrl,
      geminiBaseUrl: input.provider?.geminiBaseUrl,
      providerModel: includeModel ? input.providerModel : undefined,
      kernelModel: includeModel ? input.kernelModel : undefined,
      cwd: input.cwd,
      dynamicToolsFingerprint: input.dynamicToolsFingerprint,
    }),
  );
}

function externalProviderRoutesWithEndpoint(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile,
): BridgeKernelExternalProviderRoute[] {
  return getBridgeKernelDescriptor(kernelId).externalProviderRoutes.filter((route) =>
    providerHasProtocolUrl(profile, route.protocol),
  );
}

function preferDeclaredProtocol(
  routes: BridgeKernelExternalProviderRoute[],
  declaredProtocol: BridgeProviderProtocol,
): BridgeKernelExternalProviderRoute[] {
  return [
    ...routes.filter((route) => route.protocol === declaredProtocol),
    ...routes.filter((route) => route.protocol !== declaredProtocol),
  ];
}

function providerHasProtocolUrl(profile: BridgeProviderProfile, protocol: BridgeProviderProtocol): boolean {
  if (protocol === "openai-compatible") return Boolean(profile.openaiBaseUrl);
  if (protocol === "anthropic-compatible") return Boolean(profile.anthropicBaseUrl);
  if (protocol === "gemini-compatible") return Boolean(profile.geminiBaseUrl);
  if (protocol === "native-oauth") return profile.protocol === "native-oauth";
  return false;
}

function isAwsBedrockProviderId(providerId: string): boolean {
  return providerId === "aws-bedrock" || providerId === "aws-bedrock-api-key" || providerId === "amazon-bedrock";
}

function unsupportedPlan(
  kernelId: BridgeKernelId,
  profile: BridgeProviderProfile,
  credentialKind: BridgeProviderCredentialKind,
  reason: string,
  protocol?: BridgeProviderProtocol,
): BridgeProviderBindingPlan {
  return {
    kernelId,
    providerId: profile.id,
    kind: "unsupported",
    supported: false,
    protocol,
    credentialKind,
    mode: getBridgeKernelDescriptor(kernelId).bindingMode,
    preserveNativeControls: false,
    reason,
  };
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
