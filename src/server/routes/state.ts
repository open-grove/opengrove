import { createHash } from "node:crypto";
import { createAnnotationArtifact, createComputerSnapshotArtifact } from "../artifact-actions.js";
import { syncBridgeWorkingState } from "../bridge-working-state.js";
import {
  isActivitySpace,
  isExecutionKind,
  isMemoryScope,
  isRunStatus,
  isSessionStatus,
  normalizeArtifactAnnotationPayload,
  normalizeArtifactCreatePayload,
  normalizeArtifactPatchPayload,
  normalizeComputerStatePatchPayload,
  normalizeMemoryPatchPayload,
  normalizeWorkingStatePatchPayload,
} from "../payloads.js";
import type { BridgeRoute, BridgeRouteContext } from "../router.js";
import { route } from "./registry-utils.js";
import { resolveHostLanguageSettings } from "../language-preference.js";
import { presentAgentEvent } from "../event-presentation.js";
import { readLongPollWaitMs, waitForLongPoll } from "../long-poll.js";
import { presentArtifactSummaries, presentArtifactSummary } from "../artifact-presentation.js";
import {
  presentExecutionSummaries,
  presentRunSummaries,
  presentSessionSummaries,
  presentWorkingState,
} from "../state-presentation.js";

export function createStateRoutes(): BridgeRoute[] {
  return [
    route("memory-list", "GET", "/memory", handleMemoryListRoute),
    route("artifacts-list", "GET", "/artifacts", handleArtifactsListRoute),
    route("artifact-item-content", "GET", /^\/artifacts\/([^/]+)\/content$/, handleArtifactItemContentRoute),
    route("artifact-item-read", "GET", /^\/artifacts\/([^/]+)$/, handleArtifactItemReadRoute),
    route("working-state-read", "GET", "/working-state", handleWorkingStateReadRoute),
    route("computer-state-read", "GET", "/computer-state", handleComputerStateReadRoute),
    route("sessions-list", "GET", "/sessions", handleSessionsListRoute),
    route("runs-list", "GET", "/runs", handleRunsListRoute),
    route("executions-list", "GET", "/executions", handleExecutionsListRoute),
    route("memory-item-delete", "DELETE", /^\/memory\/([^/]+)$/, handleMemoryItemRoute),
    route("memory-item-patch", "PATCH", /^\/memory\/([^/]+)$/, handleMemoryItemRoute),
    route("artifacts-create", "POST", "/artifacts", handleArtifactsCreateRoute),
    route("artifact-item-patch", "PATCH", /^\/artifacts\/([^/]+)$/, handleArtifactItemRoute),
    route("artifact-item-delete", "DELETE", /^\/artifacts\/([^/]+)$/, handleArtifactItemRoute),
    route("artifact-annotation", "POST", /^\/artifacts\/([^/]+)\/annotation$/, handleArtifactAnnotationRoute),
    route("working-state-patch", "PATCH", "/working-state", handleWorkingStatePatchRoute),
    route("computer-state-patch", "PATCH", "/computer-state", handleComputerStatePatchRoute),
    route("events", "GET", "/events", handleEventsRoute),
  ];
}

function handleMemoryListRoute(context: BridgeRouteContext): boolean {
  const query = context.url.searchParams.get("query") ?? "";
  const scope = context.url.searchParams.get("scope") ?? "";
  const kind = context.url.searchParams.get("kind") ?? "";
  const limit = readBoundedLimit(context.url, 100, 500);
  const filter = {
    scope: isMemoryScope(scope) ? scope : undefined,
    kind: kind || undefined,
    limit,
  };
  const memory = query ? context.state.app.memory.search(query, filter) : context.state.app.memory.list(filter);
  context.sendJson(context.response, 200, { ok: true, memory });
  return true;
}

function handleArtifactsListRoute(context: BridgeRouteContext): boolean {
  const type = context.url.searchParams.get("type") ?? "";
  const ids = context.url.searchParams.getAll("id");
  const tags = context.url.searchParams.getAll("tag");
  const limit = readBoundedLimit(context.url, 100, 500);
  const artifacts = presentArtifactSummaries(
    context.state.app.artifacts.list({
      ids: ids.length ? ids : undefined,
      type: type || undefined,
      tags: tags.length ? tags : undefined,
      limit,
    }),
  );
  context.sendJson(context.response, 200, { ok: true, artifacts });
  return true;
}

