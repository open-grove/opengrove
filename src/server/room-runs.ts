import {
  createAssistantFinalEvent,
  collectAssistantText,
  collectRunErrorText,
  resolveChatFinalAnswer,
  type AgentAttachmentContext,
  type AgentEvent,
  type DiagnosticProblemRef,
  type RuntimeErrorDiagnostics,
} from "../core.js";
import { createAgentEventCheckpointPolicy } from "../core/event-persistence.js";
import { isRetryableDiagnosticError, type DiagnosticFacts } from "../diagnostics/problem-schema.js";
import { safeDiagnosticErrorCode } from "../diagnostics/redaction.js";
import type { RoomLedgerCapability } from "#agent-protocol";
import type { BrowserPageSnapshot } from "../environment/browser-adapter.js";
import type { RoomChannelMessage } from "../rooms/channel-store.js";
import { sessionHistoryModeForCapabilities } from "../kernel/session-history-mode.js";
import { BRIDGE_KERNEL_IDS, type BridgeKernelId, type BridgeState } from "./bridge-types.js";
import { resolveMountedAppCliEnv } from "./app-cli-env.js";
import { resolveMountedAppRuntimeEnv } from "./app-runtime-env.js";
import type { BridgeResolvedProviderRoute } from "./provider-profiles.js";
import { getBridgeTurnContext, runWithBridgeTurnContext } from "./bridge-turn-context.js";
import { keepRoomLedgerCapabilityAlive, revokeRoomLedgerCapability } from "./room-ledger-capabilities.js";
import { clearRoomDelegationBudget } from "./room-delegation-budget.js";
import {
  cancelRoomAssistantRun,
  hasActiveRoomRunController,
  clearActiveRoomRunExecutionState,
  clearRoomRunController,
  isRunnableRoomAssistantTarget,
  reapInactiveRoomRun,
  registerActiveRoomRunExecutionState,
  scheduleRoomAssistantRunsWithExecutor,
  type RoomRunExecutionInput,
  type RoomRunInput,
} from "./room-runs/scheduler.js";
import { roomRunCanceledMessage, roomRunFailedMessage } from "./room-runs/constants.js";
import { resolveHostLanguageSettings } from "./language-preference.js";
import { hostMessage } from "../localization/host-messages.js";
import {
  resolveRoomExecutionTarget,
  resolveRoomTargetModel,
  resolveRoomTargetProviderRoute,
  roomKernelCapabilityErrorMessage,
  roomProviderRouteErrorMessage,
  roomExecutionState,
} from "./room-runs/execution-state.js";
import { buildRoomRunEnvelope } from "./room-runs/envelope.js";
import { createRoomLedgerCapabilityForRoomRun } from "./room-runs/ledger.js";
import { collectRunDetails } from "./room-runs/persisted-parts.js";
import {
  availableRoomSkillNames,
  requiredRoomSkillNames,
  roomRunPolicy,
  roomRunRequestedEffort,
  roomRunResponseSpeed,
} from "./room-runs/prompts.js";
import { attachModelId } from "./trajectory.js";
import { resolveBridgeRuntimeControlsForKernel } from "./kernel-utils.js";
import { withRoomLedgerAccessForRun } from "../tools/rooms.js";
import { persistSnapshotAttachments } from "./ask-stream.js";
import {
  blockWwApiKeyRecoveryForExecution,
  consumeWwRetryableTurnAttempt,
  recoverWwApiKeyForExecution,
  isWwApiKeyInvalidError,
} from "./ww-provider-recovery.js";
import { problemRef, recordProblem } from "./problem-records.js";
import { syncPendingActionEventToApp } from "./pending-action-sync.js";
import { registerActiveBridgeRunInteraction } from "./active-runs.js";

export { cancelRoomAssistantRun, hasActiveRoomRunController, isRunnableRoomAssistantTarget };

