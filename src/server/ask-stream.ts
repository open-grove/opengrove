import type { ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectAssistantText, type AgentEvent, type PolicyRule } from "../core.js";
import { createAgentEventCheckpointPolicy } from "../core/event-persistence.js";
import { hasComputerState } from "../environment/computer-adapter.js";
import type { BrowserPageAttachmentSnapshot, BrowserPageSnapshot } from "../environment/browser-adapter.js";
import type { BridgeAskPayload, BridgeAskResult, BridgeState } from "./bridge-types.js";
import { resolveAskExecutionState } from "./ask-execution-state.js";
import { extractMediaArtifactsFromEvents } from "./media-artifacts.js";
import { attachModelId, buildContextRecords, writeTrajectoryRecord } from "./trajectory.js";
import { syncBridgeWorkingState } from "./bridge-working-state.js";
import { runWithBridgeTurnContext, type BridgeTurnContext } from "./bridge-turn-context.js";
import { bridgeDataPath } from "./storage-paths.js";
import { resolveMountedAppRuntimeEnv } from "./app-runtime-env.js";
import type { BridgeWwRuntimeAuth } from "./ww-runtime-auth.js";
import { presentAgentEvent } from "./event-presentation.js";
import { presentArtifactCards, presentArtifactSummaries } from "./artifact-presentation.js";
import {
  presentApprovalSummaries,
  presentExecutionSummaries,
  presentQuestionSummaries,
  presentRunSummaries,
  presentSessionSummaries,
  presentWorkingState,
} from "./state-presentation.js";
import {
  blockWwApiKeyRecoveryForExecution,
  consumeWwRetryableTurnAttempt,
  recoverWwApiKeyForExecution,
  isWwApiKeyInvalidError,
} from "./ww-provider-recovery.js";
import {
  clearActiveBridgeRunExecutionState,
  registerActiveBridgeRun,
  registerActiveBridgeRunInteraction,
  setActiveBridgeRunExecutionState,
} from "./active-runs.js";
import { syncPendingActionEventToApp } from "./pending-action-sync.js";

type AskStreamChunk =
  | { type: "start"; ok: true; threadId: string; runId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "final"; data: BridgeAskResult }
  | { type: "fatal"; error: string };

interface BackgroundAskRun {
  runId: string;
  threadId: string;
  payload: BridgeAskPayload;
  executionState?: BridgeState;
  rootState: BridgeState;
  releaseActiveRun(): void;
  runtimeEnv?: NodeJS.ProcessEnv;
  wwAuth?: BridgeWwRuntimeAuth;
  controller: AbortController;
  chunks: AskStreamChunk[];
  events: AgentEvent[];
  mediaArtifactByUri: Map<string, string>;
  done: boolean;
  subscribers: Set<(chunk: AskStreamChunk) => void>;
}

export const ASK_STREAM_RESPONSE_HEADERS = {
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "content-encoding": "identity",
  "content-type": "application/x-ndjson; charset=utf-8",
  "x-accel-buffering": "no",
} as const;

const askRunRegistries = new WeakMap<BridgeState, Map<string, BackgroundAskRun>>();

export async function streamAskResponse(
  state: BridgeState,
  payload: BridgeAskPayload,
  response: ServerResponse,
  options: { runtimeEnv?: NodeJS.ProcessEnv; wwAuth?: BridgeWwRuntimeAuth } = {},
): Promise<void> {
  const run = startBackgroundAskRun(state, payload, options);
  await streamBackgroundAskRun(run, response);
}

export async function streamExistingAskResponse(
  state: BridgeState,
  query: { runId?: string; threadId?: string },
  response: ServerResponse,
): Promise<void> {
  const run = findBackgroundAskRun(state, query);
  if (!run) {
    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ ok: false, error: "run_not_found" }));
    return;
  }
  await streamBackgroundAskRun(run, response);
}

