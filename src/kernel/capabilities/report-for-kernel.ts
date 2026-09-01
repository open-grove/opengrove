import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../../package-root.js";
import { KERNEL_CAPABILITY_CONTRACTS } from "./contracts.js";
import { CERTIFIED_KERNEL_CONTRACT_TESTS } from "./contract-test-evidence.js";
import { KERNEL_NATIVE_CAPABILITY_FACTS } from "./native-facts.js";
import { buildKernelCapabilityReport } from "./report.js";
import type { KernelCapabilityReport, KernelContractEvidenceContext } from "./types.js";

export function buildKnownKernelCapabilityReport(
  kernel: string,
  generatedAt?: string,
  evidenceContext?: KernelContractEvidenceContext,
): KernelCapabilityReport {
  const resolvedEvidenceContext = evidenceContext ?? { hostVersion: currentHostVersion() };
  return buildKernelCapabilityReport({
    kernel,
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: CERTIFIED_KERNEL_CONTRACT_TESTS,
    generatedAt,
    evidenceContext: resolvedEvidenceContext,
  });
}

function currentHostVersion(): string | undefined {
  try {
    const metadata = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof metadata.version === "string" && metadata.version.trim() ? metadata.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function buildUnknownRemoteKernelCapabilityReport(input: {
  kernel: string;
  reason: string;
  generatedAt?: string;
}): KernelCapabilityReport {
  const report = buildKernelCapabilityReport({
    kernel: input.kernel,
    nativeFacts: [],
    contracts: [],
    contractTests: [],
    generatedAt: input.generatedAt,
  });
  return {
    ...report,
    capabilities: report.capabilities.map((entry) => ({
      ...entry,
      notes: [...entry.notes, input.reason],
    })),
  };
}