function handleArtifactItemReadRoute(context: BridgeRouteContext): boolean {
  const match = context.url.pathname.match(/^\/artifacts\/([^/]+)$/);
  if (!match) return false;
  const artifact = context.state.app.artifacts.get(decodeURIComponent(match[1]!));
  if (!artifact) {
    context.sendJson(context.response, 404, { ok: false, error: "artifact_not_found" });
    return true;
  }
  context.sendJson(context.response, 200, { ok: true, artifact });
  return true;
}

function handleArtifactItemContentRoute(context: BridgeRouteContext): boolean {
  const match = context.url.pathname.match(/^\/artifacts\/([^/]+)\/content$/);
  if (!match) return false;
  const artifact = context.state.app.artifacts.get(decodeURIComponent(match[1]!));
  const uri =
    artifact &&
    (artifact.preview?.imageUri ||
      (typeof artifact.data.imageUri === "string" ? artifact.data.imageUri : undefined) ||
      (typeof artifact.data.uri === "string" ? artifact.data.uri : undefined) ||
      artifact.assets?.find((asset) => asset.uri?.startsWith("data:"))?.uri);
  const data = uri ? decodeArtifactDataUri(uri) : undefined;
  if (!data) {
    context.sendJson(context.response, 404, { ok: false, error: "artifact_content_not_found" });
    return true;
  }
  context.response.writeHead(200, {
    "content-type": data.mimeType,
    "content-length": String(data.body.length),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  context.response.end(data.body);
  return true;
}

function decodeArtifactDataUri(uri: string): { mimeType: string; body: Buffer } | undefined {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(uri);
  if (!match) return undefined;
  const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(match[1]!) ? match[1]! : "application/octet-stream";
  try {
    return {
      mimeType,
      body: match[2]
        ? Buffer.from(match[3]!.replace(/\s/g, ""), "base64")
        : Buffer.from(decodeURIComponent(match[3]!), "utf8"),
    };
  } catch {
    return undefined;
  }
}

function handleWorkingStateReadRoute(context: BridgeRouteContext): boolean {
  context.sendJson(context.response, 200, { ok: true, workingState: context.state.app.workingState.get() });
  return true;
}

function handleComputerStateReadRoute(context: BridgeRouteContext): boolean {
  context.sendJson(context.response, 200, { ok: true, computerState: context.state.computerSnapshot });
  return true;
}

function handleSessionsListRoute(context: BridgeRouteContext): boolean {
  const status = context.url.searchParams.get("status") ?? "";
  const activity = context.url.searchParams.get("activity") ?? "";
  const limit = readBoundedLimit(context.url, 100, 500);
  context.sendJson(context.response, 200, {
    ok: true,
    sessions: context.state.app.sessions.list({
      status: isSessionStatus(status) ? status : undefined,
      activity: isActivitySpace(activity) ? activity : undefined,
      limit,
    }),
  });
  return true;
}

function handleRunsListRoute(context: BridgeRouteContext): boolean {
  const sessionId = context.url.searchParams.get("sessionId") ?? "";
  const status = context.url.searchParams.get("status") ?? "";
  const limit = readBoundedLimit(context.url, 200, 1_000);
  const revision = `${context.state.app.sessions.revision()}:runs:${sessionId}:${status}:${limit}`;
  if (context.url.searchParams.get("afterRevision") === revision) {
    context.sendJson(context.response, 200, { ok: true, unchanged: true, revision });
    return true;
  }
  context.sendJson(context.response, 200, {
    ok: true,
    runs: context.state.app.sessions.listRuns({
      sessionId: sessionId || undefined,
      status: isRunStatus(status) ? status : undefined,
      limit,
    }),
    revision,
  });
  return true;
}

function handleExecutionsListRoute(context: BridgeRouteContext): boolean {
  const sessionId = context.url.searchParams.get("sessionId") ?? "";
  const runId = context.url.searchParams.get("runId") ?? "";
  const kind = context.url.searchParams.get("kind") ?? "";
  const limit = readBoundedLimit(context.url, 200, 1_000);
  const revision = `${context.state.app.executions.revision()}:executions:${sessionId}:${runId}:${kind}:${limit}`;
  if (context.url.searchParams.get("afterRevision") === revision) {
    context.sendJson(context.response, 200, { ok: true, unchanged: true, revision });
    return true;
  }
  context.sendJson(context.response, 200, {
    ok: true,
    executions: context.state.app.executions.list({
      sessionId: sessionId || undefined,
      runId: runId || undefined,
      kind: isExecutionKind(kind) ? kind : undefined,
      limit,
    }),
    revision,
  });
  return true;
}

async function handleMemoryItemRoute(context: BridgeRouteContext): Promise<boolean> {
  const memoryAction = context.url.pathname.match(/^\/memory\/([^/]+)$/);
  if (!memoryAction) return false;
  const [, memoryId] = memoryAction;
  if (context.request.method === "DELETE") {
    const deleted = context.state.app.memory.delete(decodeURIComponent(memoryId!));
    context.state.store.saveFrom(context.state.app);
    context.sendJson(context.response, 200, {
      ok: true,
      deleted,
      memory: context.state.app.memory.list({ limit: 100 }),
    });
    return true;
  }
  if (context.request.method === "PATCH") {
    const patch = normalizeMemoryPatchPayload(await context.readJsonBody(context.request));
    const memory = context.state.app.memory.update(decodeURIComponent(memoryId!), patch);
    context.state.store.saveFrom(context.state.app);
    context.sendJson(context.response, 200, {
      ok: true,
      memory,
      memories: context.state.app.memory.list({ limit: 100 }),
    });
    return true;
  }
  return false;
}

async function handleArtifactsCreateRoute(context: BridgeRouteContext): Promise<boolean> {
  const artifact = context.state.app.artifacts.create(
    normalizeArtifactCreatePayload(await context.readJsonBody(context.request)),
  );
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, {
    ok: true,
    artifact: presentArtifactSummary(artifact),
    artifacts: presentArtifactSummaries(context.state.app.artifacts.list({ limit: 100 })),
  });
  return true;
}

async function handleArtifactItemRoute(context: BridgeRouteContext): Promise<boolean> {
  const artifactAction = context.url.pathname.match(/^\/artifacts\/([^/]+)$/);
  if (!artifactAction) return false;
  const [, artifactId] = artifactAction;
  if (context.request.method === "PATCH") {
    const artifact = context.state.app.artifacts.update(
      decodeURIComponent(artifactId!),
      normalizeArtifactPatchPayload(await context.readJsonBody(context.request)),
    );
    context.state.store.saveFrom(context.state.app);
    context.sendJson(context.response, 200, {
      ok: true,
      artifact: presentArtifactSummary(artifact),
      artifacts: presentArtifactSummaries(context.state.app.artifacts.list({ limit: 100 })),
    });
    return true;
  }
  if (context.request.method === "DELETE") {
    const deleted = context.state.app.artifacts.delete(decodeURIComponent(artifactId!));
    context.state.store.saveFrom(context.state.app);
    context.sendJson(context.response, 200, {
      ok: true,
      deleted,
      artifacts: presentArtifactSummaries(context.state.app.artifacts.list({ limit: 100 })),
    });
    return true;
  }
  return false;
}

async function handleArtifactAnnotationRoute(context: BridgeRouteContext): Promise<boolean> {
  const artifactAnnotationAction = context.url.pathname.match(/^\/artifacts\/([^/]+)\/annotation$/);
  if (!artifactAnnotationAction) return false;
  const [, artifactId] = artifactAnnotationAction;
  const artifact = createAnnotationArtifact(
    context.state.app,
    decodeURIComponent(artifactId!),
    normalizeArtifactAnnotationPayload(await context.readJsonBody(context.request)),
    resolveHostLanguageSettings(context.state.settings),
  );
  syncBridgeWorkingState(context.state.app);
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, {
    ok: true,
    artifact: presentArtifactSummary(artifact),
    artifacts: presentArtifactSummaries(context.state.app.artifacts.list({ limit: 100 })),
    workingState: presentWorkingState(context.state.app.workingState.get()),
    sessions: presentSessionSummaries(context.state.app.sessions.list({ limit: 12 })),
    runs: presentRunSummaries(context.state.app.sessions.listRuns({ limit: 24 })),
    executions: presentExecutionSummaries(context.state.app.executions.list({ limit: 40 })),
  });
  return true;
}

