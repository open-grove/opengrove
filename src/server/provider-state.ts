import type {
  BridgeProviderCredentialState,
  BridgeProviderProfile,
  BridgeProviderRuntimeState,
  BridgeProviderView,
} from "./bridge-types.js";
import { providerCredentialKind } from "./provider-binding.js";

export function resolveProviderApiKey(
  profile: BridgeProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return profile.apiKey?.trim() || (profile.apiKeyEnv ? env[profile.apiKeyEnv]?.trim() : undefined);
}

/** Equivalent to DeepSeek Harness credentials.describe(): safe, live credential metadata only. */
export function describeProviderCredential(
  profile: BridgeProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
): BridgeProviderCredentialState {
  const sourceManaged = profile.origin === "discovered" || Boolean(profile.sourceKernel);
  const writable = !sourceManaged;
  const kind = providerCredentialKind(profile);
  if (profile.provisioningBlocked === true) {
    return { status: "missing", configured: false, source: "unknown", writable };
  }
  if (profile.apiKey?.trim()) {
    return { status: "configured", configured: true, source: "inline", writable };
  }
  if (kind === "gateway-managed") {
    // The selected upstream Provider has no credential of its own. Gateway
    // connectivity is checked by the OpenClaw runtime and a failed refresh
    // deliberately retains the last-known catalog.
    return { status: "not-required", configured: true, source: "gateway", writable };
  }
  if (profile.apiKeyEnv && env[profile.apiKeyEnv]?.trim()) {
    return { status: "configured", configured: true, source: "environment", writable };
  }
  if (sourceManaged) {
    if (profile.authConfigured === true) {
      return {
        status: "configured",
        configured: true,
        source: credentialSource(profile),
        writable,
      };
    }
    if (profile.authConfigured === false) {
      return {
        status: "missing",
        configured: false,
        source: credentialSource(profile),
        writable,
      };
    }
    if (profile.apiKeyEnv) {
      return { status: "missing", configured: false, source: "environment", writable };
    }
    return { status: "unknown", configured: false, source: credentialSource(profile), writable };
  }
  if (profile.apiKeyEnv) {
    return { status: "missing", configured: false, source: "environment", writable };
  }
  if (kind === "aws" || kind === "google-adc") {
    // AWS SDK chains and Google ADC are ambient process credentials. The Host
    // cannot safely prove their readiness without making an upstream request.
    return { status: "not-required", configured: true, source: "ambient", writable };
  }
  if (kind === "none") {
    return { status: "not-required", configured: true, source: "none", writable };
  }
  return { status: "unknown", configured: false, source: credentialSource(profile), writable };
}

/** Equivalent to DeepSeek Harness providerUsable(): active route joined with live credentials. */
export function providerRuntimeState(
  profile: BridgeProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
): BridgeProviderRuntimeState {
  const credential = describeProviderCredential(profile, env);
  // Persisted custom profiles written before activation was explicit remain active.
  // Built-in catalog definitions are inactive until the user creates an override.
  const active = profile.enabled === true || (profile.enabled === undefined && profile.custom === true);
  return {
    active,
    usable: active && credential.configured,
    credential,
  };
}

export function providerView(profile: BridgeProviderProfile, env: NodeJS.ProcessEnv = process.env): BridgeProviderView {
  const { authConfigured: _legacyRuntimeValue, ...definition } = profile;
  return {
    ...definition,
    runtime: providerRuntimeState(profile, env),
  };
}

function credentialSource(profile: BridgeProviderProfile): BridgeProviderCredentialState["source"] {
  if (profile.routeKind === "login" || profile.credentialKind === "native-login") return "login";
  if (profile.credentialKind === "gateway-managed") return "gateway";
  if (profile.sourceKernel || profile.credentialKind === "kernel-native") return "kernel";
  return "unknown";
}
