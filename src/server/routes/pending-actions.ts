import type { ListApprovalsOperation, ListQuestionsOperation } from "#protocol";
import type { HostOperationRouteContext } from "../router.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonValue } from "../../core.js";
import type { BridgeState } from "../bridge-types.js";
import { record } from "../http-utils.js";
import { resolveApproval } from "../approval-actions.js";
import { resolveQuestion } from "../question-actions.js";
import { presentApprovalSummaries, presentQuestionSummaries } from "../state-presentation.js";

type SendJson = (response: ServerResponse, status: number, data: unknown) => void;
type ReadJsonBody = (request: IncomingMessage) => Promise<unknown>;

export async function handlePendingActionsRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  sendJson: SendJson;
  readJsonBody: ReadJsonBody;
}): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = options;

  const approvalAction = url.pathname.match(/^\/approvals\/([^/]+)\/(approve|reject|cancel)$/);
  if (request.method === "POST" && approvalAction) {
    const [, approvalId, action] = approvalAction;
    const body = record(await readJsonBody(request));
    const result = await resolveApproval(
      state,
      decodeURIComponent(approvalId!),
      action === "approve" ? "approved" : action === "reject" ? "rejected" : "canceled",
      body.response as JsonValue | undefined,
    );
    sendJson(response, 200, result);
    return true;
  }

  const questionAction = url.pathname.match(/^\/questions\/([^/]+)\/(answer|decline|cancel)$/);
  if (request.method === "POST" && questionAction) {
    const [, questionId, action] = questionAction;
    const body = record(await readJsonBody(request));
    const result = await resolveQuestion(
      state,
      decodeURIComponent(questionId!),
      action === "answer" ? "answered" : action === "decline" ? "declined" : "canceled",
      body.response as JsonValue | undefined,
    );
    sendJson(response, 200, result);
    return true;
  }

  return false;
}

export function handleListApprovalsOperation(context: HostOperationRouteContext<ListApprovalsOperation>): true {
  const { status, limit } = context.input.query;
  const approvals = presentApprovalSummaries(
    context.state.app.approvals
      .list(status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit),
  );
  context.sendJson(context.response, 200, { ok: true, approvals });
  return true;
}

export function handleListQuestionsOperation(context: HostOperationRouteContext<ListQuestionsOperation>): true {
  const { status, limit } = context.input.query;
  const questions = presentQuestionSummaries(
    context.state.app.questions
      .list(status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit),
  );
  context.sendJson(context.response, 200, { ok: true, questions });
  return true;
}
