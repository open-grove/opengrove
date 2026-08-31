import type { JsonObject } from "../core.js";
import type { KernelTransportKind } from "../runtime/transports/types.js";
import type { KernelAdapterContract, KernelCapabilities } from "./types.js";

export type KernelSessionStrategy =
  | "app-owned"
  | "native-persistent"
  | "native-ephemeral"
  | "provider-thread"
  | "unsupported";

export type KernelProviderBindingMode = "env" | "config-file" | "native-api" | "sdk-options" | "host-http" | "none";

export type KernelApprovalBridgeMode = "native-request" | "host-policy" | "provider-tool-loop" | "unsupported";

export interface KernelTransportManifest {
  primary: KernelTransportKind;
  fallbacks?: KernelTransportKind[];
  launch?: {
    command?: string;
    args?: string[];
    cwd?: string;
  };
  notes?: string[];
}

export interface KernelEventProjectorManifest {
  id: string;
  nativeEvents: string[];
  appEvents: string[];
  notes?: string[];
}

export interface KernelHarnessTemplateManifest {
  fakeServer?: "acp" | "stdio-jsonrpc" | "http-sse" | "websocket-gateway";
  smokePrompt?: string;
  expectedEvents?: string[];
  notes?: string[];
}

export interface KernelIntegrationManifest {
  kernelId: string;
  title: string;
  transport: KernelTransportManifest;
  session: {
    strategy: KernelSessionStrategy;
    nativeSessionKey?: string;
    reuseAcrossModelChanges?: boolean;
    notes?: string[];
  };
  providerBinding: {
    mode: KernelProviderBindingMode;
    configFiles?: string[];
    env?: string[];
    notes?: string[];
  };
  approvals: {
    mode: KernelApprovalBridgeMode;
    nativeRequest?: string;
    notes?: string[];
  };
  eventProjector: KernelEventProjectorManifest;
  harness: KernelHarnessTemplateManifest;
  capabilities: KernelCapabilities;
  contract: KernelAdapterContract;
  metadata?: JsonObject;
  rollout?: {
    status: "implemented" | "planned" | "fallback";
    next?: string[];
  };
}

export function kernelIntegrationSummary(manifest: KernelIntegrationManifest): JsonObject {
  return {
    kernelId: manifest.kernelId,
    title: manifest.title,
    transport: manifest.transport.primary,
    fallbacks: manifest.transport.fallbacks ?? [],
    sessionStrategy: manifest.session.strategy,
    providerBinding: manifest.providerBinding.mode,
    approvalBridge: manifest.approvals.mode,
    eventProjector: manifest.eventProjector.id,
    rolloutStatus: manifest.rollout?.status ?? "planned",
  };
}