export {
  collectRunDetails,
  persistedRoomRunParts,
} from "./room-runs/persisted-parts.js";
export { buildRoomRunEnvelope } from "./room-runs/envelope.js";
export {
  requiredRoomSkillNames,
  roomRunPolicy,
  roomRunRequestedEffort,
  roomRunResponseSpeed,
} from "./room-runs/prompts.js";

export function scheduleRoomAssistantRuns(state: BridgeState, input: RoomRunInput): RoomChannelMessage[] {
  return scheduleRoomAssistantRunsWithExecutor(state, input, executeRoomRunSafely);
}

async function executeRoomRunSafely(state: BridgeState, input: RoomRunExecutionInput): Promise<void> {
  const startedAt = Date.now();
  try {
    await executeRoomRun(state, input);
  } catch (error) {
    const triggerText = state.app.rooms.getMessage(input.roomId, input.triggerMessageId)?.text ?? "";
    await handleRoomRunError(state, input, {
      error,
      userInput: triggerText,
      triggerText,
      sessionId: `room-run:${input.runId}`,
      executionState: undefined,
      startedAt,
      events: [],
    });
  } finally {
    clearRoomDelegationBudget(state, input.runId);
    clearActiveRoomRunExecutionState(state, input.runId);
    clearRoomRunController(state, input.runId);
    try {
      reapInactiveRoomRun(state, input);
    } catch (error) {
      console.error("room run terminal-state reconciliation failed:", error instanceof Error ? error.message : error);
    }
  }
}

