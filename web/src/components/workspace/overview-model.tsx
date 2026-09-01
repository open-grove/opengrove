import {
  AlertCircle,
  CheckCircle2,
  Circle,
  File as FileIcon,
  FileText,
  Globe2,
  Image as ImageIcon,
  LoaderCircle,
  Monitor,
  Package,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { StoredMessage } from "../../bridge";
import { formatDate, sortedArtifacts, summarize, uniqueIds } from "../../format";
import { rawDiagnosticText, translate } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import type { RunRecord } from "../../bridge-inventory-types";
import { runOverviewStatus, type RunOverviewStatus } from "../../runtime/run-lifecycle";

export type OverviewStatus = RunOverviewStatus;

export interface OverviewProgressItem {
  id: string;
  title: string;
  status: OverviewStatus;
  detail?: string;
}

export interface OverviewResultItem {
  id: string;
  title: string;
  detail: string;
  kind: string;
}

export interface OverviewSourceItem {
  id: string;
  title: string;
  kind: "browser" | "computer" | "search" | "skill" | "tool" | "kernel";
  detail?: string;
}

export interface OverviewMetaItem {
  id: string;
  label: string;
  value: string;
  detail?: string;
  status?: OverviewStatus;
}

export function OverviewMetaRow(props: { item: OverviewMetaItem; onOpen?(): void }) {
  const copy = (
    <>
      <span className="overview-meta-label">{props.item.label}</span>
      <span className="overview-meta-copy">
        <span className="overview-meta-value">{props.item.value}</span>
        {props.item.detail ? <span className="overview-meta-detail">{props.item.detail}</span> : null}
      </span>
    </>
  );
  if (props.onOpen) {
    return (
      <button
        className="overview-meta-row overview-meta-row-button"
        data-status={props.item.status || "pending"}
        type="button"
        onClick={props.onOpen}
      >
        {copy}
      </button>
    );
  }
  return (
    <div className="overview-meta-row" data-status={props.item.status || "pending"}>
      {copy}
    </div>
  );
}

export function OverviewProgressRow(props: { item: OverviewProgressItem }) {
  return (
    <div className="overview-progress-row" data-status={props.item.status}>
      <span className="overview-progress-icon" aria-hidden="true">
        {overviewStatusIcon(props.item.status)}
      </span>
      <span className="overview-progress-copy">
        <span className="overview-progress-title">{props.item.title}</span>
        {props.item.detail ? <span className="overview-progress-detail">{props.item.detail}</span> : null}
      </span>
    </div>
  );
}

export function OverviewResultRow(props: { item: OverviewResultItem }) {
  return (
    <div className="overview-result-row">
      <span className="overview-result-icon" data-kind={props.item.kind} aria-hidden="true">
        {overviewResultIcon(props.item)}
      </span>
      <span className="overview-result-copy">
        <span className="overview-result-title">{props.item.title}</span>
        {props.item.detail ? <span className="overview-result-detail">{props.item.detail}</span> : null}
      </span>
    </div>
  );
}

export function OverviewSourceRow(props: { item: OverviewSourceItem }) {
  return (
    <div className="overview-source-row">
      <span className="overview-source-icon" data-kind={props.item.kind} aria-hidden="true">
        {overviewSourceIcon(props.item.kind)}
      </span>
      <span className="overview-source-copy">
        <span className="overview-source-title">{props.item.title}</span>
        {props.item.detail ? <span className="overview-source-detail">{props.item.detail}</span> : null}
      </span>
    </div>
  );
}

export function buildOverviewRuntimeItems(input: {
  currentSession: any;
  latestRun: RunRecord | null | undefined;
  runtimeBlocker: any;
  kernelLabel?: string;
  pendingApprovals: any[];
  messageCount: number;
  sending: boolean;
}): OverviewMetaItem[] {
  const items: OverviewMetaItem[] = [];

  if (input.kernelLabel) {
    items.push({
      id: "kernel",
      label: translate("workspace.kernel"),
      value: input.kernelLabel,
      detail: translate("workspace.kernelConnected"),
      status: input.runtimeBlocker ? "blocked" : "running",
    });
  }

  items.push({
    id: "thread",
    label: translate("workspace.thread"),
    value: input.messageCount
      ? translate("workspace.messageCount", { count: input.messageCount })
      : translate("conversation.newThreadFallback"),
    detail: input.sending
      ? translate("settings.running")
      : input.messageCount
        ? translate("workspace.currentConversation")
        : translate("workspace.notStarted"),
    status: input.sending ? "running" : input.messageCount ? "done" : "pending",
  });

  if (input.latestRun) {
    const runTitle = summarize(
      input.latestRun.summary || input.latestRun.input || input.latestRun.id || translate("workspace.currentRun"),
      46,
    );
    items.push({
      id: "run",
      label: translate("workspace.run"),
      value: runTitle,
      detail: [
        input.latestRun.lifecycle?.taskState,
        input.latestRun.modelId,
        formatDate(input.latestRun.updatedAt || input.latestRun.startedAt || input.latestRun.createdAt || ""),
      ]
        .filter(Boolean)
        .join(" · "),
      status: overviewStatusFromRun(input.latestRun, input.runtimeBlocker),
    });
  } else {
    items.push({
      id: "run",
      label: translate("workspace.run"),
      value: input.sending ? translate("workspace.runStarting") : translate("workspace.noRun"),
      detail: input.sending ? translate("workspace.waitingStream") : translate("workspace.runRecordHint"),
      status: input.sending ? "running" : "pending",
    });
  }

  if (input.currentSession) {
    items.push({
      id: "session",
      label: translate("workspace.session"),
      value: summarize(
        input.currentSession.title || input.currentSession.id || translate("workspace.currentSession"),
        46,
      ),
      detail: [input.currentSession.status, input.currentSession.activity, formatDate(input.currentSession.updatedAt)]
        .filter(Boolean)
        .join(" · "),
      status: input.currentSession.status === "running" ? "running" : "pending",
    });
  }

  if (input.pendingApprovals.length) {
    items.push({
      id: "approval",
      label: translate("workspace.approval"),
      value: translate("workspace.pendingApprovalCount", { count: input.pendingApprovals.length }),
      detail: summarize(input.pendingApprovals[0]?.title || input.pendingApprovals[0]?.toolId || "", 52),
      status: "pending",
    });
  }

  return items.slice(0, 4);
}

export function buildOverviewProgressItems(input: {
  messages: StoredMessage[];
  workingState: any;
  latestRun: RunRecord | null | undefined;
  pendingApprovals: any[];
  events: any[];
  runtimeBlocker: any;
  hasThreadActivity: boolean;
  sending: boolean;
}): OverviewProgressItem[] {
  const checklistItems = extractChecklistProgressItems(input.messages);
  if (checklistItems.length) {
    return limitOverviewItems([
      ...checklistItems,
      ...buildRuntimeProgressItems(input).filter((item) => item.status === "running" || item.status === "blocked"),
    ]);
  }
  return limitOverviewItems(buildRuntimeProgressItems(input));
}

export function buildRuntimeProgressItems(input: {
  messages: StoredMessage[];
  workingState: any;
  latestRun: RunRecord | null | undefined;
  pendingApprovals: any[];
  events: any[];
  runtimeBlocker: any;
  hasThreadActivity: boolean;
  sending: boolean;
}): OverviewProgressItem[] {
  const items: OverviewProgressItem[] = [];
  if (!input.hasThreadActivity) {
    return [
      {
        id: "empty-thread",
        title: translate("workspace.waitingFirstTask"),
        status: "pending",
        detail: "",
      },
    ];
  }
  if (input.sending && !input.latestRun) {
    items.push({
      id: "starting",
      title: translate("workspace.startingTask"),
      status: "running",
      detail: "",
    });
  }
  const focusTitle = summarize(
    input.workingState.activeGoal ||
      input.workingState.taskSummary ||
      input.latestRun?.summary ||
      input.latestRun?.input ||
      "",
    72,
  );

  if (focusTitle) {
    items.push({
      id: "focus",
      title: focusTitle,
      status: overviewStatusFromRun(input.latestRun, input.runtimeBlocker),
      detail: input.latestRun?.modelId || input.workingState.selectedModel || "",
    });
  }

  if (input.pendingApprovals.length) {
    items.push({
      id: "approvals",
      title: translate("workspace.pendingActionCount", { count: input.pendingApprovals.length }),
      status: "pending",
      detail: summarize(input.pendingApprovals[0]?.title || input.pendingApprovals[0]?.toolId || "", 58),
    });
  }

  const activityItems = buildOverviewActivityItems(input.messages, input.events, input.latestRun?.id);
  items.push(...activityItems);

  if (input.runtimeBlocker) {
    items.push({
      id: "runtime-blocker",
      title: translate("workspace.runPaused"),
      status: "blocked",
      detail: summarize(formatRuntimeBlockerSummary(input.runtimeBlocker), 72),
    });
  }

  return items.length
    ? dedupeOverviewProgress(items)
    : [
        {
          id: "idle",
          title: translate("workspace.waitingNextTask"),
          status: "pending",
          detail: "",
        },
      ];
}

export function extractChecklistProgressItems(messages: StoredMessage[]): OverviewProgressItem[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const text = messageText(message);
    const items = text
      .split(/\r?\n/)
      .map((line, lineIndex) => checklistItemFromLine(line, lineIndex))
      .filter((item): item is OverviewProgressItem => Boolean(item));
    if (items.length >= 2) {
      return items;
    }
  }
  return [];
}

