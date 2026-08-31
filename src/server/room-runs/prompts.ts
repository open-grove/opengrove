import { type RoomChannelMember } from "../../rooms/channel-store.js";
import type { BridgeRuntimeControls } from "../bridge-types.js";

export function requiredRoomSkillNames(target: Pick<RoomChannelMember, "defaultSkillIds">): string[] {
  return [...new Set((target.defaultSkillIds ?? []).map((skillId) => skillId.trim()).filter(Boolean))];
}

export function availableRoomSkillNames(
  target: Pick<RoomChannelMember, "availableSkillIds" | "defaultSkillIds">,
): string[] {
  return [
    ...new Set(
      [...(target.availableSkillIds ?? []), ...(target.defaultSkillIds ?? [])]
        .map((skillId) => skillId.trim())
        .filter(Boolean),
    ),
  ];
}

export function roomRunPolicy(_target: RoomChannelMember, _prompt: string) {
  return undefined;
}

export function roomRunResponseSpeed() {
  return "fast" as const;
}

export function roomRunRequestedEffort(
  target: RoomChannelMember,
  _prompt: string,
  controls?: Pick<BridgeRuntimeControls, "reasoningEfforts" | "defaultReasoningEffort">,
): string | undefined {
  const userChoice = target.manifestDefaults
    ? target.userOverrides?.includes("reasoningEffort")
      ? target.reasoningEffort
      : undefined
    : target.reasoningEffort;
  if (userChoice) return userChoice;

  const appDefault = target.manifestDefaults?.reasoningEffort;
  if (!controls) return appDefault ?? "medium";

  const supported = new Set(controls.reasoningEfforts.map((option) => option.id));
  if (appDefault && supported.has(appDefault)) return appDefault;
  if (controls.defaultReasoningEffort && supported.has(controls.defaultReasoningEffort)) {
    return controls.defaultReasoningEffort;
  }
  if (supported.has("medium")) return "medium";
  return controls.reasoningEfforts[0]?.id;
}
