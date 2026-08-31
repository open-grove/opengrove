import { useEffect, useMemo, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentEventRecord,
  ApprovalsResponse,
  AttachmentPayload,
  MessageContext,
  QuestionsResponse,
  ReasoningEffort,
  ResponseSpeed,
  RuntimeAccessMode,
  RunRecord,
  StoredMessage,
} from "./bridge";
import { cancelAskStream, guideAskStream } from "./bridge";
import type { TranslationKey } from "./i18n";
import { applyStreamEventToMessage, finalizeAssistantMessage, markAssistantMessageError } from "./messages";
import { createSnapshot } from "./runtime/composer-context";
import {
  findAttachableAssistantMessageId,
  isActiveRunRecord,
  isFreshRunRecord,
  isRecoverableStreamDisconnect,
  latestPendingAssistantMessage,
  messagesForUiThread,
  runRecordId,
} from "./runtime/app-shell-state";
import { attachThreadTurn, runThreadTurn } from "./runtime/thread-runtime";
import { mergeFinalDataIntoCache } from "./runtime/ui-model";
import { beginTransientUiUpdates, endTransientUiUpdates } from "./store";
import type { UiThread } from "./store";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

// 只在单个流式事件更新消息的同步时间片内跳过全量 sanitize；
// 网络流等待期间不持有该标记，重命名、删除等用户操作仍会立即落盘。
function withTransientUiUpdate(operation: () => void): void {
  beginTransientUiUpdates();
  try {
    operation();
  } finally {
    endTransientUiUpdates();
  }
}

type RunningTurn = {
  controller: AbortController;
  assistantId: string;
  runId?: string;
};

export interface QueuedTurnState {
  context: MessageContext | null;
  attachments: AttachmentPayload[];
  requestedSkill?: { name: string; args?: string };
  model: string;
  kernel?: string;
  providerId?: string;
  appId?: string;
  planMode?: boolean;
  goalMode?: boolean;
  reasoningEffort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
  budgetLimitUsd: number | null;
  accessMode: RuntimeAccessMode;
}

export interface QueuedInstruction {
  id: string;
  threadId: string;
  prompt: string;
  createdAt: string;
  status: "queued" | "guiding" | "guide-failed";
  lastError?: string;
  turnState: QueuedTurnState;
}

function cloneAttachments(attachments: AttachmentPayload[]): AttachmentPayload[] {
  return attachments.map((attachment) => ({ ...attachment }));
}

function cloneMessageContext(context: MessageContext | null): MessageContext | null {
  if (!context) {
    return null;
  }
  return {
    ...context,
    attachments: context.attachments ? cloneAttachments(context.attachments) : undefined,
    artifacts: context.artifacts?.map((artifact) => ({ ...artifact })),
  };
}

