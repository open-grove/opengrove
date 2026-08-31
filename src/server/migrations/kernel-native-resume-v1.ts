import type { ApprovalResume } from "../../core.js";
import type { PersistedAgentState } from "../../storage/json-state-store.js";

const OLD_NATIVE_RESUME_TYPES: ReadonlyMap<string, string> = new Map([
  ["codex.native", "codex"],
  ["claude.native", "claude-code"],
  ["pi.native", "pi"],
  ["hermes.native", "hermes"],
] as const);

/**
 * Issue: https://github.com/open-grove/opengrove/issues/581
 * Supports: OpenGrove <=0.6.1 approvals and questions using per-Kernel *.native resume types.
 * Remove when: OpenGrove 0.7.0 requires direct upgrades from >=0.6.2; older backups move to the standalone importer.
 */
export function migrateKernelNativeResumesV1(input: PersistedAgentState): {
  state: PersistedAgentState;
  changed: boolean;
  migratedResumeCount: number;
} {
  let migratedResumeCount = 0;
  const migrateCollection = <T>(items: T[]): T[] => items.map((item) => migrateValue(item) as T);

  function migrateValue(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) return value.map((item) => migrateValue(item));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (key === "resume") {
      const migrated = migrateKernelNativeResumeV1(object);
      if (migrated !== object) {
        migratedResumeCount += 1;
        return migrated;
      }
    }
    return Object.fromEntries(
      Object.entries(object).map(([childKey, child]) => [childKey, migrateValue(child, childKey)]),
    );
  }

  const state: PersistedAgentState = {
    ...input,
    approvals: migrateCollection(input.approvals),
    questions: migrateCollection(input.questions),
    events: migrateCollection(input.events),
  };
  return migratedResumeCount
    ? { state, changed: true, migratedResumeCount }
    : { state: input, changed: false, migratedResumeCount: 0 };
}

export function migrateKernelNativeResumeV1(input: Record<string, unknown>): Record<string, unknown> | ApprovalResume {
  const type = typeof input.type === "string" ? input.type : "";
  const kernelId = OLD_NATIVE_RESUME_TYPES.get(type);
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!kernelId || !runId) return input;
  return {
    type: "kernel.native",
    kernelId,
    runId,
    continuation: "same-loop",
  };
}