export function checklistItemFromLine(line: string, lineIndex: number): OverviewProgressItem | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(?:[-*]\s*)?(?:\[(x|X| |-|~)\]|(✅|☑|✓|✔|☐|○|◯|●|◉))\s*(?:\d+[.)]\s*)?(.+)$/);
  if (!match) {
    return null;
  }
  const marker = match[1] || match[2] || "";
  const title = cleanOverviewTitle(match[3] ?? "");
  if (!title) {
    return null;
  }
  return {
    id: `checklist-${lineIndex}-${title}`,
    title: summarize(title, 72),
    status: overviewStatusFromChecklistMarker(marker),
  };
}

export function buildOverviewActivityItems(
  messages: StoredMessage[],
  events: any[],
  latestRunId: string | undefined,
): OverviewProgressItem[] {
  const items = new Map<string, OverviewProgressItem>();
  const latestMessages = messages.filter((message) => message.role === "assistant").slice(-3);
  for (const message of latestMessages) {
    for (const part of message.parts || []) {
      if (part.type === "skill") {
        const title = cleanOverviewTitle(part.title || part.skillName || part.skillId || "Skill");
        items.set(`skill:${part.skillId || title}`, {
          id: `skill:${part.skillId || title}`,
          title: title.startsWith("/") ? title : translate("workspace.usingSkill", { title }),
          status: overviewStatusFromPartStatus(part.status),
          detail: part.model || part.context || "",
        });
      }
      if (part.type === "tool") {
        const toolId = part.toolId || "tool";
        items.set(`tool:${toolId}`, {
          id: `tool:${toolId}`,
          title: formatToolIdLabel(toolId),
          status: overviewStatusFromPartStatus(part.status || (part.phase === "call" ? "running" : "")),
          detail: part.error ? summarize(part.error, 64) : "",
        });
      }
    }
  }

  const runEvents = Array.isArray(events)
    ? events.filter((event) => (latestRunId ? event?.runId === latestRunId : true)).slice(-30)
    : [];
  for (const event of runEvents) {
    if (event?.type !== "tool.started" && event?.type !== "tool.finished") {
      continue;
    }
    const toolId = event.toolId || "tool";
    items.set(`tool:${toolId}`, {
      id: `tool:${toolId}`,
      title: formatToolIdLabel(toolId),
      status: event.type === "tool.started" ? "running" : event.result?.ok ? "done" : "blocked",
      detail: event.result?.error ? summarize(event.result.error, 64) : "",
    });
  }

  return Array.from(items.values());
}

