import { findClientToolCalls } from "../client-tool-calls.js";
import type { listClientToolCallsOperation, resolveClientToolCallOperation } from "#protocol";
import type { StartDirectRunOperation, getDirectRunResultOperation } from "#protocol";
import { normalizeWorkspaceRootValue } from "../workspace-root.js";
import type { CancelDirectRunOperation, GuideDirectRunOperation, CompactDirectSessionOperation } from "#protocol";
import { hostContractById } from "#protocol/compiled";
import {
  submitDirectRun,
  isDirectRunActive,
  cancelBackgroundAskRun,
  compactBackgroundAskSession,
  guideBackgroundAskRun,
  streamAskResponse,
  streamExistingAskResponse,
} from "../ask-stream.js";
import { normalizeAskPayload } from "../payloads.js";
import { readWwRuntimeAuth } from "../bridge-security.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { hostMessage } from "../../localization/host-messages.js";
import type { BridgeRoute, BridgeRouteContext, HostOperationRouteContext } from "../router.js";
import { route, operationRoute } from "./registry-utils.js";

export function createAskRoutes(): BridgeRoute[] {
  return [
    operationRoute(hostContractById["run.direct.result"], handleDirectRunResult),
    operationRoute(hostContractById["run.tool.list"], handleListClientTools),
    operationRoute(hostContractById["run.tool.resolve"], handleResolveClientTool),
    operationRoute(hostContractById["run.direct.start"], handleStartDirectRun),
    route("ask-disabled", "POST", "/ask", handleAskDisabledRoute),
    route("ask-stream-start", "POST", "/ask/stream", handleAskStreamRoute),
    route("ask-stream-existing", "GET", "/ask/stream", handleExistingAskStreamRoute),
    operationRoute(hostContractById["run.direct.cancel"], handleAskCancelRoute),
    operationRoute(hostContractById["run.direct.guide"], handleAskGuideRoute),
    operationRoute(hostContractById["run.direct.compact"], handleAskCompactRoute),
  ];
}

function handleAskDisabledRoute(context: BridgeRouteContext): boolean {
  context.sendJson(context.response, 409, {
    ok: false,
    error: "ask_stream_required",
    message:
      "POST /ask is disabled because approval and user-input pauses require streaming events. Use POST /ask/stream.",
  });
  return true;
}

