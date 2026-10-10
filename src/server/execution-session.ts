import type { BridgeState } from "./bridge-types.js";

/** Preserve native resume handles produced by a scoped worker in the authoritative Host store. */
export function syncExecutionSessionMetadata(
  state: BridgeState,
  executionState: BridgeState | undefined,
  sessionId: string,
): void {
  if (!executionState || executionState.app === state.app) return;
  const session = executionState.app.sessions.get(sessionId);
  if (!session?.metadata || Object.keys(session.metadata).length === 0) return;
  state.app.sessions.ensureSession({
    id: sessionId,
    activity: session.activity,
    metadata: {
      ...state.app.sessions.get(sessionId)?.metadata,
      ...session.metadata,
    },
  });
}