async function handleWorkingStatePatchRoute(context: BridgeRouteContext): Promise<boolean> {
  const workingState = context.state.app.workingState.update(
    normalizeWorkingStatePatchPayload(await context.readJsonBody(context.request)),
  );
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, { ok: true, workingState });
  return true;
}

async function handleComputerStatePatchRoute(context: BridgeRouteContext): Promise<boolean> {
  const payload = normalizeComputerStatePatchPayload(await context.readJsonBody(context.request));
  context.state.computerSnapshot = {
    ...context.state.computerSnapshot,
    ...payload.snapshot,
    elements: payload.snapshot.elements ?? context.state.computerSnapshot.elements ?? [],
  };
  const artifact = payload.recordArtifact
    ? createComputerSnapshotArtifact(context.state.app, context.state.computerSnapshot)
    : undefined;
  context.state.store.saveFrom(context.state.app);
  context.sendJson(context.response, 200, {
    ok: true,
    computerState: context.state.computerSnapshot,
    artifact: artifact ? presentArtifactSummary(artifact) : undefined,
    artifacts: presentArtifactSummaries(context.state.app.artifacts.list({ limit: 100 })),
    workingState: presentWorkingState(context.state.app.workingState.get()),
    sessions: presentSessionSummaries(context.state.app.sessions.list({ limit: 12 })),
    runs: presentRunSummaries(context.state.app.sessions.listRuns({ limit: 24 })),
    executions: presentExecutionSummaries(context.state.app.executions.list({ limit: 40 })),
  });
  return true;
}

