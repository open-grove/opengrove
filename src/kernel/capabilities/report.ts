import {
  STANDARD_KERNEL_CAPABILITY_IDS,
  type KernelCapabilityContract,
  type KernelCapabilityId,
  type KernelCapabilityAuditStatus,
  type KernelCapabilityReport,
  type KernelCapabilityReportEntry,
  type KernelContractTestEvidence,
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
}): KernelCapabilityReport {
  const contract = input.contracts.find((item) => item.kernel === input.kernel);
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
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
}): KernelCapabilityReportEntry {
  const native: KernelNativeSupport = input.nativeFact?.native ?? "unknown";
  const passingRealRuntimeTests = input.contractTests.filter(
    (test) => test.passed && test.verification === "real_runtime",
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
