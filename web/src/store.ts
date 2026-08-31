import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AttachmentPayload,
  ContextArtifactPayload,
  JsonValue,
  MessagePart,
  ModelId,
  StoredMessage,
  ViewId,
} from "./bridge";
import type { MessageContext } from "./bridge";
import { createClientId, DEFAULT_MODEL_ID, supportedModel, supportedView } from "./bridge";
import { clamp, formatNumber } from "./format";
import { APP_DEFAULT_PROJECT_ID, APP_DEFAULT_PROJECT_TITLE, APP_STORAGE_KEYS } from "./identity";
import { closeDanglingMessageActivity, isModelCallErrorText } from "./messages";
import { toSafeJsonValue } from "./safe-json";
import { readLanguagePreference, resolveLanguage, translate } from "./i18n";

const MAX_RENDERED_MESSAGES = 80;
const MAX_STORED_JSON_STRING = 8_000;
const MIN_COMPOSER_HEIGHT = 56;
const MAX_COMPOSER_HEIGHT = 88;
const DEFAULT_PROJECT_ID = APP_DEFAULT_PROJECT_ID;
const DEFAULT_PROJECT_TITLE = APP_DEFAULT_PROJECT_TITLE;
// 匹配历史持久化消息文本（生产方已下线），保留原文；不做翻译。
const SYNTHETIC_QUESTION_RESOLUTION_MESSAGES = new Set(["已回答问题。", "已跳过问题。", "这个问题已经处理过了。"]);

// 处理单个流式事件的同步时间片内跳过整线程 sanitize 和 localStorage 写入。
// 调用方不得跨异步等待持有该计数，避免阻塞其他用户操作的持久化。
let transientUpdateDepth = 0;

export function beginTransientUiUpdates(): void {
  transientUpdateDepth += 1;
}

export function endTransientUiUpdates(): void {
  transientUpdateDepth = Math.max(0, transientUpdateDepth - 1);
}

function transientUiUpdatesActive(): boolean {
  return transientUpdateDepth > 0;
}

export interface UiProject {
  id: string;
  title: string;
  workspaceRoot?: string;
  updatedAt: string;
}

export interface UiThread {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  messages: StoredMessage[];
}

interface UiState {
  model: ModelId;
  messages: StoredMessage[];
  sending: boolean;
  activeView: ViewId;
  projectId: string;
  projects: UiProject[];
  threads: UiThread[];
  threadId: string;
  composerHeight: number;
  contextText: string;
  setModel(model: string): void;
  setView(view: string): void;
  setSending(sending: boolean): void;
  setComposerHeight(height: number): void;
  setContextText(text: string): void;
  clearContext(): void;
  appendMessage(
    role: StoredMessage["role"],
    text: string,
    context?: MessageContext | null,
    options?: { parts?: MessagePart[]; pending?: boolean; runId?: string },
  ): string;
  appendMessageToThread(
    threadId: string,
    role: StoredMessage["role"],
    text: string,
    context?: MessageContext | null,
    options?: { parts?: MessagePart[]; pending?: boolean; runId?: string },
  ): string;
  appendAssistantMessage(): string;
  appendAssistantMessageToThread(threadId: string): string;
  updateMessage(messageId: string, updater: (message: StoredMessage) => void): void;
  updateThreadMessage(threadId: string, messageId: string, updater: (message: StoredMessage) => void): void;
  replaceMessages(messages: StoredMessage[]): void;
  startNewThread(projectId?: string): string;
  startNewProject(options?: { title?: string; workspaceRoot?: string }): string;
  renameProject(projectId: string, title: string): void;
  setProjectWorkspaceRoot(projectId: string, workspaceRoot: string): void;
  selectThread(threadId: string): void;
  deleteThread(threadId: string): void;
  deleteProject(projectId: string): void;
}

function createThreadId(): string {
  return `standalone:${Date.now().toString(36)}:${Math.random().toString(16).slice(2)}`;
}