export function buildOverviewResultItems(artifacts: any[]): { visible: OverviewResultItem[]; hiddenCount: number } {
  const items = sortedArtifacts(artifacts).map((artifact) => {
    const title = artifactTitle(artifact);
    return {
      id: artifact.id || title,
      title,
      detail: [artifact.type, formatDate(artifact.updatedAt || artifact.createdAt)].filter(Boolean).join(" · "),
      kind: artifactKind(artifact),
    };
  });
  return {
    visible: items.slice(0, 6),
    hiddenCount: Math.max(0, items.length - 6),
  };
}

type OverviewArtifactInfo = {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  type?: unknown;
  preview?: { title?: unknown; mimeType?: unknown } | null;
  data?: {
    fileName?: unknown;
    name?: unknown;
    imageUri?: unknown;
    filePath?: unknown;
    mimeType?: unknown;
  } | null;
  assets?: Array<{ title?: unknown; uri?: unknown; mimeType?: unknown }>;
};

function artifactTitle(artifact: OverviewArtifactInfo): string {
  const asset = Array.isArray(artifact?.assets)
    ? artifact.assets.find((item) => typeof item?.title === "string" || typeof item?.uri === "string")
    : undefined;
  const uriTitle = fileNameFromAssetUri(asset?.uri || artifact?.data?.imageUri || artifact?.data?.filePath || "");
  return (
    firstPresentString([
      artifact?.preview?.title,
      artifact?.title,
      artifact?.data?.fileName,
      artifact?.data?.name,
      asset?.title,
    ]) ||
    uriTitle ||
    firstPresentString([artifact?.slug, artifact?.id]) ||
    translate("workspace.generatedResult")
  );
}

