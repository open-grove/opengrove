import type { KernelCapabilityId } from "#protocol";
export { STANDARD_KERNEL_CAPABILITY_IDS, type KernelCapabilityId } from "#protocol";

export type KernelNativeSupport = "yes" | "no" | "unknown";
export type KernelExposure = "yes" | "no" | "partial" | "unknown";
export type KernelProductBehavior = "enable" | "fallback" | "hide";
export type KernelCapabilityEvidenceKind =
  | "raw_source"
  | "local_package"
  | "runtime_probe"
  | "implementation"
  | "linked_source";

export interface KernelCapabilityEvidence {
  source: string;
  checkedAt: string;
  kind?: KernelCapabilityEvidenceKind;
  sourcePath?: string;
  upstreamVersion?: string;
  confidence?: "verified" | "inferred";
}

export interface KernelNativeCapabilityFact {
  kernel: string;
  capability: KernelCapabilityId;
  native: KernelNativeSupport;
  evidence?: KernelCapabilityEvidence;
  notes?: string[];
}

export type KernelContractMappingStatus = "mapped" | "not-wired" | "suppressed" | "fallback" | "unknown";

export interface KernelContractMapping {
  capability: KernelCapabilityId;
  status: KernelContractMappingStatus;
  from?: string;
  to?: string;
  expectedContractTest?: string;
  notes?: string[];
}

export interface KernelCapabilityContract {
  kernel: string;
  mappings: KernelContractMapping[];
}

export interface KernelContractTestEvidence {
  kernel: string;
  capability: KernelCapabilityId;
  testId: string;
  passed: boolean;
  checkedAt: string;
  hostVersion?: string;
  kernelVersion?: string;
  runtimeMode?: string;
  /** Host version that produced legacy evidence. Provenance only; unrelated Host releases do not invalidate it. */
  legacyHostVersion?: string;
  provider?: KernelContractEvidenceProvider;
  verification?: "real_runtime" | "simulated" | "source_fixture";
  source?: string;
  sourcePath?: string;
}

export interface KernelContractEvidenceProvider {
  kind: "native" | "openai-compatible" | "anthropic-compatible" | "gemini-compatible" | "unknown";
  model?: string;
}

export interface KernelContractEvidenceContext {
  kernelVersion?: string;
  runtimeMode?: string;
  provider?: KernelContractEvidenceProvider;
}

export type KernelCapabilityAuditStatus =
  | "needs_native_verification"
  | "needs_contract_test"
  | "needs_real_runtime_verification"
  | "needs_context_reverification"
  | "current_context_verification_failed";

export interface KernelCapabilityReportEntry {
  kernel: string;
  capability: KernelCapabilityId;
  native: KernelNativeSupport;
  exposed: KernelExposure;
  productBehavior: KernelProductBehavior;
  nativeEvidence?: KernelCapabilityEvidence;
  contractMapping?: KernelContractMapping;
  contractTests: KernelContractTestEvidence[];
  auditStatus?: KernelCapabilityAuditStatus;
  auditStatuses?: KernelCapabilityAuditStatus[];
  notes: string[];
}

export interface KernelCapabilityReport {
  schemaVersion: 2;
  generatedAt: string;
  kernel: string;
  capabilities: KernelCapabilityReportEntry[];
}
