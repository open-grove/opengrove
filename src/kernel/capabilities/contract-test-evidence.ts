import type { KernelContractTestEvidence } from "./types.js";
import certifiedContractTests from "./certified-contract-test-evidence.generated.json" with { type: "json" };

export const CERTIFIED_KERNEL_CONTRACT_TESTS: KernelContractTestEvidence[] =
  certifiedContractTests as KernelContractTestEvidence[];

export { GENERATED_KERNEL_CONTRACT_TESTS as SIMULATED_KERNEL_CONTRACT_TESTS } from "./generated-contract-test-evidence.js";
