import type { JsonValue, RoutineStep } from "../core.js";

export function validateRoutineToolInput(step: Pick<RoutineStep, "toolId" | "roomId" | "input">): string | undefined {
  if (step.toolId === "room.ledger.read" && !routineStepRoomId(step)) {
    return "tool_input_invalid:room.ledger.read:room_id_required";
  }
  return undefined;
}

export function routineStepRoomId(step: Pick<RoutineStep, "roomId" | "input">): string {
  const directRoomId = typeof step.roomId === "string" ? step.roomId.trim() : "";
  if (directRoomId) return directRoomId;
  const inputRoomId = readInputRoomId(step.input);
  return inputRoomId;
}

function readInputRoomId(input: JsonValue | undefined): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const roomId = (input as Record<string, unknown>).roomId;
  return typeof roomId === "string" ? roomId.trim() : "";
}
