import { isBridgeKernelId, type RoomChannelMember, type RoomChannelStore } from "../../rooms/channel-store.js";
import { LEGACY_NATIVE_MODEL_ID } from "../bridge-types.js";
import { productDefaultModelForKernel, productEmployeeRuntimeDefault } from "../product-employee-defaults.js";

export const CURRENT_EMPLOYEE_MODEL_MIGRATION_VERSION = 1 as const;

/**
 * Older Employee records could omit their model or persist the `native`
 * bootstrap sentinel. This migration resolves those records to the current
 * product default for the Employee's Kernel without overriding user choices.
 * Supports: OpenGrove <=0.6.4 Employee rows that omitted a model or persisted
 * the `native` bootstrap sentinel instead of a concrete product model.
 * Remove when: direct upgrades from <=0.6.4 move to the standalone importer.
 */
export function legacyNativeEmployeeModelReplacementV1(
  member: Pick<RoomChannelMember, "id" | "employeeDefinitionId" | "kernel" | "model" | "userOverrides">,
): string | undefined {
  const model = member.model.trim();
  if (model && model !== LEGACY_NATIVE_MODEL_ID) return undefined;
  if (!isBridgeKernelId(member.kernel)) return undefined;

  const productRuntime = productEmployeeRuntimeDefault(member.employeeDefinitionId ?? member.id);
  if (productRuntime?.kernel === member.kernel) return productRuntime.model;
  return productDefaultModelForKernel(member.kernel);
}

export function migrateLegacyNativeEmployeeModelsV1(
  rooms: RoomChannelStore,
  options: { beforeApply?: () => void } = {},
): boolean {
  const replacements = rooms.listMembers().flatMap((member) => {
    const model = legacyNativeEmployeeModelReplacementV1(member);
    return model && model !== member.model ? [{ member, model }] : [];
  });
  if (!replacements.length) return false;
  options.beforeApply?.();
  for (const { member, model } of replacements) {
    const userOverrides = member.userOverrides?.filter((field) => field !== "model");
    rooms.upsertMember(
      {
        ...member,
        model,
        userOverrides: userOverrides?.length ? userOverrides : undefined,
      },
      { emitEvent: true },
    );
  }
  return true;
}
