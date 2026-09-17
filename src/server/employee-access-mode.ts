import type { RoomChannelMember, RoomChannelStore } from "../rooms/channel-store.js";
import { resolveRuntimeAccessModeSelection, runtimeAccessIssue } from "../runtime-access.js";
import type { RuntimeAccessMode } from "../core.js";

export function normalizeEmployeeAccessMode(kernel: string, requested: unknown) {
  const accessMode = resolveRuntimeAccessModeSelection(kernel, requested ?? undefined);
  if (typeof requested === "string" && requested !== accessMode) {
    console.warn("employee_access_mode_normalized", { kernel, requested, accessMode });
  }
  return accessMode;
}

/** Validate a new selection at write boundaries without rewriting saved preferences. */
export function employeeAccessModeIssue(kernel: string, mode: RuntimeAccessMode | undefined) {
  if (!mode || mode === "default") return undefined;
  return runtimeAccessIssue(kernel, mode);
}

/** Persist runtime recovery separately from user overrides; stale turns cannot replace newer choices. */
export function applyEmployeeAutoReviewFallback(rooms: RoomChannelStore, captured: RoomChannelMember): boolean {
  if (captured.kernel !== "claude-code" || captured.source === "remote") return false;
  const current = rooms.listMembers().find((member) => member.id === captured.id);
  const matches = (member: RoomChannelMember) =>
    member.source !== "remote" &&
    member.kernel === captured.kernel &&
    member.model === captured.model &&
    member.providerId === captured.providerId &&
    member.accessMode === "auto-review";
  if (!current || !matches(current)) return false;
  const definitionId = current.employeeDefinitionId;
  for (const member of rooms.listMembers()) {
    if (member.id !== current.id && (!definitionId || member.employeeDefinitionId !== definitionId)) continue;
    if (matches(member)) rooms.patchMember(member.id, { accessMode: "default" });
  }
  return true;
}
