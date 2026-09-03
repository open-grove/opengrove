import { randomUUID } from "node:crypto";

export function resolveRuntimeRunId(requestedRunId?: string, prefix = "run"): string {
  return requestedRunId ?? `${prefix}_${randomUUID()}`;
}
