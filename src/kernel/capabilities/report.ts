import {
  STANDARD_KERNEL_CAPABILITY_IDS,
  type KernelCapabilityContract,
  type KernelCapabilityId,
  type KernelCapabilityAuditStatus,
  type KernelCapabilityReport,
  type KernelCapabilityReportEntry,
  type KernelContractTestEvidence,
  type KernelContractEvidenceContext,
  type KernelExposure,
  type KernelNativeCapabilityFact,
  type KernelNativeSupport,
  type KernelProductBehavior,
} from "./types.js";

export function buildKernelCapabilityReport(input: {
  kernel: string;
  nativeFacts: KernelNativeCapabilityFact[];
  contracts: KernelCapabilityContract[];
  contractTests: KernelContractTestEvidence[];
  generatedAt?: string;
  evidenceContext?: KernelContractEvidenceContext;
}): KernelCapabilityReport {
  const contract = input.contracts.find((item) => item.kernel === input.kernel);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return {
    schemaVersion: 2,
    generatedAt,
    kernel: input.kernel,
    capabilities: STANDARD_KERNEL_CAPABILITY_IDS.map((capability) =>
      buildCapabilityReportEntry({
        kernel: input.kernel,
        capability,
        nativeFact: input.nativeFacts.find((fact) => fact.kernel === input.kernel && fact.capability === capability),
        mapping: contract?.mappings.find((item) => item.capability === capability),
        contractTests: input.contractTests.filter(
          (test) => test.kernel === input.kernel && test.capability === capability,
        ),
        evidenceContext: input.evidenceContext,
      }),
    ),
  };
}

function buildCapabilityReportEntry(input: {
  kernel: string;
  capability: KernelCapabilityId;
  nativeFact?: KernelNativeCapabilityFact;
  mapping?: KernelCapabilityContract["mappings"][number];
  contractTests: KernelContractTestEvidence[];
  evidenceContext?: KernelContractEvidenceContext;
}): KernelCapabilityReportEntry {
  const native: KernelNativeSupport = input.nativeFact?.native ?? "unknown";
  const passingRealRuntimeTests = input.contractTests.filter(
    (test) =>
      test.passed && test.verification === "real_runtime" && evidenceMatchesCurrentContext(test, input.evidenceContext),
  );
  const exposed = exposureFromMapping(input.mapping?.status, passingRealRuntimeTests.length > 0);
  const auditStatuses = auditStatusesFor({
    native,
    mapping: input.mapping,
    hasPassingRealRuntimeTest: passingRealRuntimeTests.length > 0,
  });
  const notes = [...(input.nativeFact?.notes ?? []), ...(input.mapping?.notes ?? [])];
  return {
    kernel: input.kernel,
    capability: input.capability,
    native,
    exposed,
    productBehavior: productBehaviorFromExposure(exposed),
    ...(input.nativeFact?.evidence ? { nativeEvidence: input.nativeFact.evidence } : {}),
    ...(input.mapping ? { contractMapping: input.mapping } : {}),
    contractTests: input.contractTests,
    ...(auditStatuses[0] ? { auditStatus: auditStatuses[0] } : {}),
    ...(auditStatuses.length ? { auditStatuses } : {}),
    notes,
  };
}

function evidenceMatchesCurrentContext(
  evidence: KernelContractTestEvidence,
  context: KernelContractEvidenceContext | undefined,
): boolean {
  const checkedAt = Date.parse(evidence.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  if (evidence.legacyHostVersion) {
    return context?.hostVersion === evidence.legacyHostVersion;
  }
  if (!evidence.hostVersion || !evidence.kernelVersion || !evidence.runtimeMode) return false;
  if (!context?.hostVersion || !context.kernelVersion || !context.runtimeMode) return false;
  if (evidence.hostVersion !== context.hostVersion) return false;
  if (evidence.kernelVersion !== context.kernelVersion) return false;
  if (evidence.runtimeMode !== context.runtimeMode) return false;
  if (evidence.provider && context.provider) {
    if (evidence.provider.kind !== context.provider.kind) return false;
    if (evidence.provider.model && context.provider.model && evidence.provider.model !== context.provider.model) {
      return false;
    }
  }
  return true;
}

function auditStatusesFor(input: {
  native: KernelNativeSupport;
  mapping?: KernelCapabilityContract["mappings"][number];
  hasPassingRealRuntimeTest: boolean;
}): KernelCapabilityAuditStatus[] {
  const statuses: KernelCapabilityAuditStatus[] = [];
  if (input.native === "unknown") {
    statuses.push("needs_native_verification");
  }
  if (
    (input.mapping?.status === "mapped" || input.mapping?.status === "fallback") &&
    !input.hasPassingRealRuntimeTest
  ) {
    statuses.push(input.mapping.expectedContractTest ? "needs_real_runtime_verification" : "needs_contract_test");
  }
  return statuses;
}

function exposureFromMapping(
  status: KernelCapabilityContract["mappings"][number]["status"] | undefined,
  hasPassingContractTest: boolean,
): KernelExposure {
  if (!status || status === "unknown") return "unknown";
  if (status === "not-wired" || status === "suppressed") return "no";
  if (status === "fallback") return hasPassingContractTest ? "partial" : "unknown";
  return hasPassingContractTest ? "yes" : "unknown";
}

function productBehaviorFromExposure(exposed: KernelExposure): KernelProductBehavior {
  if (exposed === "yes") return "enable";
  if (exposed === "partial") return "fallback";
  return "hide";
}
