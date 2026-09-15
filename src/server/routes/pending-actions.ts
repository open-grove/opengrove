import type {
  ListApprovalsOperation,
  ListQuestionsOperation,
  ApprovalDecisionOperation,
  QuestionDecisionOperation,
} from "#protocol";
import { hostContractById } from "#protocol/compiled";
import type { HostOperationRouteContext, BridgeRoute } from "../router.js";
import { operationRoute } from "./registry-utils.js";
import { resolveApproval } from "../approval-actions.js";
import { resolveQuestion } from "../question-actions.js";
import { presentApprovalSummaries, presentQuestionSummaries } from "../state-presentation.js";

export function createPendingActionRoutes(): BridgeRoute[] {
  return [
    operationRoute(hostContractById["interaction.approval.list"], handleListApprovalsOperation),
    operationRoute(hostContractById["interaction.question.list"], handleListQuestionsOperation),
    operationRoute(hostContractById["interaction.approval.approve"], (context) =>
      handleApprovalDecision(context, "approved"),
    ),
    operationRoute(hostContractById["interaction.approval.reject"], (context) =>
      handleApprovalDecision(context, "rejected"),
    ),
    operationRoute(hostContractById["interaction.approval.cancel"], (context) =>
      handleApprovalDecision(context, "canceled"),
    ),
    operationRoute(hostContractById["interaction.question.answer"], (context) =>
      handleQuestionDecision(context, "answered"),
    ),
    operationRoute(hostContractById["interaction.question.decline"], (context) =>
      handleQuestionDecision(context, "declined"),
    ),
    operationRoute(hostContractById["interaction.question.cancel"], (context) =>
      handleQuestionDecision(context, "canceled"),
    ),
  ];
}

async function handleApprovalDecision(
  context: HostOperationRouteContext<ApprovalDecisionOperation>,
  status: "approved" | "rejected" | "canceled",
): Promise<true> {
  const result = await resolveApproval(
    context.state,
    context.input.params.approvalId,
    status,
    context.input.body.response,
  );
  context.sendJson(context.response, 200, result);
  return true;
}
async function handleQuestionDecision(
  context: HostOperationRouteContext<QuestionDecisionOperation>,
  status: "answered" | "declined" | "canceled",
): Promise<true> {
  const result = await resolveQuestion(
    context.state,
    context.input.params.questionId,
    status,
    context.input.body.response,
  );
  context.sendJson(context.response, 200, result);
  return true;
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