async function executeRoomRun(state: BridgeState, input: RoomRunExecutionInput): Promise<void> {
  const startedAt = Date.now();
  const execution = resolveRoomExecutionTarget(state, input.target);
  let executionState: BridgeState | undefined = execution.executionState;
  registerActiveRoomRunExecutionState(state, input.runId, execution.executionState);
  const target = execution.target;
  const model = target.model;
  const envelope = buildRoomRunEnvelope(state, {
    roomId: input.roomId,
    triggerMessageId: input.triggerMessageId,
    target,
    hostTools: executionState.kernelCapabilities?.hostTools === true,
    providerRoute: execution.providerRoute,
  });
  const triggerText = envelope.triggerMessage.text;
  const sessionId = envelope.sessionId;
  if (!executionState.kernelCapabilities) {
    throw new Error(`room_member_kernel_capabilities_unavailable:${target.kernel}`);
  }
  const sessionHistoryMode = sessionHistoryModeForCapabilities(executionState.kernelCapabilities);
  const userInput = envelope.userInput;
  const events: AgentEvent[] = [];
  let ledgerCapability: RoomLedgerCapability | undefined;
  let stopLedgerCapabilityKeepalive: (() => void) | undefined;

  if (input.signal?.aborted) {
    await finalizeCanceledRoomRun(state, input, startedAt, events, model, execution.providerRoute);
    clearRoomRunController(state, input.runId);
    return;
  }

  try {
    const wwAuth = input.wwAuth ?? getBridgeTurnContext()?.wwAuth;
    ledgerCapability = createRoomLedgerCapabilityForRoomRun({
      runId: input.runId,
      roomId: input.roomId,
      internalBridgeBaseUrl: (state.rootState ?? state).internalBridgeBaseUrl,
    });
    stopLedgerCapabilityKeepalive = keepRoomLedgerCapabilityAlive(ledgerCapability?.token);
    const turnContext = {
      threadId: sessionId,
      model,
      snapshot: buildRoomRunPageSnapshot({
        roomId: input.roomId,
        visibleText: userInput,
        attachments: envelope.attachments,
      }),
      computerSnapshot: {},
      policyOverrides: [],
      ...(wwAuth ? { wwAuth } : {}),
    };
    // Write uploaded attachments to disk so file-path based runtimes (Codex
    // mentions, claude CLI) can read them; runtimes that take inline image
    // content use the dataUrl directly. Mirrors the /ask stream route.
    persistSnapshotAttachments(turnContext.snapshot, state);

    const requiredSkillNames = envelope.isPmAutoRoute ? [] : requiredRoomSkillNames(target);
    const availableSkillNames = envelope.isPmAutoRoute ? [] : availableRoomSkillNames(target);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      executionState =
        attempt === 0 ? executionState : roomExecutionState(state, input.target, execution.providerRoute);
      const activeExecutionState = executionState;
      registerActiveRoomRunExecutionState(state, input.runId, activeExecutionState);
      const reasoningControls = resolveBridgeRuntimeControlsForKernel(
        activeExecutionState,
        activeExecutionState.kernel,
      );
      const appRuntimeEnv = resolveMountedAppRuntimeEnv(activeExecutionState, target.appId, target.id, wwAuth);
      const appCliEnv = resolveMountedAppCliEnv(activeExecutionState, target.appId, target.id, appRuntimeEnv?.env);
      let cliEnvironmentContext = "";
      if (appCliEnv?.missingEnv.length) {
        const language = resolveHostLanguageSettings(state.settings);
        const missing = appCliEnv.missingEnv.map((item) =>
          hostMessage(language, "app.cli.missing_env", {
            cliId: item.cliId,
            env: item.env.join(", "),
          }),
        );
        cliEnvironmentContext = hostMessage(language, "app.cli.missing_env_context", {
          missing: missing.map((item) => `- ${item}`).join("\n"),
        });
      }
      const runtimeEnv = {
        ...(appRuntimeEnv?.env ?? {}),
        ...(appCliEnv?.env ?? {}),
        OPENGROVE_SOURCE_ROOM_ID: input.roomId,
        ...(ledgerCapability ? { OPENGROVE_ROOM_LEDGER_CAPABILITY_JSON: JSON.stringify(ledgerCapability) } : {}),
      };
      // Keep the producing app identity stable for this attempt. A settings or
      // mounted-App reload can replace state.app while this iterator is alive.
      const eventSourceApp = activeExecutionState.app;
      const attemptResult = await runWithBridgeTurnContext(turnContext, async () =>
        withRoomLedgerAccessForRun(
          input.runId,
          {
            sourceRoomId: input.roomId,
            ledgerCapability,
          },
          async () =>
            consumeWwRetryableTurnAttempt({
              events: eventSourceApp.runTurn(userInput, {
                sessionId,
                runId: input.runId,
                requestedModelId: model,
                requestedEffort: roomRunRequestedEffort(target, triggerText, reasoningControls),
                availableSkillNames,
                requiredSkillNames,
                sessionInstructions: envelope.sessionInstructions,
                hostContextPromptBlock: [envelope.turnInstructions, cliEnvironmentContext].filter(Boolean).join("\n\n"),
                accessMode: target.accessMode,
                dynamicToolsMode: "always",
                responseSpeed: roomRunResponseSpeed(),
                contextTokenBudget: target.contextTokenBudget,
                sessionHistoryMode,
                policy: roomRunPolicy(target, triggerText),
                signal: input.signal,
                runtimeEnv,
                hostToolScope: {
                  employeeId: target.id,
                  roomId: input.roomId,
                },
                eventPersistence: "caller",
              }),
              withholdWwKeyFailure: attempt === 0,
              onEvent: (event) =>
                recordRoomRunEvent({
                  state,
                  activeExecutionState,
                  eventSourceApp,
                  event,
                  events,
                  model,
                  sessionId,
                  userInput,
                }),
            }),
        ),
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
            state: activeExecutionState,
            auth: wwAuth,
            attemptEvents,
            error: repeatedKeyError.message,
          })
        ) {
          recordRoomRunEvent({
            state,
            activeExecutionState,
            eventSourceApp,
            event: {
              type: "runtime.diagnostic",
              runId: input.runId,
              at: new Date().toISOString(),
              name: "ww.api_key.recovery_blocked",
              data: { reason: "api_key_invalid_after_repair" },
            },
            events,
            model,
            sessionId,
            userInput,
          });
        }
      }

      if (!withheldError) break;
      const recovery = await recoverWwApiKeyForExecution({
        state: activeExecutionState,
        auth: wwAuth,
        attemptEvents,
        error: withheldError.message,
      });
      if (!recovery.repaired) {
        for (const event of withheldEvents) {
          recordRoomRunEvent({
            state,
            activeExecutionState,
            eventSourceApp,
            event,
            events,
            model,
            sessionId,
            userInput,
          });
        }
        break;
      }
      recordRoomRunEvent({
        state,
        activeExecutionState,
        eventSourceApp,
        event: {
          type: "runtime.diagnostic",
          runId: input.runId,
          at: new Date().toISOString(),
          name: "ww.api_key.repaired",
          data: { retryAttempt: 1, keyState: recovery.keyState ?? "unknown" },
        },
        events,
        model,
        sessionId,
        userInput,
      });
    }
    syncRoomExecutionSessionMetadata(state, executionState, sessionId);

    if (input.signal?.aborted) {
      await finalizeCanceledRoomRun(state, input, startedAt, events, model, execution.providerRoute);
      return;
    }

    const errorMessage = collectRunErrorText(events);
    const language = resolveHostLanguageSettings(state.settings);
    const answer = resolveChatFinalAnswer(events, { language });
    const runProblem = errorMessage
      ? problemRef(
          recordProblem(state, {
            traceId: input.traceId,
            category: "employee-run",
            phase: employeeRunFailurePhase(errorMessage),
            code: employeeRunFailureCode(errorMessage),
            level: "error",
            error: errorMessage,
            retryable: isRetryableDiagnosticError(errorMessage),
            runId: input.runId,
            context: {
              roomId: input.roomId,
              memberId: input.target.id,
              kernel: input.target.kernel,
            },
            facts: roomRunDiagnosticFacts(state, input, {
              startedAt,
              requestedModelId: model,
              events,
              providerRoute: execution.providerRoute,
            }),
          }),
        )
      : undefined;
    const persistedParts = collectRunDetails(events, input.runId, errorMessage, { language });
    await finalizeRoomMessage(state, input, {
      text: answer,
      status: errorMessage ? "failed" : "done",
      parts: persistedParts,
      startedAt,
      events,
      requestedModelId: model,
      providerRoute: execution.providerRoute,
      ...(runProblem ? { problem: runProblem } : {}),
    });
  } catch (error) {
    await handleRoomRunError(state, input, {
      error,
      userInput,
      triggerText,
      sessionId,
      executionState,
      startedAt,
      events,
      requestedModelId: model,
      providerRoute: execution.providerRoute,
    });
  } finally {
    stopLedgerCapabilityKeepalive?.();
    revokeRoomLedgerCapability(ledgerCapability?.token);
  }
}