function trimMessages(messages: StoredMessage[]): StoredMessage[] {
  const trimmed = messages.slice(-MAX_RENDERED_MESSAGES);
  // 流式期间保持消息引用稳定（仅截断），完整 sanitize 推迟到 finalize 后的 set。
  return transientUiUpdatesActive() ? trimmed : sanitizeMessages(trimmed);
}

function sanitizeMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages
    .filter((message): message is StoredMessage => Boolean(message && typeof message === "object"))
    .filter((message) => !isSyntheticQuestionResolutionMessage(message))
    .map((message) => {
      const sanitized = {
        ...message,
        text: typeof message.text === "string" ? message.text : "",
        context: message.context ? { ...message.context } : null,
        parts: Array.isArray(message.parts) ? message.parts.map(sanitizeMessagePart) : [],
        pending: Boolean(message.pending),
        runId: typeof message.runId === "string" ? message.runId : "",
        startedAt: typeof message.startedAt === "string" ? message.startedAt : undefined,
        finishedAt: typeof message.finishedAt === "string" ? message.finishedAt : undefined,
      };
      if (!sanitized.pending) {
        const errorMessage = terminalMessageError(sanitized);
        closeDanglingMessageActivity(sanitized, {
          status: errorMessage ? "failed" : "complete",
          errorMessage,
        });
      }
      return sanitized;
    });
}

function isSyntheticQuestionResolutionMessage(message: StoredMessage): boolean {
  if (message.role !== "system") {
    return false;
  }
  if (message.context || message.pending || message.runId || message.parts?.length) {
    return false;
  }
  return SYNTHETIC_QUESTION_RESOLUTION_MESSAGES.has(String(message.text || "").trim());
}

function sanitizeMessagePart(part: MessagePart): MessagePart {
  if (part?.type !== "tool") {
    return part;
  }
  return {
    ...part,
    input: sanitizeJsonValue(part.input),
    result: sanitizeJsonValue(part.result),
    approvalInput: sanitizeJsonValue(part.approvalInput),
    questionInput: sanitizeJsonValue(part.questionInput),
  };
}

function terminalMessageError(message: StoredMessage): string {
  const errorNote = (message.parts || []).find((part) => part.type === "note" && part.tone === "error" && part.text);
  if (errorNote?.type === "note") {
    return errorNote.text;
  }
  const text = String(message.text || "").trim();
  return isModelCallErrorText(text) ? text : "";
}