export function cancelBackgroundAskRun(state: BridgeState, query: { runId?: string; threadId?: string }): boolean {
  const run = findBackgroundAskRun(state, query);
  if (!run || run.done) {
    return false;
  }
  run.controller.abort();
  return true;
}

export async function guideBackgroundAskRun(
  state: BridgeState,
  input: { runId?: string; threadId?: string; instruction?: string },
): Promise<{ ok: boolean; guided: boolean; error?: string }> {
  const instruction = input.instruction?.trim();
  if (!instruction) {
    return { ok: false, guided: false, error: "instruction_required" };
  }
  const run = findBackgroundAskRun(state, input);
  if (!run || run.done) {
    return { ok: false, guided: false, error: "run_not_found" };
  }
  const executionState = run.executionState ?? state;
  const result = await executionState.app.steerTurn({
    runId: run.runId,
    threadId: run.threadId,
    instruction,
  });
  const response = {
    ok: result.ok,
    guided: result.guided === true,
    ...(result.error ? { error: result.error } : {}),
  };
  recordGuideEvent(executionState, run, instruction, response);
  return response;
}

export async function compactBackgroundAskSession(
  state: BridgeState,
  input: { threadId?: string; reason?: string },
): Promise<{ ok: boolean; compacted: boolean; error?: string; outcomeUnknown?: boolean }> {
  const threadId = input.threadId?.trim();
  if (!threadId) {
    return { ok: false, compacted: false, error: "thread_id_required" };
  }
  const runId = createBackgroundRunId();
  const result = await state.app.compactSession({
    runId,
    threadId,
    reason: input.reason || "Manual compaction requested from OpenGrove.",
  });
  if (!result.ok || result.compacted !== true) {
    return {
      ok: false,
      compacted: false,
      error: result.error || "compact_not_confirmed",
      ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
    };
  }

  const now = new Date().toISOString();
  const started: AgentEvent = {
    type: "compaction.started",
    runId,
    at: now,
    reason: input.reason || "Manual compaction requested from OpenGrove.",
  };
  const finished: AgentEvent = {
    type: "compaction.finished",
    runId,
    at: new Date().toISOString(),
    summary: "Context compacted.",
  };
  state.app.recordEvent(started, { sessionId: threadId, input: "/compact" });
  state.app.recordEvent(finished, { sessionId: threadId, input: "/compact" });
  state.store.saveFrom(state.app);
  return { ok: true, compacted: result.compacted === true };
}

function startBackgroundAskRun(
  state: BridgeState,
  payload: BridgeAskPayload,
  options: { runtimeEnv?: NodeJS.ProcessEnv; wwAuth?: BridgeWwRuntimeAuth } = {},
): BackgroundAskRun {
  const runId = createBackgroundRunId();
  const rootState = state.rootState ?? state;
  const controller = new AbortController();
  const run: BackgroundAskRun = {
    runId,
    threadId: payload.threadId,
    payload,
    rootState,
    releaseActiveRun: registerActiveBridgeRun(rootState, runId, { cancel: () => controller.abort() }),
    runtimeEnv: options.runtimeEnv,
    ...(options.wwAuth ? { wwAuth: options.wwAuth } : {}),
    controller,
    chunks: [],
    events: [],
    mediaArtifactByUri: new Map(),
    done: false,
    subscribers: new Set(),
  };
  registryForState(state).set(runId, run);
  void executeBackgroundAskRun(state, run);
  return run;
}

