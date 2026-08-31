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

  if (request.method === "GET" && url.pathname === "/approvals") {
    const status = url.searchParams.get("status");
    const approvals = presentApprovalSummaries(
      (status === "pending" || status === "approved" || status === "rejected"
        ? state.app.approvals.list(status)
        : state.app.approvals.list()
      )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, readPendingLimit(url)),
    );
    sendJson(response, 200, { ok: true, approvals });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/questions") {
    const status = url.searchParams.get("status");
    const questions = presentQuestionSummaries(
      (status === "pending" || status === "answered" || status === "declined"
        ? state.app.questions.list(status)
        : state.app.questions.list()
      )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, readPendingLimit(url)),
    );
    sendJson(response, 200, { ok: true, questions });
    return true;
  }

  const approvalAction = url.pathname.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && approvalAction) {
    const [, approvalId, action] = approvalAction;
    const body = record(await readJsonBody(request));
    const result = await resolveApproval(
      state,
      decodeURIComponent(approvalId!),
      action === "approve" ? "approved" : "rejected",
      body.response as JsonValue | undefined,
    );
    sendJson(response, 200, result);
    return true;
  }

  const questionAction = url.pathname.match(/^\/questions\/([^/]+)\/(answer|decline)$/);
  if (request.method === "POST" && questionAction) {
    const [, questionId, action] = questionAction;
    const body = record(await readJsonBody(request));
    const result = await resolveQuestion(
      state,
      decodeURIComponent(questionId!),
      action === "answer" ? "answered" : "declined",
      body.response as JsonValue | undefined,
    );
    sendJson(response, 200, result);
    return true;
  }

  return false;
}

function readPendingLimit(url: URL): number {
  const requested = Number(url.searchParams.get("limit") ?? 100);
  return Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 500) : 100;
}
