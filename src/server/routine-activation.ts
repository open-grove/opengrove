import type { JsonValue, ToolResult } from "../core.js";
import { runRoutine } from "../routines/routine-runner.js";
import type { BridgeState } from "./bridge-types.js";
import { createRoutineFlowInstanceObserver } from "./routine-flow-instance.js";
import { createRoutineProblemReporter } from "./routine-problems.js";
import { importRoutineFromKnowledgeOrContent } from "./routine-import.js";
import { createRoutineMemberExecutor } from "./routine-scheduler.js";

export async function activateRoutineWorkflow(
  state: BridgeState,
  input: { knowledgeId: string },
): Promise<ToolResult<JsonValue>> {
  const imported = importRoutineFromKnowledgeOrContent(state.app, { knowledgeId: input.knowledgeId });
  if (!imported.ok) {
    return {
      ok: false,
      error: imported.error,
    };
  }

  const result = await runRoutine(state.app, imported.routine.id, {
    memberExecutor: createRoutineMemberExecutor(state),
    problemReporter: createRoutineProblemReporter(state),
    statusObserver: createRoutineFlowInstanceObserver(state),
  });
  state.store.saveFrom(state.app);

  return {
    ok: true,
    value: {
      routineId: imported.routine.id,
      runId: result.summary.id,
      status: result.summary.status,
      ...(result.summary.error ? { error: result.summary.error } : {}),
    },
  };
}
