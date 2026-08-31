import { DEFAULT_BRIDGE_MODEL_ID, type BridgeKernelId } from "./bridge-types.js";

export interface ProductEmployeeRuntimeDefault {
  kernel: BridgeKernelId;
  model: string;
}

export const PRODUCT_DEFAULT_KERNEL_ID: BridgeKernelId = "claude-code";
export const PRODUCT_DEFAULT_MODEL_ID = DEFAULT_BRIDGE_MODEL_ID;

export const PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS = {
  "grove-guide": {
    kernel: PRODUCT_DEFAULT_KERNEL_ID,
    model: PRODUCT_DEFAULT_MODEL_ID,
  },
  "app-builder": {
    kernel: PRODUCT_DEFAULT_KERNEL_ID,
    model: "claude-opus-4-8",
  },
  pm: {
    kernel: PRODUCT_DEFAULT_KERNEL_ID,
    model: PRODUCT_DEFAULT_MODEL_ID,
  },
} as const satisfies Record<string, ProductEmployeeRuntimeDefault>;

export function productEmployeeRuntimeDefault(
  employeeDefinitionId: string | undefined,
): ProductEmployeeRuntimeDefault | undefined {
  if (!employeeDefinitionId) return undefined;
  const runtime =
    PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS[employeeDefinitionId as keyof typeof PRODUCT_EMPLOYEE_RUNTIME_DEFAULTS];
  return runtime ? { ...runtime } : undefined;
}

export function productDefaultModelForKernel(kernel: BridgeKernelId): string {
  return kernel === PRODUCT_DEFAULT_KERNEL_ID ? PRODUCT_DEFAULT_MODEL_ID : `${kernel}-default`;
}