export function useAppThreadRunner(input: {
  t: Translate;
  queryClient: QueryClient;
  threadId: string;
  messages: StoredMessage[];
  threads: UiThread[];
  runs: RunRecord[];
  events: AgentEventRecord[];
  model: string;
  reasoningEffort: ReasoningEffort;
  responseSpeed: ResponseSpeed;
  budgetLimitUsd: number | null;
  accessMode: RuntimeAccessMode;
  planMode: boolean;
  goalMode: boolean;
  setSending(sending: boolean): void;
  appendMessageToThread(
    threadId: string,
    role: StoredMessage["role"],
    text: string,
    context?: MessageContext | null,
  ): string;
  appendAssistantMessageToThread(threadId: string): string;
  updateThreadMessage(threadId: string, messageId: string, updater: (message: StoredMessage) => void): void;
}) {
  const [runningThreadIds, setRunningThreadIds] = useState<string[]>([]);
  const [queuedInstructions, setQueuedInstructions] = useState<QueuedInstruction[]>([]);
  const queuedInstructionsRef = useRef<QueuedInstruction[]>([]);
  const runningTurnsRef = useRef(new Map<string, RunningTurn>());

  const runningThreadSet = useMemo(() => {
    const ids = new Set(runningThreadIds);
    for (const run of input.runs) {
      if (isActiveRunRecord(run) && run.sessionId) {
        ids.add(run.sessionId);
      }
    }
    return ids;
  }, [input.runs, runningThreadIds]);

  const activeThreadIsRunning = runningThreadSet.has(input.threadId);
  const activeThreadPendingAssistant = useMemo(() => latestPendingAssistantMessage(input.messages), [input.messages]);
  const activeThreadCanStop = activeThreadIsRunning || Boolean(activeThreadPendingAssistant);

  function setQueuedInstructionsSynced(updater: (current: QueuedInstruction[]) => QueuedInstruction[]) {
    setQueuedInstructions((current) => {
      const next = updater(current);
      queuedInstructionsRef.current = next;
      return next;
    });
  }

  function syncRunningTurns() {
    const nextThreadIds = [...runningTurnsRef.current.keys()];
    setRunningThreadIds(nextThreadIds);
    input.setSending(nextThreadIds.length > 0);
  }

  function applyAgentRuntimeEventToAssistant(
    turnThreadId: string,
    assistantId: string,
    runtimeEvent: { event: Record<string, unknown> },
  ) {
    withTransientUiUpdate(() => {
      input.updateThreadMessage(turnThreadId, assistantId, (message) => {
        const { approvalRequest, questionRequest } = applyStreamEventToMessage(message, runtimeEvent.event);
        if (approvalRequest) {
          input.queryClient.setQueryData(["approvals"], (previous: ApprovalsResponse | undefined) => ({
            ok: true,
            approvals: [
              ...(previous?.approvals || []).filter((item) => item.id !== approvalRequest.id),
              approvalRequest,
            ],
          }));
        }
        if (questionRequest) {
          input.queryClient.setQueryData(["questions"], (previous: QuestionsResponse | undefined) => ({
            ok: true,
            questions: [
              ...(previous?.questions || []).filter((item) => item.id !== questionRequest.id),
              questionRequest,
            ],
          }));
        }
      });
    });
  }

  async function attachRunningTurn(run: Pick<RunRecord, "id" | "runId" | "sessionId" | "input">, assistantId: string) {
    const runId = runRecordId(run);
    const turnThreadId = String(run.sessionId || "");
    if (!runId || !turnThreadId || runningTurnsRef.current.has(turnThreadId)) {
      return;
    }

    const abortController = new AbortController();
    runningTurnsRef.current.set(turnThreadId, { controller: abortController, assistantId, runId });
    syncRunningTurns();
    input.updateThreadMessage(turnThreadId, assistantId, (message) => {
      message.runId = runId;
      message.pending = true;
    });

    try {
      let resetForReplay = false;
      const finalData = await attachThreadTurn(
        { runId, threadId: turnThreadId },
        {
          signal: abortController.signal,
          onRuntimeEvent(runtimeEvent) {
            if (runtimeEvent.type === "run.start" && runtimeEvent.runId) {
              withTransientUiUpdate(() => {
                input.updateThreadMessage(turnThreadId, assistantId, (message) => {
                  message.runId = runtimeEvent.runId || message.runId;
                  message.pending = true;
                  if (!resetForReplay) {
                    message.text = "";
                    message.parts = [];
                    message.startedAt = undefined;
                    message.finishedAt = undefined;
                    resetForReplay = true;
                  }
                });
              });
            }
          },
          onAgentEvent(runtimeEvent) {
            applyAgentRuntimeEventToAssistant(turnThreadId, assistantId, runtimeEvent);
          },
        },
      );

      input.updateThreadMessage(turnThreadId, assistantId, (message) => {
        finalizeAssistantMessage(message, { answer: finalData.answer, events: finalData.events });
      });
      mergeFinalDataIntoCache(input.queryClient, finalData);
      input.queryClient.invalidateQueries({ queryKey: ["events"] });
    } catch (error) {
      if (!abortController.signal.aborted && isRecoverableStreamDisconnect(error)) {
        input.queryClient.invalidateQueries({ queryKey: ["inventory"] });
        input.queryClient.invalidateQueries({ queryKey: ["events"] });
        return;
      }
      input.updateThreadMessage(turnThreadId, assistantId, (message) => {
        const messageText = error instanceof Error ? error.message : String(error);
        markAssistantMessageError(message, abortController.signal.aborted ? input.t("system.stopped") : messageText);
      });
    } finally {
      const runningTurn = runningTurnsRef.current.get(turnThreadId);
      if (runningTurn?.controller === abortController) {
        runningTurnsRef.current.delete(turnThreadId);
        syncRunningTurns();
      }
    }
  }

  type RunAskTurnOptions = {
    requestedSkill?: { name: string; args?: string };
    targetThreadId?: string;
    appId?: string;
    kernel?: string;
    providerId?: string;
    model?: string;
    planMode?: boolean;
    goalMode?: boolean;
  };

  function captureTurnState(
    userContext: MessageContext | null,
    turnAttachments: AttachmentPayload[],
    options: RunAskTurnOptions = {},
  ): QueuedTurnState {
    return {
      context: cloneMessageContext(userContext),
      attachments: cloneAttachments(turnAttachments),
      requestedSkill: options.requestedSkill ? { ...options.requestedSkill } : undefined,
      model: options.model || input.model,
      kernel: options.kernel,
      providerId: options.providerId,
      appId: options.appId,
      planMode: options.planMode ?? input.planMode,
      goalMode: options.goalMode ?? input.goalMode,
      reasoningEffort: input.reasoningEffort,
      responseSpeed: input.responseSpeed,
      budgetLimitUsd: input.budgetLimitUsd,
      accessMode: input.accessMode,
    };
  }

  async function runAskTurn(
    userPrompt: string,
    userContext: MessageContext | null,
    turnAttachments: AttachmentPayload[],
    options: RunAskTurnOptions = {},
  ) {
    const turnThreadId = options.targetThreadId ?? input.threadId;
    const turnState = captureTurnState(userContext, turnAttachments, options);
    await runCapturedAskTurn(turnThreadId, userPrompt, turnState);
  }

  async function runCapturedAskTurn(turnThreadId: string, userPrompt: string, turnState: QueuedTurnState) {
    if (runningTurnsRef.current.has(turnThreadId)) {
      queueInstruction(turnThreadId, userPrompt, turnState);
      return;
    }
    input.appendMessageToThread(turnThreadId, "user", userPrompt, turnState.context);
    const assistantId = input.appendAssistantMessageToThread(turnThreadId);
    const abortController = new AbortController();
    runningTurnsRef.current.set(turnThreadId, { controller: abortController, assistantId });
    syncRunningTurns();

    try {
      const finalData = await runThreadTurn(
        {
          question: userPrompt,
          model: turnState.model,
          kernel: turnState.kernel,
          providerId: turnState.providerId,
          effort: turnState.reasoningEffort,
          responseSpeed: turnState.responseSpeed,
          budgetLimitUsd: turnState.budgetLimitUsd ?? undefined,
          accessMode: turnState.accessMode,
          planMode: turnState.planMode,
          goalMode: turnState.goalMode,
          threadId: turnThreadId,
          appId: turnState.appId,
          snapshot: createSnapshot(turnState.context, turnState.attachments),
          computerSnapshot: {},
          allowMemory: false,
          saveCandidateNote: false,
          requestedSkill: turnState.requestedSkill,
        },
        {
          signal: abortController.signal,
          onRuntimeEvent(runtimeEvent) {
            if (runtimeEvent.type !== "run.start" || !runtimeEvent.runId) {
              return;
            }
            const runningTurn = runningTurnsRef.current.get(turnThreadId);
            if (runningTurn?.controller === abortController) {
              runningTurn.runId = runtimeEvent.runId;
              runningTurnsRef.current.set(turnThreadId, runningTurn);
            }
            withTransientUiUpdate(() => {
              input.updateThreadMessage(turnThreadId, assistantId, (message) => {
                message.runId = runtimeEvent.runId || message.runId;
                message.pending = true;
              });
            });
          },
          onAgentEvent(runtimeEvent) {
            applyAgentRuntimeEventToAssistant(turnThreadId, assistantId, runtimeEvent);
          },
        },
      );

      input.updateThreadMessage(turnThreadId, assistantId, (message) => {
        finalizeAssistantMessage(message, { answer: finalData.answer, events: finalData.events });
      });
      mergeFinalDataIntoCache(input.queryClient, finalData);
      input.queryClient.invalidateQueries({ queryKey: ["events"] });
    } catch (error) {
      if (!abortController.signal.aborted && isRecoverableStreamDisconnect(error)) {
        input.queryClient.invalidateQueries({ queryKey: ["inventory"] });
        input.queryClient.invalidateQueries({ queryKey: ["events"] });
        return;
      }
      input.updateThreadMessage(turnThreadId, assistantId, (message) => {
        const messageText = error instanceof Error ? error.message : String(error);
        markAssistantMessageError(message, abortController.signal.aborted ? input.t("system.stopped") : messageText);
      });
    } finally {
      const runningTurn = runningTurnsRef.current.get(turnThreadId);
      if (runningTurn?.controller === abortController) {
        runningTurnsRef.current.delete(turnThreadId);
        syncRunningTurns();
      }
      const queuedPrompt = queuedInstructionsRef.current.find(
        (item) => item.threadId === turnThreadId && item.status === "queued",
      );
      if (queuedPrompt) {
        setQueuedInstructionsSynced((items) => items.filter((item) => item.id !== queuedPrompt.id));
        window.setTimeout(() => {
          void runCapturedAskTurn(turnThreadId, queuedPrompt.prompt, queuedPrompt.turnState);
        }, 0);
      }
    }
  }

  function stopActiveTurn() {
    const runningTurn = runningTurnsRef.current.get(input.threadId);
    runningTurn?.controller.abort();
    const activeRun = input.runs.find((run) => isActiveRunRecord(run) && run.sessionId === input.threadId);
    const pendingAssistant = latestPendingAssistantMessage(input.messages);
    const runId = runningTurn?.runId || runRecordId(activeRun) || pendingAssistant?.runId;
    void cancelAskStream({ runId: runId || undefined, threadId: input.threadId });
    if (!runningTurn && pendingAssistant) {
      input.updateThreadMessage(input.threadId, pendingAssistant.id, (message) => {
        markAssistantMessageError(message, input.t("system.stopped"));
      });
    }
  }

  function queuePrompt(threadId: string, prompt: string, options: RunAskTurnOptions = {}) {
    queueInstruction(threadId, prompt, captureTurnState(null, [], options));
  }

  function queueInstruction(threadId: string, prompt: string, turnState: QueuedTurnState) {
    const trimmed = prompt.trim();
    if (!threadId || !trimmed) {
      return;
    }
    setQueuedInstructionsSynced((items) => [
      ...items,
      {
        id: `queued_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
        threadId,
        prompt: trimmed,
        createdAt: new Date().toISOString(),
        status: "queued",
        turnState,
      },
    ]);
  }

  function removeQueuedInstruction(id: string) {
    setQueuedInstructionsSynced((items) => items.filter((item) => item.id !== id));
  }

  function updateQueuedInstruction(id: string, prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    setQueuedInstructionsSynced((items) =>
      items.map((item) =>
        item.id === id ? { ...item, prompt: trimmed, status: "queued", lastError: undefined } : item,
      ),
    );
  }

  function moveQueuedInstruction(id: string, direction: "up" | "down") {
    setQueuedInstructionsSynced((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return items;
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= items.length || items[targetIndex]?.threadId !== items[index]?.threadId) {
        return items;
      }
      const next = [...items];
      const [item] = next.splice(index, 1);
      next.splice(targetIndex, 0, item!);
      return next;
    });
  }

  async function guideQueuedInstruction(id: string) {
    const queued = queuedInstructionsRef.current.find((item) => item.id === id);
    if (!queued || queued.status === "guiding") {
      return;
    }
    const runningTurn = runningTurnsRef.current.get(queued.threadId);
    const activeRun = input.runs.find((run) => isActiveRunRecord(run) && run.sessionId === queued.threadId);
    const runId = runningTurn?.runId || runRecordId(activeRun);
    if (!runId) {
      setQueuedInstructionsSynced((items) =>
        items.map((item) =>
          item.id === id ? { ...item, status: "guide-failed", lastError: input.t("composer.guideNotReady") } : item,
        ),
      );
      return;
    }
    setQueuedInstructionsSynced((items) =>
      items.map((item) => (item.id === id ? { ...item, status: "guiding", lastError: undefined } : item)),
    );
    try {
      const result = await guideAskStream({
        runId,
        threadId: queued.threadId,
        instruction: queued.prompt,
      });
      if (result.guided) {
        removeQueuedInstruction(id);
        return;
      }
      setQueuedInstructionsSynced((items) =>
        items.map((item) =>
          item.id === id
            ? { ...item, status: "guide-failed", lastError: result.error || input.t("composer.guideFailed") }
            : item,
        ),
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      setQueuedInstructionsSynced((items) =>
        items.map((item) => (item.id === id ? { ...item, status: "guide-failed", lastError: messageText } : item)),
      );
    }
  }

  async function submitQueuedInstructionNow(id: string, options: Parameters<typeof runAskTurn>[3] = {}) {
    const queued = queuedInstructionsRef.current.find((item) => item.id === id);
    if (!queued || queued.status === "guiding") {
      return;
    }
    if (runningTurnsRef.current.has(queued.threadId)) {
      const before = queuedInstructionsRef.current;
      await guideQueuedInstruction(id);
      if (queuedInstructionsRef.current === before) {
        moveQueuedInstruction(id, "up");
      }
      return;
    }
    removeQueuedInstruction(id);
    await runCapturedAskTurn(options.targetThreadId ?? queued.threadId, queued.prompt, queued.turnState);
  }

  useEffect(() => {
    for (const run of input.runs) {
      const runId = runRecordId(run);
      const runThreadId = String(run.sessionId || "");
      if (!isActiveRunRecord(run) || !runId || !runThreadId || runningTurnsRef.current.has(runThreadId)) {
        continue;
      }
      const threadMessages = messagesForUiThread(input.threads, input.threadId, input.messages, runThreadId);
      const assistantId = findAttachableAssistantMessageId(
        threadMessages,
        runId,
        isFreshRunRecord(run) ? run.input : "",
      );
      if (!assistantId) {
        continue;
      }
      void attachRunningTurn(run, assistantId);
    }
  }, [input.messages, input.runs, input.threadId, input.threads]);

  useEffect(() => {
    for (const run of input.runs) {
      const runId = runRecordId(run);
      const runThreadId = String(run.sessionId || "");
      if (isActiveRunRecord(run) || !runId || !runThreadId) {
        continue;
      }
      const runEvents = input.events.filter((event) => event?.runId === runId);
      if (!runEvents.length) {
        continue;
      }
      const threadMessages = messagesForUiThread(input.threads, input.threadId, input.messages, runThreadId);
      const assistantId = findAttachableAssistantMessageId(
        threadMessages,
        runId,
        isFreshRunRecord(run) ? run.input : "",
      );
      if (!assistantId) {
        continue;
      }
      input.updateThreadMessage(runThreadId, assistantId, (message) => {
        message.runId = runId;
        message.text = "";
        message.parts = [];
        message.pending = true;
        for (const event of runEvents) {
          applyStreamEventToMessage(message, event);
        }
        finalizeAssistantMessage(message, { events: runEvents });
      });
    }
  }, [input.events, input.messages, input.runs, input.threadId, input.threads, input.updateThreadMessage]);

  return {
    runningThreadIds,
    runningThreadSet,
    activeThreadIsRunning,
    activeThreadPendingAssistant,
    activeThreadCanStop,
    queuedInstructions,
    queuePrompt,
    removeQueuedInstruction,
    updateQueuedInstruction,
    moveQueuedInstruction,
    guideQueuedInstruction,
    submitQueuedInstructionNow,
    runAskTurn,
    stopActiveTurn,
  };
}