export function recordRoomRunEvent(input: {
  state: BridgeState;
  activeExecutionState: BridgeState;
  eventSourceApp: BridgeState["app"];
  event: AgentEvent;
  events: AgentEvent[];
  model: string;
  sessionId: string;
  userInput: string;
}): void {
  if (input.event.type === "turn.finished") {
    const finalEvent = createAssistantFinalEvent(input.events, {
      runId: input.event.runId,
      at: input.event.at,
      source: "adapter",
    });
    if (finalEvent) persistRoomRunEvent({ ...input, event: finalEvent });
  }
  persistRoomRunEvent(input);
}

function persistRoomRunEvent(input: {
  state: BridgeState;
  activeExecutionState: BridgeState;
  eventSourceApp: BridgeState["app"];
  event: AgentEvent;
  events: AgentEvent[];
  model: string;
  sessionId: string;
  userInput: string;
}): void {
  attachModelId([input.event], input.model);
  input.events.push(input.event);
  const producerRun = input.eventSourceApp.sessions.getRun(input.event.runId);
  const runIdentity = {
    sessionId: producerRun?.sessionId ?? input.sessionId,
    activity: producerRun?.activity ?? "chat",
    input: producerRun?.input ?? input.userInput,
  };
  input.eventSourceApp.recordEvent(input.event, runIdentity);
  if (input.event.type === "approval.requested") {
    registerActiveBridgeRunInteraction(input.state, {
      runId: input.event.runId,
      kind: "approval",
      interactionId: input.event.request.id,
      nativeRequestId: input.event.request.nativeRequestId,
    });
  } else if (input.event.type === "question.requested") {
    registerActiveBridgeRunInteraction(input.state, {
      runId: input.event.runId,
      kind: "question",
      interactionId: input.event.question.id,
      nativeRequestId: input.event.question.nativeRequestId,
    });
  }
  if (input.eventSourceApp !== input.state.app) {
    syncPendingActionEventToApp(input.state.app, input.event);
    input.state.app.recordEvent(input.event, runIdentity);
  }
  const checkpointPolicy =
    input.state.eventCheckpointPolicy ?? (input.state.eventCheckpointPolicy = createAgentEventCheckpointPolicy());
  if (checkpointPolicy.shouldCheckpoint(input.event)) {
    input.state.store?.saveFrom(input.state.app);
  }
}

