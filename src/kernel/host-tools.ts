import { KERNEL_CAPABILITY_CONTRACTS } from "./capabilities/contracts.js";

/**
 * Static Host Tool capability used both by adapters and pre-run routing gates.
 * Keep this resolver free of adapter construction, CLI probes, and state I/O.
 */
export function bridgeKernelSupportsHostTools(kernelId: string): boolean {
  return (
    KERNEL_CAPABILITY_CONTRACTS.find((contract) => contract.kernel === kernelId)?.mappings.some(
      (mapping) => mapping.capability === "tools.hostTool" && mapping.status === "mapped",
    ) === true
  );
}
