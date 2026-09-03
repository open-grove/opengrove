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
  const validRealRuntimeTests = input.contractTests.filter(
    (test) => test.verification === "real_runtime" && isUsableRealRuntimeEvidence(test),
  );
  const currentContextTests = validRealRuntimeTests
    .filter((test) => evidenceMatchesCurrentContext(test, input.evidenceContext))
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt));
  const latestCurrentContextTest = currentContextTests[0];
  const currentContextVerificationFailed = latestCurrentContextTest?.passed === false;
  const hasPassingRealRuntimeTest = currentContextVerificationFailed
    ? false
    : latestCurrentContextTest?.passed === true || validRealRuntimeTests.some((test) => test.passed);
  const needsContextReverification =
    hasPassingRealRuntimeTest &&
    latestCurrentContextTest === undefined &&
    validRealRuntimeTests.some((test) => test.passed);
  const exposed = exposureFromMapping(input.mapping?.status, hasPassingRealRuntimeTest);
  const auditStatuses = auditStatusesFor({
    native,
    mapping: input.mapping,
    hasPassingRealRuntimeTest,
    needsContextReverification,
    currentContextVerificationFailed,
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

function isUsableRealRuntimeEvidence(evidence: KernelContractTestEvidence): boolean {
  if (!Number.isFinite(Date.parse(evidence.checkedAt))) return false;
  if (evidence.legacyHostVersion) return true;
  return Boolean(evidence.hostVersion && evidence.kernelVersion && evidence.runtimeMode);
}

function evidenceMatchesCurrentContext(
  evidence: KernelContractTestEvidence,
  context: KernelContractEvidenceContext | undefined,
): boolean {
  if (evidence.legacyHostVersion) return false;
  if (!context?.kernelVersion || !context.runtimeMode) return false;
  if (evidence.kernelVersion !== context.kernelVersion) return false;
  if (evidence.runtimeMode !== context.runtimeMode) return false;
  if (Boolean(evidence.provider) !== Boolean(context.provider)) return false;
  if (evidence.provider && context.provider) {
    if (evidence.provider.kind !== context.provider.kind) return false;
    if (evidence.provider.model !== context.provider.model) return false;
  }
  return true;
}

function auditStatusesFor(input: {
  native: KernelNativeSupport;
  mapping?: KernelCapabilityContract["mappings"][number];
  hasPassingRealRuntimeTest: boolean;
  needsContextReverification: boolean;
  currentContextVerificationFailed: boolean;
}): KernelCapabilityAuditStatus[] {
  const statuses: KernelCapabilityAuditStatus[] = [];
  if (input.native === "unknown") {
    statuses.push("needs_native_verification");
  }
  if (input.currentContextVerificationFailed) {
    statuses.push("current_context_verification_failed");
  } else if (
    (input.mapping?.status === "mapped" || input.mapping?.status === "fallback") &&
    !input.hasPassingRealRuntimeTest
  ) {
    statuses.push(input.mapping.expectedContractTest ? "needs_real_runtime_verification" : "needs_contract_test");
  } else if (input.needsContextReverification) {
    statuses.push("needs_context_reverification");
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