async function handleRoomRunError(
  state: BridgeState,
  input: RoomRunExecutionInput,
  context: {
    error: unknown;
    userInput: string;
    triggerText: string;
    sessionId: string;
    executionState: BridgeState | undefined;
    startedAt: number;
    events: AgentEvent[];
    requestedModelId?: string;
    providerRoute?: BridgeResolvedProviderRoute;
  },
): Promise<void> {
  const diagnosticMessage = context.error instanceof Error ? context.error.message : String(context.error);
  const language = resolveHostLanguageSettings(state.settings);
  const message =
    roomProviderRouteErrorMessage(context.error, language) ??
    roomKernelCapabilityErrorMessage(context.error, language) ??
    diagnosticMessage;
  syncRoomExecutionSessionMetadata(state, context.executionState, context.sessionId);
  if (input.signal?.aborted) {
    await finalizeCanceledRoomRun(
      state,
      input,
      context.startedAt,
      context.events,
      context.requestedModelId,
      context.providerRoute,
    );
    return;
  }
  const problem = !isMissingRoomRunDestination(context.error)
    ? problemRef(
        recordProblem(state, {
          traceId: input.traceId,
          category: "employee-run",
          phase: employeeRunFailurePhase(diagnosticMessage),
          code: employeeRunFailureCode(context.error),
          error: context.error,
          retryable: isRetryableDiagnosticError(diagnosticMessage),
          runId: input.runId,
          context: {
            roomId: input.roomId,
            memberId: input.target.id,
            kernel: input.target.kernel,
          },
          facts: roomRunDiagnosticFacts(state, input, {
            startedAt: context.startedAt,
            requestedModelId: context.requestedModelId,
            events: context.events,
            providerRoute: context.providerRoute,
          }),
        }),
      )
    : undefined;
  const errorEvent: AgentEvent = {
    type: "error",
    runId: input.runId,
    message,
    ...(problem ? { problem } : {}),
  };
  state.app.recordEvent(errorEvent, {
    sessionId: context.sessionId,
    activity: "chat",
    input: context.userInput,
  });
  await finalizeRoomMessage(state, input, {
    text: roomRunFailedMessage(language),
    status: "failed",
    parts: collectRunDetails([errorEvent], input.runId, message, {
      language,
    }),
    startedAt: context.startedAt,
    events: [errorEvent],
    requestedModelId: context.requestedModelId,
    providerRoute: context.providerRoute,
    error: message,
    ...(problem ? { problem } : {}),
  });
}

