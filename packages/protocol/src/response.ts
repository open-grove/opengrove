import type { z } from "zod";
import { bridgeContractIssues, type BridgeContractIssue } from "./contract.js";
import type { HostOperation } from "./operation.js";

export interface SkippedRoomMessages {
  operationId: string;
  skippedCount: number;
  issues: BridgeContractIssue[];
}

// List reads may omit damaged messages without changing the stored records.
// Keep this policy at both HTTP boundaries; writes and envelope errors stay strict.
// Rooms and members define the snapshot structure: skipping them could hide
// entire conversations or participants, so their errors still reject the snapshot.
export function parseHostOperationResponse(
  operation: HostOperation,
  schema: z.ZodType,
  value: unknown,
): { result: ReturnType<z.ZodType["safeParse"]>; skipped?: SkippedRoomMessages } {
  const result = schema.safeParse(value);
  if (
    result.success ||
    schema !== operation.success.body ||
    operation.method !== "GET" ||
    (operation.id !== "room.room.list" && operation.id !== "room.message.list") ||
    !value ||
    typeof value !== "object" ||
    !("messages" in value) ||
    !Array.isArray(value.messages)
  ) {
    return { result };
  }

  const invalidIndices = new Set<number>();
  for (const issue of result.error.issues) {
    const [field, index] = issue.path;
    if (field !== "messages" || typeof index !== "number" || !Number.isInteger(index)) return { result };
    invalidIndices.add(index);
  }
  if (invalidIndices.size === 0) return { result };

  const recovered = schema.safeParse({
    ...value,
    messages: value.messages.filter((_message, index) => !invalidIndices.has(index)),
  });
  if (!recovered.success) return { result };
  return {
    result: recovered,
    skipped: {
      operationId: operation.id,
      skippedCount: invalidIndices.size,
      issues: bridgeContractIssues(result.error),
    },
  };
}