async function handleAskStreamRoute(context: BridgeRouteContext): Promise<boolean> {
  const payload = normalizeAskPayload(await context.readJsonBody(context.request));
  const wwAuth = (await readWwRuntimeAuth(context.request, context.response, context.security))?.auth;
  try {
    await streamAskResponse(context.state, payload, context.response, {
      ...(wwAuth ? { wwAuth } : {}),
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "bridge_runs_paused_for_storage_maintenance") throw error;
    context.response.setHeader("retry-after", "1");
    context.sendJson(context.response, 503, {
      ok: false,
      code: error.message,
      error: hostMessage(
        resolveHostLanguageSettings((context.state.rootState ?? context.state).settings),
        "room.run_paused_for_maintenance",
      ),
    });
  }
  return true;
}

async function handleExistingAskStreamRoute(context: BridgeRouteContext): Promise<boolean> {
  await streamExistingAskResponse(
    context.state,
    {
      runId: context.url.searchParams.get("runId") || undefined,
      threadId: context.url.searchParams.get("threadId") || undefined,
    },
    context.response,
  );
  return true;
}

async function handleAskCancelRoute(context: HostOperationRouteContext<CancelDirectRunOperation>): Promise<true> {
  const cancelled = cancelBackgroundAskRun(context.state, context.input.body);
  context.sendJson(context.response, 200, { ok: true, cancelled });
  return true;
}

async function handleAskGuideRoute(context: HostOperationRouteContext<GuideDirectRunOperation>): Promise<true> {
  const result = await guideBackgroundAskRun(context.state, context.input.body);
  context.sendJson(context.response, 200, result);
  return true;
}

async function handleAskCompactRoute(context: HostOperationRouteContext<CompactDirectSessionOperation>): Promise<true> {
  const result = await compactBackgroundAskSession(context.state, context.input.body);
  context.sendJson(context.response, 200, result);
  return true;
}

async function handleStartDirectRun(context: HostOperationRouteContext<StartDirectRunOperation>): Promise<true> {
  const input = context.input.body;
  const workspaceRoot = input.workspaceRoot ? normalizeWorkspaceRootValue(input.workspaceRoot) : undefined;
  if (input.workspaceRoot && !workspaceRoot) {
    context.sendJson(context.response, 400, { ok: false, error: "workspace_directory_not_found" });
    return true;
  }
  const payload = normalizeAskPayload({
    question: input.input,
    threadId: input.sessionId,
    kernel: input.kernel,
    model: input.model,
    providerId: input.providerId,
    effort: input.effort,
    accessMode: input.accessMode,
    planMode: input.planMode,
    allowMemory: false,
    saveCandidateNote: false,
    snapshot: {
      title: "Added context",
      locator: "standalone-ui",
      selection: typeof input.context === "string" ? input.context : input.context ? JSON.stringify(input.context) : "",
      attachments: input.attachments,
    },
  });
  if (new Set(input.tools.map((tool) => tool.id)).size !== input.tools.length) {
    context.sendJson(context.response, 400, { ok: false, error: "duplicate_client_tool_id" });
    return true;
  }
  payload.clientTools = input.tools;
  payload.allowedHostToolIds = input.skills.length ? ["skill.invoke"] : [];
  payload.workspaceRoot = workspaceRoot;
  payload.sessionInstructions = input.instructions;
  payload.availableSkillNames = input.skills;
  const wwAuth = (await readWwRuntimeAuth(context.request, context.response, context.security))?.auth;
  try {
    const submitted = submitDirectRun(context.state, payload, { ...(wwAuth ? { wwAuth } : {}) });
    context.sendJson(context.response, 202, { ok: true, ...submitted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message === "session_busy" || message === "session_configuration_conflict"
        ? 409
        : message === "bridge_runs_paused_for_storage_maintenance"
          ? 503
          : 400;
    context.sendJson(context.response, status, { ok: false, error: message });
  }
  return true;
}

function handleListClientTools(context: HostOperationRouteContext<typeof listClientToolCallsOperation>): true {
  const broker = findClientToolCalls(context.state, context.input.params.runId);
  if (!broker) context.sendJson(context.response, 404, { ok: false, error: "run_not_live" });
  else context.sendJson(context.response, 200, { ok: true, calls: broker.list() });
  return true;
}
function handleResolveClientTool(context: HostOperationRouteContext<typeof resolveClientToolCallOperation>): true {
  const broker = findClientToolCalls(context.state, context.input.params.runId);
  const result = broker?.resolve(context.input.params.callId, context.input.body.result) ?? "missing";
  if (result === "accepted") context.sendJson(context.response, 200, { ok: true });
  else
    context.sendJson(context.response, result === "missing" ? 404 : 409, {
      ok: false,
      error: result === "missing" ? "tool_call_not_found" : "tool_call_not_pending",
    });
  return true;
}

function handleDirectRunResult(context: HostOperationRouteContext<typeof getDirectRunResultOperation>): true {
  const run = context.state.app.sessions.getRun(context.input.params.runId);
  if (!run) {
    context.sendJson(context.response, 404, { ok: false, error: "run_not_found" });
    return true;
  }
  const artifact = context.state.app.artifacts.get(`run-result:${run.id}`);
  const answer = artifact?.data.answer;
  context.sendJson(context.response, 200, {
    ok: true,
    run,
    finalized: !isDirectRunActive(context.state, run.id),
    answer: typeof answer === "string" ? answer : "",
    outputAvailable: typeof answer === "string",
    ...(artifact ? { artifactId: artifact.id } : {}),
  });
  return true;
}