async function finalizeCanceledRoomRun(
  state: BridgeState,
  input: RoomRunExecutionInput,
  startedAt: number,
  events: AgentEvent[],
  requestedModelId?: string,
  providerRoute?: BridgeResolvedProviderRoute,
): Promise<void> {
  // 取消时保留员工已吐出的内容(文本+工具/技能轨迹);完全没产出才回退到取消文案。
  // collectAssistantText 三级回退(final→model.response→拼本 run 的 delta),覆盖"流式 runtime
  // 被 abort 时只剩 delta"的情况。collectRunDetails 用 interrupted 模式,把取消类 error 视为
  // 中断而非红色错误,悬挂的工具/技能标 canceled 而非 failed。
  const partialText = collectAssistantText(events, input.runId).trim();
  const language = resolveHostLanguageSettings(state.settings);
  await finalizeRoomMessage(state, input, {
    text: partialText || roomRunCanceledMessage(language),
    status: "interrupted",
    parts: collectRunDetails(events, input.runId, "", { mode: "interrupted", language }),
    startedAt,
    events,
    requestedModelId,
    providerRoute,
  });
}

async function finalizeRoomMessage(
  state: BridgeState,
  input: RoomRunExecutionInput,
  output: {
    text: string;
    status: "done" | "failed" | "interrupted";
    parts?: ReturnType<typeof collectRunDetails>;
    startedAt: number;
    events: AgentEvent[];
    requestedModelId?: string;
    providerRoute?: BridgeResolvedProviderRoute;
    error?: string;
    problem?: DiagnosticProblemRef;
  },
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const patch = {
    text: output.text,
    status: output.status,
    ...(output.parts ? { parts: output.parts } : {}),
    finishedAt,
    duration: durationLabel(Date.now() - output.startedAt),
  };
  let updatedMessage: RoomChannelMessage;
  try {
    updatedMessage = state.app.rooms.updateMessage(input.roomId, input.assistantMessageId, patch);
  } catch (error) {
    if (!isMissingRoomRunDestination(error)) throw error;
    const problem =
      output.problem ??
      problemRef(
        recordProblem(state, {
          traceId: input.traceId,
          category: "employee-run",
          phase: "persist-result",
          code: "room_run_destination_missing",
          error,
          runId: input.runId,
          context: {
            roomId: input.roomId,
            messageId: input.assistantMessageId,
            memberId: input.target.id,
          },
          facts: roomRunDiagnosticFacts(state, input, {
            startedAt: output.startedAt,
            requestedModelId: output.requestedModelId,
            events: output.events,
            providerRoute: output.providerRoute,
          }),
        }),
      );
    attachProblemToRun(state, input.runId, problem);
    updatedMessage = {
      ...input.assistantMessage,
      ...patch,
      status: "interrupted",
      updatedAt: finishedAt,
    };
    void input.onMessageFinalized?.({
      target: input.target,
      message: updatedMessage,
      events: output.events,
      error: problem.code,
      problem,
    });
    state.store.saveFrom(state.app);
    return;
  }
  if (output.problem) attachProblemToRun(state, input.runId, output.problem);
  state.store.saveFrom(state.app);
  void input.onMessageFinalized?.({
    target: input.target,
    message: updatedMessage,
    events: output.events,
    ...(output.error ? { error: output.error } : {}),
    ...(output.problem ? { problem: output.problem } : {}),
  });
}

function attachProblemToRun(state: BridgeState, runId: string, problem: DiagnosticProblemRef): void {
  if (!state.app.sessions.getRun(runId)) return;
  state.app.sessions.updateRun(runId, { problem });
}

function isMissingRoomRunDestination(error: unknown): boolean {
  return error instanceof Error && (error.message === "room_not_found" || error.message === "message_not_found");
}

function employeeRunFailurePhase(message: string): string {
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/approval|question/i.test(message)) return "waiting-user";
  if (/tool|command|exec/i.test(message)) return "tool";
  if (/connect|gateway|fetch failed|network/i.test(message)) return "connect";
  if (/empty_response|final.*missing/i.test(message)) return "finalize";
  return "run";
}

function employeeRunFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const explicitCode =
    error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : undefined;
  const stableCode = safeDiagnosticErrorCode(explicitCode ?? message);
  if (stableCode !== "unknown_error") return stableCode;
  if (/stream idle timeout\s*-\s*no chunks received/i.test(message)) {
    return "employee_run_stream_idle_timeout";
  }
  switch (employeeRunFailurePhase(message)) {
    case "timeout":
      return "employee_run_timeout";
    case "waiting-user":
      return "employee_run_waiting_user";
    case "tool":
      return "employee_run_tool_failed";
    case "connect":
      return "employee_run_connect_failed";
    case "finalize":
      return "employee_run_final_missing";
    default:
      return "employee_run_failed";
  }
}

function roomRunDiagnosticFacts(
  state: BridgeState,
  input: RoomRunExecutionInput,
  context: {
    startedAt: number;
    requestedModelId?: string;
    events: AgentEvent[];
    providerRoute?: BridgeResolvedProviderRoute;
  },
): DiagnosticFacts {
  const runtimeDiagnostics = latestRoomRunErrorDiagnostics(context.events);
  const targetKernel = BRIDGE_KERNEL_IDS.includes(input.target.kernel as BridgeKernelId)
    ? (input.target.kernel as BridgeKernelId)
    : undefined;
  const providerBinding = targetKernel
    ? (context.providerRoute ?? resolveRoomTargetProviderRoute(state, input.target)).binding
    : undefined;
  let providerKind: string | undefined;
  if (providerBinding?.kind === "login") {
    providerKind = "login";
  } else if (providerBinding?.kind === "unresolved") {
    providerKind = "unconfigured";
  } else if (providerBinding?.profile?.custom === true) {
    providerKind = `custom-${providerBinding.profile.protocol}`;
  } else if (providerBinding?.profile) {
    providerKind = providerBinding.providerId;
  } else if (providerBinding) {
    providerKind = "unknown";
  }
  const requestedModelId = context.requestedModelId ?? safeResolveRoomRunModel(state, input);
  const upstreamRequestId = runtimeDiagnostics?.upstreamRequestId;
  return {
    runKind: "room",
    kernelKind: input.target.kernel,
    ...(providerKind ? { providerKind } : {}),
    ...(input.target.model?.trim() ? { selectedModelId: input.target.model.trim() } : {}),
    ...(requestedModelId ? { requestedModelId } : {}),
    ...(runtimeDiagnostics?.runtimeModelId ? { runtimeModelId: runtimeDiagnostics.runtimeModelId } : {}),
    ...(runtimeDiagnostics?.runtimeVersion ? { runtimeVersion: runtimeDiagnostics.runtimeVersion } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
    durationMs: Math.max(0, Date.now() - context.startedAt),
  };
}

function safeResolveRoomRunModel(state: BridgeState, input: RoomRunExecutionInput): string | undefined {
  try {
    return resolveRoomTargetModel(state, input.target);
  } catch {
    return input.target.model?.trim() || undefined;
  }
}

function latestRoomRunErrorDiagnostics(events: AgentEvent[]): RuntimeErrorDiagnostics | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "error" && event.diagnostics) return event.diagnostics;
  }
  return undefined;
}

export function buildRoomRunPageSnapshot(input: {
  roomId: string;
  visibleText: string;
  attachments?: AgentAttachmentContext[];
}): BrowserPageSnapshot {
  return {
    title: `OpenGrove room ${input.roomId}`,
    url: `opengrove://rooms/${input.roomId}`,
    visibleText: input.visibleText,
    attachments: input.attachments?.map((attachment) => ({ ...attachment })),
  };
}

function syncRoomExecutionSessionMetadata(
  state: BridgeState,
  executionState: BridgeState | undefined,
  sessionId: string,
): void {
  if (!executionState || executionState === state) {
    return;
  }
  const scopedSession = executionState.app.sessions.get(sessionId);
  if (!scopedSession?.metadata || Object.keys(scopedSession.metadata).length === 0) {
    return;
  }
  state.app.sessions.ensureSession({
    id: sessionId,
    activity: scopedSession.activity,
    metadata: scopedSession.metadata,
  });
}

function durationLabel(durationMs: number): string {
  return `${Math.max(0.1, durationMs / 1000).toFixed(1)}s`;
}