async function handleEventsRoute(context: BridgeRouteContext): Promise<boolean> {
  const runIds = new Set(
    context.url.searchParams
      .getAll("runId")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const predicate = runIds.size
    ? (event: ReturnType<typeof context.state.app.events.list>[number]) =>
        typeof event.runId === "string" && runIds.has(event.runId)
    : undefined;
  const cursorScope = createHash("sha256")
    .update(JSON.stringify([...runIds].sort()))
    .digest("base64url")
    .slice(0, 16);
  const requestedLimit = Number(context.url.searchParams.get("limit") ?? 200);
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 1_000)) : 200;
  const cursor = context.url.searchParams.get("cursor")?.trim();
  const beforeCursor = context.url.searchParams.get("beforeCursor")?.trim();
  if (cursor && beforeCursor) {
    context.sendJson(context.response, 400, { ok: false, error: "event_cursor_conflict" });
    return true;
  }
  let result = beforeCursor
    ? context.state.app.events.eventsBefore(beforeCursor, limit, predicate, cursorScope)
    : cursor
      ? context.state.app.events.eventsAfter(cursor, limit, predicate, cursorScope)
      : context.state.app.events.latest(limit, predicate, cursorScope);
  const waitMs = readLongPollWaitMs(context.url);
  if (cursor && !beforeCursor && waitMs > 0 && !result.resetRequired && !result.hasMore && result.events.length === 0) {
    const events = context.state.app.events;
    const responseOpen = await waitForLongPoll(context.response, (signal) =>
      events.waitForEventsAfter(result.cursor, predicate, cursorScope, waitMs, signal),
    );
    if (!responseOpen) return true;
    result = context.state.app.events.eventsAfter(result.cursor, limit, predicate, cursorScope);
  }
  const snapshot = !cursor && !beforeCursor;
  context.sendJson(context.response, 200, {
    ok: true,
    ...result,
    events: result.events.map((event) => presentAgentEvent(event)),
    longPollSupported: true,
    snapshot,
  });
  return true;
}

function readBoundedLimit(url: URL, defaultLimit: number, maximumLimit: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim() === "") return defaultLimit;
  const requested = Number(raw);
  if (!Number.isSafeInteger(requested) || requested < 1) return defaultLimit;
  return Math.min(requested, maximumLimit);
}
