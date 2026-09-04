import { askCancelContract, askCompactContract, askGuideContract } from "#agent-protocol";
import {
  cancelBackgroundAskRun,
  compactBackgroundAskSession,
  guideBackgroundAskRun,
  streamAskResponse,
  streamExistingAskResponse,
} from "../ask-stream.js";
import { record } from "../http-utils.js";
import { normalizeAskPayload } from "../payloads.js";
import { readWwRuntimeAuth } from "../bridge-security.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { hostMessage } from "../../localization/host-messages.js";
import type { BridgeRoute, BridgeRouteContext } from "../router.js";
import { route } from "./registry-utils.js";

export function createAskRoutes(): BridgeRoute[] {
  return [
    route("ask-disabled", "POST", "/ask", handleAskDisabledRoute),
    route("ask-stream-start", "POST", "/ask/stream", handleAskStreamRoute),
    route("ask-stream-existing", "GET", "/ask/stream", handleExistingAskStreamRoute),
    route("ask-cancel", "POST", "/ask/cancel", handleAskCancelRoute, askCancelContract),
    route("ask-guide", "POST", "/ask/guide", handleAskGuideRoute, askGuideContract),
    route("ask-compact", "POST", "/ask/compact", handleAskCompactRoute, askCompactContract),
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

async function handleAskCancelRoute(context: BridgeRouteContext): Promise<boolean> {
  const body = record(await context.readJsonBody(context.request));
  const cancelled = cancelBackgroundAskRun(context.state, {
    runId: typeof body.runId === "string" ? body.runId : undefined,
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
  });
  context.sendJson(context.response, 200, { ok: true, cancelled });
  return true;
}

async function handleAskGuideRoute(context: BridgeRouteContext): Promise<boolean> {
  const body = record(await context.readJsonBody(context.request));
  const result = await guideBackgroundAskRun(context.state, {
    runId: typeof body.runId === "string" ? body.runId : undefined,
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
    instruction: typeof body.instruction === "string" ? body.instruction : undefined,
  });
  context.sendJson(context.response, 200, result);
  return true;
}

async function handleAskCompactRoute(context: BridgeRouteContext): Promise<boolean> {
  const body = record(await context.readJsonBody(context.request));
  const result = await compactBackgroundAskSession(context.state, {
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  });
  context.sendJson(context.response, 200, result);
  return true;
}
