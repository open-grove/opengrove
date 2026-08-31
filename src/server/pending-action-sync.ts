import type { AgentEvent } from "../core.js";
import type { BridgeState } from "./bridge-types.js";

export function syncPendingActionEventToApp(app: BridgeState["app"], event: AgentEvent): void {
  if (event.type === "approval.requested" || event.type === "approval.resolved") {
    app.approvals.upsert(event.request);
  }
  if (event.type === "question.requested" || event.type === "question.answered") {
    app.questions.upsert(event.question);
  }
}

export function isPendingActionEvent(event: AgentEvent): boolean {
  return (
    event.type === "approval.requested" ||
    event.type === "approval.resolved" ||
    event.type === "question.requested" ||
    event.type === "question.answered"
  );
}