async function executeBackgroundAskRun(state: BridgeState, run: BackgroundAskRun): Promise<void> {
  const payload = run.payload;
  let executionState = state;
  let turnContext: BridgeTurnContext | undefined;
  const events = run.events;

  try {
    emitAskRunChunk(run, { type: "start", ok: true, threadId: payload.threadId, runId: run.runId });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      executionState = pinAskExecutionState(resolveAskExecutionState(state, payload));
      run.executionState = executionState;
      setActiveBridgeRunExecutionState(state, run.runId, executionState);
      turnContext = prepareAskState(executionState, payload);
      if (run.wwAuth) {
        turnContext.wwAuth = run.wwAuth;
      }
      const policyOverrides = turnContext.policyOverrides;
      const appRuntimeEnv = resolveMountedAppRuntimeEnv(executionState, payload.appId, undefined, run.wwAuth);
      const runtimeEnv = {
        ...(run.runtimeEnv ?? {}),
        ...(appRuntimeEnv?.env ?? {}),
      };
      const attemptResult = await runWithBridgeTurnContext(turnContext, async () =>
        consumeWwRetryableTurnAttempt({
          events: executionState.app.runTurn(payload.question, {
            sessionId: payload.threadId,
            runId: run.runId,
            requestedModelId: payload.model,
            requestedEffort: payload.effort,
            responseSpeed: payload.responseSpeed,
            budgetLimitUsd: payload.budgetLimitUsd,
            accessMode: payload.accessMode,
            planMode: payload.planMode,
            goalMode: payload.goalMode,
            requestedSkillName: payload.requestedSkill?.name,
            requestedSkillArgs: payload.requestedSkill?.args,
            policy: policyOverrides,
            runtimeEnv,
            signal: run.controller.signal,
            eventPersistence: "caller",
          }),
          withholdWwKeyFailure: attempt === 0,
          onEvent: (event) => recordAskRunEvent(run, payload, event),
        }),
      );
      const { attemptEvents, withheldEvents, withheldError } = attemptResult;

      if (attempt === 1) {
        const repeatedKeyError = attemptEvents.find(
          (event): event is Extract<AgentEvent, { type: "error" }> =>
            event.type === "error" && isWwApiKeyInvalidError(event.message),
        );
        if (
          repeatedKeyError &&
          blockWwApiKeyRecoveryForExecution({
            state: executionState,
            auth: run.wwAuth,
            attemptEvents,
            error: repeatedKeyError.message,
          })
        ) {
          recordAskRunEvent(run, payload, {
            type: "runtime.diagnostic",
            runId: run.runId,
            at: new Date().toISOString(),
            name: "ww.api_key.recovery_blocked",
            data: { reason: "api_key_invalid_after_repair" },
          });
        }
      }

      if (!withheldError) break;
      const recovery = await recoverWwApiKeyForExecution({
        state: executionState,
        auth: run.wwAuth,
        attemptEvents,
        error: withheldError.message,
      });
      if (!recovery.repaired) {
        for (const event of withheldEvents) recordAskRunEvent(run, payload, event);
        break;
      }
      recordAskRunEvent(run, payload, {
        type: "runtime.diagnostic",
        runId: run.runId,
        at: new Date().toISOString(),
        name: "ww.api_key.repaired",
        data: { retryAttempt: 1, keyState: recovery.keyState ?? "unknown" },
      });
    }

    if (!turnContext) throw new Error("ask_turn_context_unavailable");
    emitAskRunChunk(run, {
      type: "final",
      data: finalizeAskResponse(run, payload, events, run.mediaArtifactByUri),
    });
  } catch (error) {
    if (turnContext) {
      const message = run.controller.signal.aborted
        ? "stopped"
        : error instanceof Error
          ? error.message
          : String(error);
      const errorEvent: AgentEvent = {
        type: "error",
        runId: run.runId,
        message,
      };
      recordAskRunEvent(run, payload, errorEvent);
      emitAskRunChunk(run, {
        type: "final",
        data: finalizeAskResponse(run, payload, events, run.mediaArtifactByUri),
      });
    } else {
      emitAskRunChunk(run, {
        type: "fatal",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    run.done = true;
    clearActiveBridgeRunExecutionState(state, run.runId);
    run.releaseActiveRun();
    windowlessDelay(
      () => {
        registryForState(state).delete(run.runId);
      },
      10 * 60 * 1000,
    );
  }
}

function recordAskRunEvent(run: BackgroundAskRun, payload: BridgeAskPayload, event: AgentEvent): void {
  attachModelId([event], payload.model);
  run.events.push(event);
  if (event.type === "approval.requested") {
    registerActiveBridgeRunInteraction(run.rootState, {
      runId: event.runId,
      kind: "approval",
      interactionId: event.request.id,
      nativeRequestId: event.request.nativeRequestId,
    });
  } else if (event.type === "question.requested") {
    registerActiveBridgeRunInteraction(run.rootState, {
      runId: event.runId,
      kind: "question",
      interactionId: event.question.id,
      nativeRequestId: event.question.nativeRequestId,
    });
  }
  const executionApp = run.executionState?.app ?? run.rootState.app;
  executionApp.recordEvent(event, {
    sessionId: payload.threadId,
    activity: "browser",
    input: payload.question,
  });
  if (executionApp !== run.rootState.app) {
    syncPendingActionEventToApp(run.rootState.app, event);
    if (event.type === "memory.written") {
      run.rootState.app.memory.upsert(event.record);
    }
    run.rootState.app.recordEvent(event, {
      sessionId: payload.threadId,
      activity: "browser",
      input: payload.question,
    });
  }
  const checkpointPolicy =
    run.rootState.eventCheckpointPolicy ?? (run.rootState.eventCheckpointPolicy = createAgentEventCheckpointPolicy());
  if (checkpointPolicy.shouldCheckpoint(event) || event.type === "memory.written") {
    run.rootState.store.saveFrom(run.rootState.app);
  }
  const artifactStore = run.rootState.app.artifacts;
  const mediaArtifactIds = persistAskMediaArtifacts(run.rootState, payload.question, event);
  for (const id of mediaArtifactIds) {
    const artifact = artifactStore.get(id);
    const uri =
      artifact &&
      (artifact.preview?.imageUri ||
        (typeof artifact.data.uri === "string" ? artifact.data.uri : undefined) ||
        artifact.assets?.find((asset) => asset.uri)?.uri);
    if (uri?.startsWith("data:")) run.mediaArtifactByUri.set(uri, id);
  }
  let wireEvent = rewriteEventMediaReferences(
    presentAgentEvent(event, { preserveAssistantText: true }),
    run.mediaArtifactByUri,
  );
  if (wireEvent.type === "tool.finished" && mediaArtifactIds.length) {
    const artifacts = mediaArtifactIds.map((id) => artifactStore.get(id)).filter((artifact) => artifact !== undefined);
    wireEvent = {
      ...wireEvent,
      result: {
        ...wireEvent.result,
        value: { artifacts: presentArtifactCards(artifacts) },
      },
    };
  }
  emitAskRunChunk(run, { type: "event", event: wireEvent });
}

export function persistAskMediaArtifacts(
  rootState: Pick<BridgeState, "app" | "store">,
  question: string,
  event: AgentEvent,
): string[] {
  const artifactIds = extractMediaArtifactsFromEvents({
    artifacts: rootState.app.artifacts,
    question,
    events: [event],
  });
  if (artifactIds.length > 0) {
    // Media records must be durable before another settings rebuild can replace
    // the root app. Saving a scoped per-run app here would overwrite unrelated
    // state that changed after the run started.
    rootState.store.saveFrom(rootState.app);
  }
  return artifactIds;
}

function rewriteEventMediaReferences(event: AgentEvent, mediaArtifactByUri: Map<string, string>): AgentEvent {
  if (mediaArtifactByUri.size === 0) return event;
  if (event.type === "assistant.delta" || event.type === "assistant.final") {
    return { ...event, text: rewriteMediaReferences(event.text, mediaArtifactByUri) };
  }
  if (event.type === "model.response") {
    return {
      ...event,
      response: {
        ...event.response,
        text: rewriteMediaReferences(event.response.text, mediaArtifactByUri),
      },
    };
  }
  return event;
}

export function rewriteMediaReferences(text: string, mediaArtifactByUri: Map<string, string>): string {
  let output = text;
  for (const [uri, artifactId] of mediaArtifactByUri) {
    if (output.includes(uri)) {
      output = output.split(uri).join(`/artifacts/${encodeURIComponent(artifactId)}/content`);
    }
  }
  return output;
}

function recordGuideEvent(
  state: BridgeState,
  run: BackgroundAskRun,
  instruction: string,
  result: { ok: boolean; guided: boolean; error?: string },
): void {
  const event: AgentEvent = {
    type: "runtime.diagnostic",
    runId: run.runId,
    at: new Date().toISOString(),
    name: "turn.guided",
    data: {
      ok: result.ok,
      guided: result.guided,
      instructionPreview: instruction.length > 240 ? `${instruction.slice(0, 237)}...` : instruction,
      ...(result.error ? { error: result.error } : {}),
    },
  };
  run.events.push(event);
  attachModelId([event], run.payload.model);
  state.app.recordEvent(event, {
    sessionId: run.threadId,
    input: run.payload.question,
  });
  if (state.app !== run.rootState.app) {
    run.rootState.app.recordEvent(event, {
      sessionId: run.threadId,
      input: run.payload.question,
    });
  }
  run.rootState.store.saveFrom(run.rootState.app);
  emitAskRunChunk(run, { type: "event", event: presentAgentEvent(event) });
}

function pinAskExecutionState(state: BridgeState): BridgeState {
  return {
    ...state,
    rootState: state.rootState ?? state,
    // A hot settings rebuild may replace rootState.app. The producer must keep
    // the app that owns its approval/question waiters until this run ends.
    app: state.app,
  };
}

function streamBackgroundAskRun(run: BackgroundAskRun, response: ServerResponse): Promise<void> {
  response.writeHead(200, ASK_STREAM_RESPONSE_HEADERS);
  response.flushHeaders?.();
  response.socket?.setNoDelay(true);

  return new Promise((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      run.subscribers.delete(sendChunk);
      response.end();
      resolve();
    };
    const sendChunk = (chunk: AskStreamChunk) => {
      if (closed) return;
      response.write(`${JSON.stringify(chunk)}\n`);
      (response as ServerResponse & { flush?: () => void }).flush?.();
      if (chunk.type === "final" || chunk.type === "fatal") {
        queueMicrotask(close);
      }
    };
    response.once("close", close);

    for (const chunk of run.chunks) {
      if (closed) break;
      sendChunk(chunk);
    }
    if (run.done) {
      close();
      return;
    }
    run.subscribers.add(sendChunk);
  });
}

function emitAskRunChunk(run: BackgroundAskRun, chunk: AskStreamChunk): void {
  run.chunks.push(chunk);
  for (const subscriber of run.subscribers) {
    subscriber(chunk);
  }
}

function findBackgroundAskRun(
  state: BridgeState,
  query: { runId?: string; threadId?: string },
): BackgroundAskRun | undefined {
  const registry = registryForState(state);
  if (query.runId) {
    return registry.get(query.runId);
  }
  if (!query.threadId) {
    return undefined;
  }
  return [...registry.values()]
    .filter((run) => run.threadId === query.threadId && !run.done)
    .sort((left, right) => right.runId.localeCompare(left.runId))[0];
}

function registryForState(state: BridgeState): Map<string, BackgroundAskRun> {
  const rootState = state.rootState ?? state;
  let registry = askRunRegistries.get(rootState);
  if (!registry) {
    registry = new Map();
    askRunRegistries.set(rootState, registry);
  }
  return registry;
}

function createBackgroundRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function windowlessDelay(callback: () => void, delayMs: number): void {
  setTimeout(callback, delayMs).unref?.();
}

export function persistSnapshotAttachments(snapshot: BrowserPageSnapshot, state: BridgeState): void {
  if (!snapshot.attachments?.length) {
    return;
  }

  const uploadRoot = bridgeDataPath(state, "uploads");
  mkdirSync(uploadRoot, { recursive: true });

  snapshot.attachments = snapshot.attachments.map((attachment) => {
    if (attachment.localPath) {
      return attachment;
    }

    const fileName = createUploadFileName(attachment);
    const localPath = resolve(uploadRoot, fileName);
    const content =
      attachment.text !== undefined
        ? attachment.text
        : attachment.dataUrl
          ? decodeDataUrl(attachment.dataUrl)
          : undefined;

    if (content === undefined) {
      return attachment;
    }

    writeFileSync(localPath, content);
    return {
      ...attachment,
      localPath,
    };
  });
}

function prepareAskState(state: BridgeState, payload: BridgeAskPayload): BridgeTurnContext {
  const turnComputerSnapshot = hasComputerState(payload.computerSnapshot) ? payload.computerSnapshot : {};
  state.snapshot = payload.snapshot;
  state.computerSnapshot = turnComputerSnapshot;
  state.model = payload.model;
  state.saveCandidateNote = payload.saveCandidateNote;
  syncBridgeWorkingState(state.app, {
    sessionId: payload.threadId,
    selectedModel: payload.model,
  });

  return {
    threadId: payload.threadId,
    model: payload.model,
    snapshot: payload.snapshot,
    computerSnapshot: turnComputerSnapshot,
    policyOverrides: buildAskPolicyOverrides(payload),
  };
}

function buildAskPolicyOverrides(_payload: BridgeAskPayload): PolicyRule[] {
  const policyOverrides: PolicyRule[] = [];
  return policyOverrides;
}

function finalizeAskResponse(
  run: BackgroundAskRun,
  payload: BridgeAskPayload,
  events: AgentEvent[],
  mediaArtifactByUri: Map<string, string>,
): BridgeAskResult {
  const executionState = run.executionState ?? run.rootState;
  const responseApp = executionState.app;
  attachModelId(events, payload.model);
  syncBridgeWorkingState(responseApp, {
    sessionId: payload.threadId,
    selectedModel: payload.model,
  });
  if (responseApp !== run.rootState.app) {
    syncBridgeWorkingState(run.rootState.app, {
      sessionId: payload.threadId,
      selectedModel: payload.model,
    });
  }
  // Never let an older per-run app overwrite state produced after a hot
  // rebuild. Events and pending actions are mirrored incrementally above;
  // the live root is the only authoritative persistence source.
  run.rootState.store.saveFrom(run.rootState.app);
  const contextRecords = buildContextRecords(events);
  const answer = rewriteMediaReferences(collectAssistantText(events), mediaArtifactByUri);
  writeTrajectoryRecord(run.rootState, payload, events, answer, contextRecords);

  return {
    ok: true,
    answer,
    approvals: presentApprovalSummaries(run.rootState.app.approvals.list("pending").slice(-500)),
    questions: presentQuestionSummaries(run.rootState.app.questions.list("pending").slice(-500)),
    artifacts: presentArtifactSummaries(run.rootState.app.artifacts.list({ limit: 100 })),
    workingState: presentWorkingState(run.rootState.app.workingState.get()),
    sessions: presentSessionSummaries(run.rootState.app.sessions.list({ limit: 12 })),
    runs: presentRunSummaries(run.rootState.app.sessions.listRuns({ limit: 24 })),
    executions: presentExecutionSummaries(run.rootState.app.executions.list({ limit: 40 })),
  };
}

function decodeDataUrl(dataUrl: string): Buffer | undefined {
  const match = /^data:[^;,]+;base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) {
    return undefined;
  }
  const payload = match[1];
  return payload ? Buffer.from(payload.replace(/\s/g, ""), "base64") : undefined;
}

function createUploadFileName(attachment: BrowserPageAttachmentSnapshot): string {
  const id = sanitizeUploadPathSegment(
    attachment.id || `upload_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
  );
  const name = sanitizeUploadPathSegment(attachment.name) || "attachment";
  return `${id}_${name}`.slice(0, 180);
}

function sanitizeUploadPathSegment(value: string): string {
  return value
    .replace(/[^\w .()+-]+/g, "_")
    .replace(/^\.+/, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
