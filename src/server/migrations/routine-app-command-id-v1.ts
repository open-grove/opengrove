import type { JsonObject, RoutineStep } from "../../core.js";
import { resolveMountedAppCliCommandId } from "../app-cli-env.js";
import type { BridgeState } from "../bridge-types.js";

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 Routines using input.command instead of commandId.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export function migrateRoutineAppCommandIdsV1(
  state: BridgeState,
  options: { beforeApply?: () => void } = {},
): {
  changed: boolean;
  migratedRoutineIds: string[];
  unresolvedRoutineIds: string[];
} {
  const migratedRoutineIds: string[] = [];
  const unresolvedRoutineIds: string[] = [];
  const updates: Array<{
    routineId: string;
    steps: RoutineStep[];
    unresolved: boolean;
  }> = [];
  for (const routine of state.app.routines.list()) {
    let changed = false;
    let unresolved = false;
    const steps = routine.steps.map((step) => {
      const migrated = migrateRoutineAppCommandStepV1(step, (appId, command) =>
        resolveMountedAppCliCommandId(state, appId, command),
      );
      changed = migrated.changed || changed;
      unresolved = migrated.unresolved || unresolved;
      return migrated.step;
    });
    if (!changed && (!unresolved || routine.status === "needs_repair")) continue;
    updates.push({ routineId: routine.id, steps, unresolved });
    if (changed) migratedRoutineIds.push(routine.id);
    if (unresolved) unresolvedRoutineIds.push(routine.id);
  }
  if (updates.length) options.beforeApply?.();
  for (const update of updates) {
    state.app.routines.update(update.routineId, {
      steps: update.steps,
      ...(update.unresolved ? { status: "needs_repair" } : {}),
    });
  }
  return {
    changed: updates.length > 0,
    migratedRoutineIds,
    unresolvedRoutineIds,
  };
}

export function migrateRoutineAppCommandStepV1(
  step: RoutineStep,
  resolveCommandId: (appId: string, command: string) => string | undefined,
): {
  step: RoutineStep;
  changed: boolean;
  unresolved: boolean;
} {
  if (step.toolId !== "opengrove.app.command.run") return { step, changed: false, unresolved: false };
  const input = record(step.input);
  if (stringValue(input.commandId) || !stringValue(input.command)) {
    return { step, changed: false, unresolved: false };
  }
  const appId = stringValue(input.appId);
  const commandId = appId ? resolveCommandId(appId, stringValue(input.command)) : undefined;
  if (!commandId) return { step, changed: false, unresolved: true };
  const { command: _command, ...currentInput } = input;
  return {
    step: {
      ...step,
      input: { ...currentInput, commandId } as JsonObject,
    },
    changed: true,
    unresolved: false,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
