import { STANDARD_KERNEL_CAPABILITY_IDS, type KernelCapabilityId, type KernelCapabilityReport } from "./types.js";

const KERNEL_CAPABILITY_IDS = new Set<string>(STANDARD_KERNEL_CAPABILITY_IDS);

/** First desktop Host release that understands and enforces requiredKernelCapabilities. */
export const KERNEL_CAPABILITY_REQUIREMENTS_MIN_HOST_RELEASE = 10_031;

export interface KernelCapabilityRequirementResult {
  ok: boolean;
  required: KernelCapabilityId[];
  missing: KernelCapabilityId[];
  invalid: string[];
}

export class InvalidKernelCapabilityRequirementsError extends Error {
  constructor(readonly invalid: string[]) {
    super(`invalid_kernel_capability_requirements:${invalid.join(",")}`);
    this.name = "InvalidKernelCapabilityRequirementsError";
  }
}

export function inspectRequiredKernelCapabilities(value: unknown): {
  required: KernelCapabilityId[];
  invalid: string[];
} {
  if (value === undefined) return { required: [], invalid: [] };
  if (!Array.isArray(value)) return { required: [], invalid: ["not_an_array"] };
  const required: KernelCapabilityId[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  value.forEach((candidate, index) => {
    if (typeof candidate !== "string") {
      invalid.push(`${index}:not_a_string`);
      return;
    }
    if (!KERNEL_CAPABILITY_IDS.has(candidate)) {
      invalid.push(`${index}:unknown:${candidate}`);
      return;
    }
    if (seen.has(candidate)) {
      invalid.push(`${index}:duplicate:${candidate}`);
      return;
    }
    seen.add(candidate);
    required.push(candidate as KernelCapabilityId);
  });
  return { required, invalid };
}

export function normalizeRequiredKernelCapabilities(value: unknown): KernelCapabilityId[] {
  const inspected = inspectRequiredKernelCapabilities(value);
  if (inspected.invalid.length) throw new InvalidKernelCapabilityRequirementsError(inspected.invalid);
  return inspected.required;
}

export function evaluateKernelCapabilityRequirements(
  kernel: string,
  requiredValue: unknown,
  report: KernelCapabilityReport,
): KernelCapabilityRequirementResult {
  const { required, invalid } = inspectRequiredKernelCapabilities(requiredValue);
  if (report.kernel !== kernel) {
    return {
      ok: false,
      required,
      missing: required,
      invalid: [...invalid, `report_kernel_mismatch:${report.kernel}`],
    };
  }
  const exposed = new Map(report.capabilities.map((entry) => [entry.capability, entry.exposed]));
  const missing = required.filter((capability) => exposed.get(capability) !== "yes");
  return { ok: invalid.length === 0 && missing.length === 0, required, missing, invalid };
}
