import type { RoutineProblemReporter } from "../routines/routine-runner.js";
import type { BridgeState } from "./bridge-types.js";
import { problemRef, recordProblem } from "./problem-records.js";

export function createRoutineProblemReporter(state: BridgeState, traceId?: string): RoutineProblemReporter {
  return (input) =>
    problemRef(
      recordProblem(state, {
        traceId,
        category: "employee-run",
        phase: input.phase,
        code: input.code,
        error: input.error,
        retryable: input.retryable,
        runId: input.runId,
        facts: input.facts,
      }),
    );
}