function artifactKind(artifact: OverviewArtifactInfo): string {
  const mimeType = firstPresentString([
    artifact?.preview?.mimeType,
    artifact?.data?.mimeType,
    artifact?.assets?.[0]?.mimeType,
  ]).toLowerCase();
  const type = String(artifact?.type || "").toLowerCase();
  const title = artifactTitle(artifact).toLowerCase();
  if (type.includes("image") || mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/.test(title))
    return "image";
  if (type.includes("audio") || mimeType.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(title))
    return "audio";
  if (type.includes("video") || mimeType.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/.test(title))
    return "video";
  if (type.includes("markdown") || mimeType.includes("markdown") || /\.md$/.test(title)) return "markdown";
  if (type.includes("text") || mimeType.startsWith("text/") || /\.(txt|json|csv|tsv|yaml|yml)$/.test(title))
    return "text";
  return "file";
}

// 取首个真值并转成字符串；artifact 字段来自服务端 payload，类型不受控。
function firstPresentString(values: unknown[]): string {
  for (const value of values) {
    if (value) {
      return String(value);
    }
  }
  return "";
}

function fileNameFromAssetUri(uri: unknown): string {
  const text = String(uri || "");
  if (!text) return "";
  try {
    const url = new URL(text, globalThis.location?.origin || "http://localhost");
    const part = url.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(part);
  } catch {
    return text.split("/").filter(Boolean).pop() || "";
  }
}

export function filterOverviewArtifacts(
  artifacts: any[],
  messages: StoredMessage[],
  threadId: string,
  runId: string,
): any[] {
  const contextArtifactIds = new Set<string>();
  for (const message of messages) {
    for (const artifact of message.context?.artifacts || []) {
      if (artifact?.id) {
        contextArtifactIds.add(artifact.id);
      }
    }
  }
  return artifacts.filter((artifact) => {
    if (!artifact) {
      return false;
    }
    if (contextArtifactIds.has(artifact.id)) {
      return true;
    }
    if (threadId && (artifact.threadId === threadId || artifact.provenance?.threadId === threadId)) {
      return true;
    }
    if (runId && (artifact.runId === runId || artifact.provenance?.runId === runId)) {
      return true;
    }
    return false;
  });
}