function sanitizeJsonValue(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  return toSafeJsonValue(value, {
    transformString(text, childKey) {
      if ((childKey === "result" || text.length > MAX_STORED_JSON_STRING) && text.length > 512) {
        return `[omitted ${formatNumber(text.length)} chars]`;
      }
      return text;
    },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function createProjectId(): string {
  return `project:${Date.now().toString(36)}:${Math.random().toString(16).slice(2)}`;
}

function createProject(title: string, workspaceRoot?: string): UiProject {
  return {
    id: createProjectId(),
    title,
    workspaceRoot: normalizeWorkspaceRoot(workspaceRoot),
    updatedAt: nowIso(),
  };
}

function createDefaultProject(): UiProject {
  return {
    id: DEFAULT_PROJECT_ID,
    title: DEFAULT_PROJECT_TITLE,
    updatedAt: nowIso(),
  };
}

function createThread(threadId: string, projectId: string, messages: StoredMessage[] = []): UiThread {
  return {
    id: threadId,
    projectId,
    title: deriveThreadTitle(messages),
    updatedAt: nowIso(),
    messages: trimMessages(messages),
  };
}

function normalizeWorkspaceRoot(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function deriveThreadTitle(messages: StoredMessage[], fallback = translate("conversation.newThreadFallback")): string {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.text.trim());
  if (!firstUserMessage) {
    return fallback;
  }
  const singleLine = firstUserMessage.text.replace(/\s+/g, " ").trim();
  return singleLine.length > 28 ? `${singleLine.slice(0, 28)}...` : singleLine;
}

function hasRecordableThreadContent(messages: StoredMessage[]): boolean {
  return messages.some((message) => message.role === "user" && Boolean(message.text.trim()));
}

function syncActiveThread(state: UiState, messages: StoredMessage[]): Pick<UiState, "messages" | "threads"> {
  return syncThreadMessages(state, state.threadId, messages, state.projectId) as Pick<UiState, "messages" | "threads">;
}

function syncThreadMessages(
  state: UiState,
  threadId: string,
  messages: StoredMessage[],
  targetProjectId?: string,
): Partial<Pick<UiState, "messages" | "threads">> {
  const trimmedMessages = trimMessages(messages);
  const updatedAt = nowIso();
  const existing = state.threads.find((thread) => thread.id === threadId);
  const withoutThread = state.threads.filter((thread) => thread.id !== threadId);
  if (!existing && !hasRecordableThreadContent(trimmedMessages)) {
    return threadId === state.threadId
      ? { messages: trimmedMessages, threads: withoutThread }
      : { threads: withoutThread };
  }
  const projectId =
    targetProjectId ||
    existing?.projectId ||
    (threadId === state.threadId ? state.projectId : "") ||
    DEFAULT_PROJECT_ID;
  const nextThread: UiThread = {
    id: threadId,
    projectId,
    title: deriveThreadTitle(trimmedMessages, existing?.title || translate("conversation.newThreadFallback")),
    updatedAt,
    messages: trimmedMessages,
  };
  const threads = [nextThread, ...withoutThread];
  return threadId === state.threadId ? { messages: trimmedMessages, threads } : { threads };
}

function messagesForThread(state: UiState, threadId: string): StoredMessage[] {
  if (threadId === state.threadId) {
    return state.messages;
  }
  return state.threads.find((thread) => thread.id === threadId)?.messages ?? [];
}

function normalizeProjects(value: unknown): UiProject[] {
  const projects = Array.isArray(value)
    ? value
        .filter((item) => item && typeof item === "object")
        .filter((item: any) => item.kind !== "folder" && item.id !== "folder:code-projects")
        .map((item: any) => ({
          id: typeof item.id === "string" && item.id ? item.id : createProjectId(),
          title: typeof item.title === "string" && item.title ? item.title : DEFAULT_PROJECT_TITLE,
          workspaceRoot: normalizeWorkspaceRoot(item.workspaceRoot),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
        }))
    : [];
  return projects.length ? projects : [createDefaultProject()];
}

function normalizeThreads(value: unknown, threadId: string, projectId: string, messages: StoredMessage[]): UiThread[] {
  const threads = Array.isArray(value)
    ? value
        .filter((item) => item && typeof item === "object")
        .map((item: any) => ({
          id: typeof item.id === "string" && item.id ? item.id : createThreadId(),
          projectId: typeof item.projectId === "string" && item.projectId ? item.projectId : projectId,
          title: typeof item.title === "string" && item.title ? item.title : deriveThreadTitle(item.messages || []),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
          messages: trimMessages(Array.isArray(item.messages) ? item.messages : []),
        }))
        .filter((thread) => hasRecordableThreadContent(thread.messages))
    : [];
  if (threads.some((thread) => thread.id === threadId)) {
    return threads;
  }
  if (!hasRecordableThreadContent(messages)) {
    return threads;
  }
  return [createThread(threadId, projectId, messages), ...threads];
}

interface PersistedUiState {
  model: ModelId;
  messages: StoredMessage[];
  activeView: ViewId;
  projectId: string;
  projects: UiProject[];
  threads: UiThread[];
  threadId: string;
  composerHeight: number;
}

let lastPersistedUiState: PersistedUiState | null = null;

function partializeUiState(state: UiState): PersistedUiState {
  // 流式期间复用最近一次完整快照，避免每个 token 都对全部线程做 sanitize。
  if (transientUiUpdatesActive() && lastPersistedUiState) {
    return lastPersistedUiState;
  }
  const persisted: PersistedUiState = {
    model: state.model,
    messages: sanitizeMessages(state.messages),
    activeView: state.activeView,
    projectId: state.projectId,
    projects: state.projects,
    threads: state.threads.map((thread) => ({
      ...thread,
      messages: sanitizeMessages(thread.messages),
    })),
    threadId: state.threadId,
    composerHeight: state.composerHeight,
  };
  lastPersistedUiState = persisted;
  return persisted;
}

function normalizePersistedUiEnvelope(value: unknown): { state: PersistedUiState; version?: number } | null {
  const envelope = recordValue(value);
  const source = recordValue(envelope.state);
  if (!Object.keys(source).length) return null;
  const projectId = stringValue(source.projectId) || DEFAULT_PROJECT_ID;
  const threadId = stringValue(source.threadId) || createThreadId();
  const messages = normalizePersistedMessages(source.messages);
  return {
    state: {
      model: supportedModel(stringValue(source.model) || DEFAULT_MODEL_ID),
      messages,
      activeView: supportedView(stringValue(source.activeView) || "chat"),
      projectId,
      projects: normalizeProjects(source.projects),
      threads: normalizeThreads(source.threads, threadId, projectId, messages),
      threadId,
      composerHeight: clamp(
        Number(source.composerHeight || MIN_COMPOSER_HEIGHT),
        MIN_COMPOSER_HEIGHT,
        MAX_COMPOSER_HEIGHT,
      ),
    },
    ...(typeof envelope.version === "number" ? { version: envelope.version } : {}),
  };
}

function normalizePersistedMessages(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<StoredMessage>((entry): StoredMessage[] => {
    const message = recordValue(entry);
    const role =
      message.role === "user" || message.role === "assistant" || message.role === "system" ? message.role : undefined;
    if (!role) return [];
    return [
      {
        id: stringValue(message.id) || createClientId("message"),
        role,
        text: stringValue(message.text),
        context: normalizePersistedMessageContext(message.context),
        parts: normalizePersistedMessageParts(message.parts),
        pending: message.pending === true,
        runId: stringValue(message.runId),
        ...(stringValue(message.startedAt) ? { startedAt: stringValue(message.startedAt) } : {}),
        ...(stringValue(message.finishedAt) ? { finishedAt: stringValue(message.finishedAt) } : {}),
      },
    ];
  });
}

function normalizePersistedMessageContext(value: unknown): MessageContext | null {
  const context = recordValue(value);
  if (!Object.keys(context).length) return null;
  const attachments = normalizePersistedAttachments(context.attachments);
  const artifacts = normalizePersistedContextArtifacts(context.artifacts);
  return {
    text: stringValue(context.text),
    ...(stringValue(context.selectedText) ? { selectedText: stringValue(context.selectedText) } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
}

function normalizePersistedAttachments(value: unknown): AttachmentPayload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const attachment = recordValue(entry);
    const kind =
      attachment.kind === "image" || attachment.kind === "text" || attachment.kind === "file"
        ? attachment.kind
        : undefined;
    if (!kind) return [];
    return [
      {
        id: stringValue(attachment.id) || createClientId("attachment"),
        name: stringValue(attachment.name),
        kind,
        mimeType: stringValue(attachment.mimeType),
        size: typeof attachment.size === "number" && Number.isFinite(attachment.size) ? attachment.size : 0,
        ...(stringValue(attachment.text) ? { text: stringValue(attachment.text) } : {}),
        ...(stringValue(attachment.dataUrl) ? { dataUrl: stringValue(attachment.dataUrl) } : {}),
        ...(stringValue(attachment.thumbnailUrl) ? { thumbnailUrl: stringValue(attachment.thumbnailUrl) } : {}),
        ...(stringValue(attachment.error) ? { error: stringValue(attachment.error) } : {}),
      },
    ];
  });
}

function normalizePersistedContextArtifacts(value: unknown): ContextArtifactPayload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const artifact = recordValue(entry);
    const id = stringValue(artifact.id);
    if (!id) return [];
    return [
      {
        id,
        title: stringValue(artifact.title),
        type: stringValue(artifact.type),
        summary: stringValue(artifact.summary),
        ...(stringValue(artifact.imageUri) ? { imageUri: stringValue(artifact.imageUri) } : {}),
      },
    ];
  });
}

