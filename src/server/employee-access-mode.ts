import { resolveRuntimeAccessModeSelection } from "../runtime-access.js";

export function normalizeEmployeeAccessMode(kernel: string, requested: unknown) {
  const accessMode = resolveRuntimeAccessModeSelection(kernel, requested);
  if (typeof requested === "string" && requested !== accessMode) {
    console.warn("employee_access_mode_normalized", { kernel, requested, accessMode });
  }
  return accessMode;
}