export function buildOverviewSourceItems(input: {
  messages: StoredMessage[];
  workingState: any;
  latestRun: RunRecord | null | undefined;
  skills: any[];
  tools: any[];
  events: any[];
  kernelLabel?: string;
  hasThreadActivity: boolean;
}): OverviewSourceItem[] {
  const sources = new Map<string, OverviewSourceItem>();
  const addSource = (item: OverviewSourceItem) => {
    if (!sources.has(item.id)) {
      sources.set(item.id, item);
    }
  };

  if (!input.hasThreadActivity) {
    return [];
  }

  if (input.workingState.activeSkillId || input.workingState.activePackId) {
    const skillId = input.workingState.activeSkillId || input.workingState.activePackId;
    addSource({
      id: `skill:${skillId}`,
      title: skillTitle(skillId, input.skills),
      kind: "skill",
      detail: input.workingState.activePackId ? "pack" : "skill",
    });
  }

  for (const message of input.messages.filter((message) => message.role === "assistant").slice(-4)) {
    for (const part of message.parts || []) {
      if (part.type === "skill") {
        addSource({
          id: `skill:${part.skillId || part.skillName || part.title}`,
          title: part.title || part.skillName || part.skillId || "Skill",
          kind: "skill",
          detail: part.source || part.context || "",
        });
      }
      if (part.type === "tool") {
        addSource(toolSourceItem(part.toolId, input.tools));
      }
    }
  }

  const runToolIds = Array.isArray(input.latestRun?.toolIds) ? input.latestRun.toolIds : [];
  for (const toolId of runToolIds) {
    addSource(toolSourceItem(toolId, input.tools));
  }

  const recentToolIds = uniqueIds(
    (Array.isArray(input.events) ? input.events : [])
      .slice(-40)
      .map((event) => (event?.type === "tool.started" || event?.type === "tool.finished" ? event.toolId : ""))
      .filter(Boolean),
  );
  for (const toolId of recentToolIds) {
    addSource(toolSourceItem(toolId, input.tools));
  }

  if (!sources.size && input.kernelLabel) {
    addSource({
      id: "kernel",
      title: input.kernelLabel,
      kind: "kernel",
      detail: "",
    });
  }

  return Array.from(sources.values()).slice(0, 6);
}

export function overviewStatusIcon(status: OverviewStatus) {
  if (status === "done") {
    return <CheckCircle2 size={16} />;
  }
  if (status === "running") {
    return <LoaderCircle size={16} className="spin" />;
  }
  if (status === "blocked") {
    return <AlertCircle size={16} />;
  }
  return <Circle size={16} />;
}

export function overviewResultIcon(item: OverviewResultItem) {
  if (item.kind === "image") {
    return <ImageIcon size={16} />;
  }
  if (item.kind === "text" || item.kind === "markdown") {
    return <FileText size={16} />;
  }
  return <FileIcon size={16} />;
}

export function overviewSourceIcon(kind: OverviewSourceItem["kind"]) {
  if (kind === "browser") {
    return <Globe2 size={16} />;
  }
  if (kind === "search") {
    return <Search size={16} />;
  }
  if (kind === "computer") {
    return <Monitor size={16} />;
  }
  if (kind === "skill") {
    return <Sparkles size={16} />;
  }
  if (kind === "tool") {
    return <Wrench size={16} />;
  }
  return <Package size={16} />;
}

export function overviewStatusFromRun(run: RunRecord | null | undefined, runtimeBlocker: unknown): OverviewStatus {
  return runOverviewStatus(run?.lifecycle, Boolean(runtimeBlocker));
}