function normalizePersistedMessageParts(value: unknown): MessagePart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<MessagePart>((entry): MessagePart[] => {
    const part = recordValue(entry);
    const id = stringValue(part.id) || createClientId("part");
    switch (part.type) {
      case "text":
        return [{ id, type: "text" as const, text: stringValue(part.text) }];
      case "note":
        return [
          {
            id,
            type: "note" as const,
            text: stringValue(part.text),
            tone: stringValue(part.tone),
            ...(part.data !== undefined ? { data: toSafeJsonValue(part.data) } : {}),
          },
        ];
      case "reasoning":
        return [
          {
            id,
            type: "reasoning" as const,
            reasoningId: stringValue(part.reasoningId),
            kernelId: stringValue(part.kernelId),
            kind: part.kind === "summary" ? ("summary" as const) : ("native" as const),
            text: stringValue(part.text),
            status: stringValue(part.status),
            redacted: part.redacted === true,
            ...(typeof part.elapsedMs === "number" ? { elapsedMs: part.elapsedMs } : {}),
          },
        ];
      case "tool":
        return [
          {
            id,
            type: "tool" as const,
            phase: stringValue(part.phase),
            toolId: stringValue(part.toolId),
            ...(stringValue(part.callId) ? { callId: stringValue(part.callId) } : {}),
            title: stringValue(part.title),
            ...(part.input !== undefined ? { input: toSafeJsonValue(part.input) } : {}),
            status: stringValue(part.status),
            ...(part.result !== undefined ? { result: toSafeJsonValue(part.result) } : {}),
            error: stringValue(part.error),
            approvalId: stringValue(part.approvalId),
            approvalStatus: stringValue(part.approvalStatus),
            approvalReason: stringValue(part.approvalReason),
            ...(part.approvalInput !== undefined ? { approvalInput: toSafeJsonValue(part.approvalInput) } : {}),
            questionId: stringValue(part.questionId),
            questionStatus: stringValue(part.questionStatus),
            questionPrompt: stringValue(part.questionPrompt),
            ...(part.questionInput !== undefined ? { questionInput: toSafeJsonValue(part.questionInput) } : {}),
          },
        ];
      case "skill":
        return [
          {
            id,
            type: "skill" as const,
            skillId: stringValue(part.skillId),
            skillName: stringValue(part.skillName),
            title: stringValue(part.title),
            status: stringValue(part.status),
            contentPreview: stringValue(part.contentPreview),
            allowedTools: Array.isArray(part.allowedTools) ? part.allowedTools.map(stringValue).filter(Boolean) : [],
            model: stringValue(part.model),
            effort: stringValue(part.effort),
            forkSessionId: stringValue(part.forkSessionId),
            result: stringValue(part.result),
            description: stringValue(part.description),
            whenToUse: stringValue(part.whenToUse),
            source: stringValue(part.source),
            trust: stringValue(part.trust),
            context: stringValue(part.context),
            packId: stringValue(part.packId),
          },
        ];
      default:
        return [];
    }
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      model: supportedModel(localStorage.getItem(APP_STORAGE_KEYS.uiModel) || DEFAULT_MODEL_ID),
      messages: [],
      sending: false,
      activeView: supportedView(localStorage.getItem(APP_STORAGE_KEYS.uiView) || "chat"),
      projectId: DEFAULT_PROJECT_ID,
      projects: [createDefaultProject()],
      threads: [],
      threadId: localStorage.getItem(APP_STORAGE_KEYS.uiThreadId) || createThreadId(),
      composerHeight: MIN_COMPOSER_HEIGHT,
      contextText: "",
      setModel(model) {
        set({ model: supportedModel(model) });
      },
      setView(view) {
        set({ activeView: supportedView(view) });
      },
      setSending(sending) {
        set({ sending });
      },
      setComposerHeight(height) {
        set({ composerHeight: clamp(height, MIN_COMPOSER_HEIGHT, MAX_COMPOSER_HEIGHT) });
      },
      setContextText(text) {
        set({ contextText: text });
      },
      clearContext() {
        set({ contextText: "" });
      },
      appendMessage(role, text, context, options) {
        const id = createClientId("msg");
        set((state) => ({
          ...syncActiveThread(state, [
            ...state.messages,
            {
              id,
              role,
              text,
              context: context || null,
              parts: options?.parts || [],
              pending: options?.pending === true,
              runId: options?.runId || "",
              startedAt: undefined,
              finishedAt: undefined,
            },
          ]),
        }));
        return id;
      },
      appendMessageToThread(threadId, role, text, context, options) {
        const id = createClientId("msg");
        set((state) => ({
          ...syncThreadMessages(state, threadId, [
            ...messagesForThread(state, threadId),
            {
              id,
              role,
              text,
              context: context || null,
              parts: options?.parts || [],
              pending: options?.pending === true,
              runId: options?.runId || "",
              startedAt: undefined,
              finishedAt: undefined,
            },
          ]),
        }));
        return id;
      },
      appendAssistantMessage() {
        const id = createClientId("msg");
        set((state) => ({
          ...syncActiveThread(state, [
            ...state.messages,
            {
              id,
              role: "assistant",
              text: "",
              context: null,
              parts: [],
              pending: true,
              runId: "",
              startedAt: undefined,
              finishedAt: undefined,
            },
          ]),
        }));
        return id;
      },
      appendAssistantMessageToThread(threadId) {
        const id = createClientId("msg");
        set((state) => ({
          ...syncThreadMessages(state, threadId, [
            ...messagesForThread(state, threadId),
            {
              id,
              role: "assistant",
              text: "",
              context: null,
              parts: [],
              pending: true,
              runId: "",
              startedAt: undefined,
              finishedAt: undefined,
            },
          ]),
        }));
        return id;
      },
      updateMessage(messageId, updater) {
        set((state) => ({
          ...syncActiveThread(
            state,
            state.messages.map((message) => {
              if (message.id !== messageId) {
                return message;
              }
              const next = {
                ...message,
                context: message.context ? { ...message.context } : null,
                parts: [...message.parts],
              };
              updater(next);
              return next;
            }),
          ),
        }));
      },
      updateThreadMessage(threadId, messageId, updater) {
        set((state) => {
          let updated = false;
          const messages = messagesForThread(state, threadId).map((message) => {
            if (message.id !== messageId) {
              return message;
            }
            updated = true;
            const next = {
              ...message,
              context: message.context ? { ...message.context } : null,
              parts: [...message.parts],
            };
            updater(next);
            return next;
          });
          return updated ? syncThreadMessages(state, threadId, messages) : {};
        });
      },
      replaceMessages(messages) {
        set((state) => syncActiveThread(state, messages));
      },
      startNewThread(targetProjectId) {
        const id = createThreadId();
        set((state) => {
          const projectId = targetProjectId || state.projectId || DEFAULT_PROJECT_ID;
          return {
            activeView: "chat",
            contextText: "",
            projectId,
            threadId: id,
            messages: [],
            threads: state.threads.filter((thread) => thread.id !== id),
          };
        });
        return id;
      },
      startNewProject(options = {}) {
        const language = resolveLanguage(readLanguagePreference());
        const date = new Date().toLocaleDateString(language, { month: "numeric", day: "numeric" });
        const defaultTitle = translate("conversation.defaultProjectTitle", { date });
        const project = createProject(options.title?.trim() || defaultTitle, options.workspaceRoot);
        const threadId = createThreadId();
        set((state) => ({
          activeView: "chat",
          contextText: "",
          projectId: project.id,
          projects: [project, ...state.projects],
          threadId,
          messages: [],
          threads: state.threads,
        }));
        return project.id;
      },
      renameProject(targetProjectId, title) {
        const nextTitle = title.trim();
        if (!nextTitle) {
          return;
        }
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === targetProjectId
              ? {
                  ...project,
                  title: nextTitle,
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      setProjectWorkspaceRoot(targetProjectId, workspaceRoot) {
        const normalized = normalizeWorkspaceRoot(workspaceRoot);
        if (!normalized) {
          return;
        }
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === targetProjectId
              ? {
                  ...project,
                  workspaceRoot: normalized,
                  updatedAt: nowIso(),
                }
              : project,
          ),
        }));
      },
      selectThread(nextThreadId) {
        set((state) => {
          const thread = state.threads.find((item) => item.id === nextThreadId);
          if (!thread) {
            return { activeView: "chat" };
          }
          return {
            activeView: "chat",
            projectId: thread.projectId,
            threadId: thread.id,
            messages: trimMessages(thread.messages),
          };
        });
      },
      deleteThread(targetThreadId) {
        set((state) => {
          const nextThreads = state.threads.filter((thread) => thread.id !== targetThreadId);
          if (targetThreadId !== state.threadId) {
            return { threads: nextThreads };
          }

          const fallbackThread = nextThreads.find((thread) => thread.projectId === state.projectId) ?? nextThreads[0];
          if (fallbackThread) {
            return {
              activeView: "chat",
              contextText: "",
              projectId: fallbackThread.projectId,
              threadId: fallbackThread.id,
              messages: trimMessages(fallbackThread.messages),
              threads: nextThreads,
            };
          }

          const projectId = state.projectId || state.projects[0]?.id || DEFAULT_PROJECT_ID;
          const threadId = createThreadId();
          return {
            activeView: "chat",
            contextText: "",
            projectId,
            threadId,
            messages: [],
            threads: nextThreads,
          };
        });
      },
      deleteProject(targetProjectId) {
        set((state) => {
          const nextProjects = state.projects.filter((project) => project.id !== targetProjectId);
          const projects = nextProjects.length ? nextProjects : [createDefaultProject()];
          const nextThreads = state.threads.filter((thread) => thread.projectId !== targetProjectId);
          const activeProjectDeleted = state.projectId === targetProjectId;
          const activeThreadDeleted = state.threads.some(
            (thread) => thread.id === state.threadId && thread.projectId === targetProjectId,
          );

          if (!activeProjectDeleted && !activeThreadDeleted) {
            return { projects, threads: nextThreads };
          }

          const fallbackProject = projects[0]!;
          const fallbackThread = nextThreads.find((thread) => thread.projectId === fallbackProject.id);
          if (fallbackThread) {
            return {
              activeView: "chat",
              contextText: "",
              projectId: fallbackProject.id,
              projects,
              threadId: fallbackThread.id,
              messages: trimMessages(fallbackThread.messages),
              threads: nextThreads,
            };
          }

          const threadId = createThreadId();
          return {
            activeView: "chat",
            contextText: "",
            projectId: fallbackProject.id,
            projects,
            threadId,
            messages: [],
            threads: nextThreads,
          };
        });
      },
    }),
    {
      name: APP_STORAGE_KEYS.uiState,
      storage: {
        getItem(name) {
          const raw = localStorage.getItem(name);
          if (!raw) {
            return null;
          }
          try {
            return normalizePersistedUiEnvelope(JSON.parse(raw));
          } catch {
            return null;
          }
        },
        setItem(name, value) {
          // 流式期间跳过逐 token 的同步写入；finalize 后的 set 会立即落盘。
          if (transientUiUpdatesActive()) {
            return;
          }
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem(name) {
          localStorage.removeItem(name);
        },
      },
      partialize: partializeUiState,
      merge(persisted, current) {
        const saved = (persisted || {}) as Partial<UiState>;
        const projectId = typeof saved.projectId === "string" && saved.projectId ? saved.projectId : DEFAULT_PROJECT_ID;
        const threadId = typeof saved.threadId === "string" && saved.threadId ? saved.threadId : current.threadId;
        const messages = trimMessages(Array.isArray(saved.messages) ? saved.messages : current.messages);
        return {
          ...current,
          ...saved,
          model: supportedModel(String(saved.model || current.model)),
          activeView: supportedView(String(saved.activeView || current.activeView)),
          projectId,
          projects: normalizeProjects(saved.projects),
          threads: normalizeThreads(saved.threads, threadId, projectId, messages),
          threadId,
          messages,
          composerHeight: clamp(
            Number(saved.composerHeight || current.composerHeight),
            MIN_COMPOSER_HEIGHT,
            MAX_COMPOSER_HEIGHT,
          ),
          sending: false,
          contextText: "",
        };
      },
    },
  ),
);