export function overviewStatusFromPartStatus(status: string): OverviewStatus {
  if (["complete", "finished", "loaded", "staged", "approved", "succeeded", "success"].includes(status)) {
    return "done";
  }
  if (["running", "started", "invoked"].includes(status)) {
    return "running";
  }
  if (["blocked", "incomplete", "rejected", "failed", "error"].includes(status)) {
    return "blocked";
  }
  return "pending";
}

export function overviewStatusFromChecklistMarker(marker: string): OverviewStatus {
  if (/x/i.test(marker) || ["✅", "☑", "✓", "✔", "●", "◉"].includes(marker)) {
    return "done";
  }
  if (marker === "-" || marker === "~") {
    return "running";
  }
  return "pending";
}

export function toolSourceItem(toolId: string, tools: any[]): OverviewSourceItem {
  const id = toolId || "tool";
  const spec = tools.find((tool) => tool?.id === id);
  const kind = classifyToolKind(id);
  return {
    id: `tool:${id}`,
    title: toolSourceTitle(id, spec, kind),
    kind,
    detail: spec?.activity || spec?.risk || "",
  };
}

export function classifyToolKind(toolId: string): OverviewSourceItem["kind"] {
  const normalized = String(toolId || "").toLowerCase();
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("computer")) return "computer";
  if (normalized.includes("search") || normalized.includes("web")) return "search";
  if (normalized.includes("skill")) return "skill";
  return "tool";
}

export function toolSourceTitle(toolId: string, spec: any, kind: OverviewSourceItem["kind"]): string {
  if (kind === "browser") return spec?.title || translate("workspace.toolBrowserSkill");
  if (kind === "computer") return spec?.title || "Computer Use";
  if (kind === "search") return spec?.title || translate("workspace.toolWebSearch");
  return spec?.title || formatToolIdLabel(toolId);
}

export function formatToolIdLabel(toolId: string): string {
  const normalized = String(toolId || "tool");
  const known: Record<string, TranslationKey> = {
    "browser.open": "workspace.toolBrowserOpen",
    "browser.act": "workspace.toolBrowserAct",
    "computer.observe": "workspace.toolComputerObserve",
    "computer.act": "workspace.toolComputerAct",
    "memory.write": "workspace.toolMemoryWrite",
    "artifact.annotation": "workspace.toolArtifactAnnotation",
    "host_ui.request_user_input": "workspace.toolRequestUserInput",
  };
  const key = known[normalized];
  return key ? translate(key) : normalized.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function skillTitle(skillId: string, skills: any[]): string {
  const skill = skills.find((item) => item?.id === skillId || item?.name === skillId);
  return skill?.title || skill?.name || skillId;
}

export function messageText(message: StoredMessage): string {
  const textParts = (message.parts || [])
    .filter((part) => part?.type === "text")
    .map((part: any) => part.text || "")
    .join("");
  return textParts || message.text || "";
}

export function cleanOverviewTitle(value: string): string {
  return String(value || "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function limitOverviewItems(items: OverviewProgressItem[]): OverviewProgressItem[] {
  return dedupeOverviewProgress(items).slice(0, 5);
}

export function dedupeOverviewProgress(items: OverviewProgressItem[]): OverviewProgressItem[] {
  const seen = new Set<string>();
  const result: OverviewProgressItem[] = [];
  for (const item of items) {
    const key = cleanOverviewTitle(item.title).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function formatRuntimeBlockerSummary(blocker: any): string {
  if (!blocker) return "";
  if (blocker?.data?.needsReobserve) return translate("workspace.blockerReobserve");
  const message = blocker?.data?.message || blocker?.title || blocker?.status;
  if (!message) return translate("workspace.blockerRuntimeBlocked");
  return translate("workspace.blockerNeedsAttention", {
    message: rawDiagnosticText(String(message)),
  });
}

export function formatRuntimeBlockerMeta(blocker: any): string {
  return blocker?.data?.needsReobserve ? "next: re-observe" : "";
}
