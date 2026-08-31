import { File as FileIcon, FileText, Image as ImageIcon } from "lucide-react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentEventRecord,
  AskFinalPayload,
  AttachmentPayload,
  ExecutionRecord,
  InventoryResponse,
  KernelCapabilityReport,
  RuntimeAccessMode,
  RunRecord,
  SessionRecord,
  SkillRecord,
  StoredMessage,
  WorkingStateRecord,
} from "../bridge";
import { APP_STORAGE_KEYS } from "../identity";
import { compareLocalizedText, sortedExecutions, sortedRuns, uniqueIds } from "../format";
import { translate } from "../i18n";
import type { TranslationFn } from "../i18n";
import { apiUrl } from "../api-base";

export const MIN_COMPOSER_HEIGHT = 56;
export const MAX_COMPOSER_HEIGHT = 88;
// Raw upload ceiling. Large source images (film stills, 4K posters) are
// downscaled client-side to MAX_MODEL_IMAGE_EDGE before encoding, so the raw
// file can be large while the encoded dataUrl that reaches the model stays
// well under provider limits (5MB base64 on Bedrock, 10MB direct).
export const MAX_IMAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const MAX_FILE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 1.5 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_CHARS = 80_000;
export const MAX_COMPOSER_ATTACHMENTS = 8;
// Models downscale any image to at most this long edge (Opus 4.7+ native
// resolution). Sending larger images only wastes bandwidth and risks the
// provider's per-image byte limit — the model never sees the extra pixels.
export const MAX_MODEL_IMAGE_EDGE = 2576;
const MAX_INLINE_DATA_IMAGE_PAYLOAD_CHARS = MAX_IMAGE_ATTACHMENT_BYTES * 4;

export function parseSlashSkillQuery(value: string): { active: boolean; keyword: string } {
  const input = String(value || "").trimStart();
  if (!input.startsWith("/")) {
    return { active: false, keyword: "" };
  }
  const afterSlash = input.slice(1);
  if (!afterSlash) {
    return { active: true, keyword: "" };
  }
  const spaceIndex = afterSlash.search(/\s/);
  if (spaceIndex >= 0) {
    return { active: false, keyword: afterSlash.slice(0, spaceIndex).toLowerCase() };
  }
  return { active: true, keyword: afterSlash.toLowerCase() };
}

export interface KernelSlashCommand {
  id: string;
  name: string;
  title: string;
  description: string;
  source: "kernel-native" | "opengrove";
  kernelId?: string;
}

export interface ComposerSkillInvocation {
  name: string;
  skill: SkillRecord;
  args: string;
}

export function parseComposerSkillInvocation(value: string, skills: SkillRecord[]): ComposerSkillInvocation | null {
  const match = String(value || "").match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  const name = match[1];
  const skill = (Array.isArray(skills) ? skills : []).find((candidate) => {
    const candidateName = skillInvocationName(candidate);
    const candidateId = String(candidate?.id || "").replace(/^skill\./, "");
    return candidateName === name || candidateId === name;
  });
  if (!skill) {
    return null;
  }
  return {
    name: skillInvocationName(skill),
    skill,
    args: match[2] ?? "",
  };
}

export function composeSkillPrompt(name: string, args: string): string {
  return args ? `/${name} ${args}` : `/${name} `;
}

export function skillInvocationName(skill: SkillRecord): string {
  return String(skill?.name || skill?.id || "skill").replace(/^skill\./, "");
}

export function formatComposerSkillTitle(skill: SkillRecord, t: TranslationFn = translate): string {
  const raw = String(skill?.title || skill?.displayName || skill?.name || skill?.id || "Skill").trim();
  if (raw === "bottle-reference-brief") {
    return t("runtime.bottleReferenceBriefTitle");
  }
  return raw
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "api" || lower === "ui" || lower === "vfs" || lower === "pm") {
        return lower.toUpperCase();
      }
      return part.toUpperCase() === part ? part : part.slice(0, 1).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function getMatchingSkills(skills: SkillRecord[], keyword: string): SkillRecord[] {
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill && skill.userInvocable !== false)
    .map((skill) => ({ skill, score: scoreSkillMatch(skill, keyword) }))
    .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return compareLocalizedText(
        String(left.skill.title || left.skill.name || left.skill.id || ""),
        String(right.skill.title || right.skill.name || right.skill.id || ""),
      );
    })
    .map((entry) => entry.skill);
}

export function getKernelSlashCommands(
  kernelId?: string,
  workingState?: WorkingStateRecord,
  capabilityReport?: KernelCapabilityReport,
  t: TranslationFn = translate,
): KernelSlashCommand[] {
  const normalizedKernel = String(kernelId || "").trim() || "kernel";
  const canCompact = capabilityEnabled(capabilityReport, "session.compact");
  const canPlan = capabilityEnabled(capabilityReport, "planning.plan");
  const common = [
    opengroveCommand(normalizedKernel, "tools", t("commands.toolsTitle"), t("commands.toolsDescription")),
    command(normalizedKernel, "help", t("commands.helpTitle"), t("commands.helpDescription")),
    command(normalizedKernel, "status", t("commands.statusTitle"), t("commands.statusDescription")),
  ];

  if (normalizedKernel === "codex") {
    return [
      opengroveCommand(normalizedKernel, "tools", t("commands.toolsTitle"), t("commands.toolsDescription")),
      command(normalizedKernel, "model", t("composer.model"), t("commands.modelDescription")),
      command(normalizedKernel, "branch", t("commands.branchTitle"), t("commands.branchDescription")),
      command(normalizedKernel, "status", t("commands.statusTitle"), t("commands.codexStatusDescription")),
      ...(canPlan ? [command(normalizedKernel, "plan", t("composer.planMode"), t("commands.planDescription"))] : []),
      command(normalizedKernel, "memory", t("source.kind.memory"), t("commands.memoryDescription")),
      ...(canCompact
        ? [command(normalizedKernel, "compact", t("commands.compactTitle"), t("commands.compactDescription"))]
        : []),
      command(normalizedKernel, "help", t("commands.helpTitle"), t("commands.codexHelpDescription")),
    ];
  }

  if (normalizedKernel === "claude-code") {
    const discovered = readClaudeSlashCommands(workingState);
    const fallback = [
      opengroveCommand(normalizedKernel, "tools", t("commands.toolsTitle"), t("commands.toolsDescription")),
      ...(canCompact
        ? [command(normalizedKernel, "compact", t("commands.compactTitle"), t("commands.claudeCompactDescription"))]
        : []),
      command(normalizedKernel, "clear", t("commands.clearTitle"), t("commands.claudeClearDescription")),
      command(normalizedKernel, "context", t("commands.contextTitle"), t("commands.contextDescription")),
      command(normalizedKernel, "cost", t("commands.costTitle"), t("commands.costDescription")),
    ];
    return discovered.length
      ? mergeDiscoveredSlashCommands(normalizedKernel, discovered, fallback, { canCompact }, t)
      : fallback;
  }

  return [
    command(normalizedKernel, "model", t("composer.model"), t("commands.modelDescription")),
    ...common,
    ...(canCompact
      ? [command(normalizedKernel, "compact", t("commands.compactTitle"), t("commands.compactDescription"))]
      : []),
    command(normalizedKernel, "clear", t("commands.clearTitle"), t("commands.clearDescription")),
  ];
}

function readClaudeSlashCommands(workingState?: WorkingStateRecord): string[] {
  const value = workingState?.toolSchemaCache?.["claude.slashCommands"];
  const parsed = typeof value === "string" ? parseJsonArray(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string" && item.trim().startsWith("/"))
    : [];
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeDiscoveredSlashCommands(
  kernelId: string,
  discovered: string[],
  fallback: KernelSlashCommand[],
  options: { canCompact?: boolean } = {},
  t: TranslationFn = translate,
): KernelSlashCommand[] {
  const fallbackByName = new Map(fallback.map((item) => [item.name, item]));
  const seen = new Set<string>();
  const output: KernelSlashCommand[] = [];
  for (const item of fallback.filter((command) => command.source === "opengrove")) {
    seen.add(item.name);
    output.push(item);
  }
  for (const raw of discovered) {
    const name = raw.trim().replace(/^\/+/, "");
    if (!name || seen.has(name)) {
      continue;
    }
    if (name === "compact" && options.canCompact !== true) {
      continue;
    }
    seen.add(name);
    output.push(fallbackByName.get(name) ?? command(kernelId, name, name, t("commands.claudeNativeDescription")));
  }
  return output;
}

function capabilityEnabled(report: KernelCapabilityReport | undefined, capability: string): boolean {
  return (
    report?.capabilities.some((entry) => entry.capability === capability && entry.productBehavior === "enable") === true
  );
}

export function buildConnectedToolsStatus(
  kernelId: string | undefined,
  report?: KernelCapabilityReport,
  t: TranslationFn = translate,
): string {
  const kernel = String(kernelId || report?.kernel || t("toolStatus.currentKernel"));
  const rows = [
    connectedToolStatusRow(t("toolStatus.hostTools"), report, "tools.hostTool", t),
    connectedToolStatusRow(t("toolStatus.nativeTools"), report, "tools.nativeTool", t),
    connectedToolStatusRow(t("toolStatus.mcpServers"), report, "tools.mcpServers", t),
  ];
  return [
    t("toolStatus.heading", { kernel: formatKernelNameForStatus(kernel) }),
    ...rows.map((row) =>
      row.detail
        ? t("toolStatus.rowWithDetail", { label: row.label, status: row.status, detail: row.detail })
        : t("toolStatus.row", { label: row.label, status: row.status }),
    ),
    t("toolStatus.footer"),
  ].join("\n");
}

function connectedToolStatusRow(
  label: string,
  report: KernelCapabilityReport | undefined,
  capability: string,
  t: TranslationFn,
): { label: string; status: string; detail: string } {
  const entry = report?.capabilities.find((item) => item.capability === capability);
  if (!entry) {
    return { label, status: t("common.unknown"), detail: t("toolStatus.notReported") };
  }
  if (entry.productBehavior === "enable") {
    return { label, status: t("common.available"), detail: "" };
  }
  if (entry.productBehavior === "fallback") {
    return { label, status: t("toolStatus.partiallyAvailable"), detail: t("toolStatus.conservativeDisplay") };
  }
  if (entry.exposed === "no") {
    return { label, status: t("toolStatus.notConnected"), detail: "" };
  }
  return { label, status: t("common.unknown"), detail: t("toolStatus.noRuntimeEvidence") };
}

function formatKernelNameForStatus(kernelId: string): string {
  if (kernelId === "claude-code") return "Claude Agent";
  if (kernelId === "opencode") return "OpenCode";
  if (kernelId === "codex") return "Codex";
  return kernelId;
}

export function getMatchingSlashCommands(commands: KernelSlashCommand[], keyword: string): KernelSlashCommand[] {
  return (Array.isArray(commands) ? commands : [])
    .map((item, index) => ({ item, index, score: scoreSlashCommandMatch(item, keyword) }))
    .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

export function pickCodexSkills(skills: SkillRecord[]): SkillRecord[] {
  const allSkills = Array.isArray(skills) ? skills : [];
  const codexSkills = allSkills.filter(isCodexSkill);
  return codexSkills.length ? codexSkills : allSkills;
}

export function isCodexSkill(skill: SkillRecord): boolean {
  const entry = String(skill.entry || skill.skillRoot || "");
  const packId = String(skill.packId || "");
  return /(^|[\\/])\.codex[\\/]/.test(entry) || packId.startsWith("codex.");
}

export function scoreSkillMatch(skill: SkillRecord, keyword: string): number {
  if (!keyword) {
    return 0;
  }
  const name = String(skill.name || skill.id || "").toLowerCase();
  const title = String(skill.title || "").toLowerCase();
  const description = String(skill.description || "").toLowerCase();
  const whenToUse = String(skill.whenToUse || "").toLowerCase();
  if (name === keyword) return 0;
  if (name.startsWith(keyword)) return 1;
  if (title.startsWith(keyword)) return 2;
  if (name.includes(keyword)) return 3;
  if (title.includes(keyword)) return 4;
  if (whenToUse.includes(keyword)) return 5;
  if (description.includes(keyword)) return 6;
  return Number.POSITIVE_INFINITY;
}

function command(kernelId: string, name: string, title: string, description: string): KernelSlashCommand {
  return {
    id: `${kernelId}.${name}`,
    name,
    title,
    description,
    source: "kernel-native",
    kernelId,
  };
}

function opengroveCommand(kernelId: string, name: string, title: string, description: string): KernelSlashCommand {
  return {
    id: `opengrove.${kernelId}.${name}`,
    name,
    title,
    description,
    source: "opengrove",
    kernelId,
  };
}

function scoreSlashCommandMatch(command: KernelSlashCommand, keyword: string): number {
  if (!keyword) {
    return 0;
  }
  const name = command.name.toLowerCase();
  const title = command.title.toLowerCase();
  const description = command.description.toLowerCase();
  if (name === keyword) return 0;
  if (name.startsWith(keyword)) return 1;
  if (title.startsWith(keyword)) return 2;
  if (name.includes(keyword)) return 3;
  if (title.includes(keyword)) return 4;
  if (description.includes(keyword)) return 5;
  return Number.POSITIVE_INFINITY;
}

export function cloneMessage(message: StoredMessage): StoredMessage {
  return {
    ...message,
    context: message.context ? { ...message.context } : null,
    parts: [...message.parts],
  };
}

export function mergeFinalDataIntoCache(queryClient: QueryClient, finalData: AskFinalPayload): void {
  queryClient.setQueryData(["inventory"], (previous: InventoryResponse | undefined) =>
    previous
      ? {
          ...previous,
          artifacts: finalData.artifacts ?? previous.artifacts,
          workingState: finalData.workingState ?? previous.workingState,
          sessions: finalData.sessions ?? previous.sessions,
          runs: finalData.runs ?? previous.runs,
          executions: finalData.executions ?? previous.executions,
        }
      : previous,
  );
  if (finalData.approvals) {
    queryClient.setQueryData(["approvals"], { ok: true, approvals: finalData.approvals });
  }
  if (finalData.questions) {
    queryClient.setQueryData(["questions"], { ok: true, questions: finalData.questions });
  }
}

// 注意：多处以 .map(readComposerAttachment) 直接作回调，不能追加可选参数（index 会串位），
// 因此在函数体内调用 translate（调用时求值，语言切换后依然生效）。
export async function readComposerAttachment(file: File): Promise<AttachmentPayload> {
  const t: TranslationFn = translate;
  const base = {
    id: createAttachmentId(),
    name: file.name || "untitled",
    mimeType: file.type || guessMimeType(file.name),
    size: file.size,
  };

  if (base.mimeType.startsWith("image/")) {
    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      return {
        ...base,
        kind: "file",
        error: t("runtime.imageTooLarge", { limit: formatBytes(MAX_IMAGE_ATTACHMENT_BYTES) }),
      };
    }
    let dataUrl = "";
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      return {
        ...base,
        kind: "file",
        error: t("runtime.imageReadFailed"),
      };
    }
    const downscaled = (await downscaleImageDataUrl(dataUrl, MAX_MODEL_IMAGE_EDGE)) ?? dataUrl;
    return {
      ...base,
      kind: "image",
      mimeType: dataUrlMimeType(downscaled) ?? base.mimeType,
      dataUrl: downscaled,
      thumbnailUrl: await createImageThumbnail(downscaled),
    };
  }

  if (isTextLikeFile(file)) {
    if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
      return {
        ...base,
        kind: "file",
        error: t("runtime.textTooLarge", { limit: formatBytes(MAX_TEXT_ATTACHMENT_BYTES) }),
      };
    }
    let text = "";
    try {
      text = await readFileAsText(file);
    } catch {
      return {
        ...base,
        kind: "file",
        error: t("runtime.textReadFailed"),
      };
    }
    return {
      ...base,
      kind: "text",
      text: text.slice(0, MAX_TEXT_ATTACHMENT_CHARS),
    };
  }

  let dataUrl: string | undefined;
  if (file.size <= MAX_FILE_ATTACHMENT_BYTES) {
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      return {
        ...base,
        kind: "file",
        error: t("runtime.fileReadFailed"),
      };
    }
  }
  return {
    ...base,
    kind: "file",
    dataUrl,
    error:
      file.size > MAX_FILE_ATTACHMENT_BYTES
        ? t("runtime.fileTooLarge", { limit: formatBytes(MAX_FILE_ATTACHMENT_BYTES) })
        : dataUrl
          ? undefined
          : t("runtime.fileReadFailed"),
  };
}

export function composerFilesFromClipboardData(clipboardData: DataTransfer): File[] {
  const filesFromItems = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .filter(isReadableComposerFile);
  const filesFromClipboard = Array.from(clipboardData.files ?? []).filter(isReadableComposerFile);
  const nativeFiles = dedupeClipboardFiles([...filesFromItems, ...filesFromClipboard]);
  if (nativeFiles.length) {
    return nativeFiles;
  }
  return dedupeClipboardFiles(inlineImageFilesFromClipboardData(clipboardData));
}

export function composerImageFilesFromClipboardData(clipboardData: DataTransfer): File[] {
  return composerFilesFromClipboardData(clipboardData).filter(isComposerImageFile);
}

export function mergeComposerAttachments(
  current: AttachmentPayload[],
  next: AttachmentPayload[],
  limit = MAX_COMPOSER_ATTACHMENTS,
): AttachmentPayload[] {
  const merged: AttachmentPayload[] = [];
  const seen = new Set<string>();
  for (const attachment of [...current, ...next]) {
    const key = composerAttachmentContentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(attachment);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function isComposerImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(file.name);
}

export function attachmentImagePreviewUrl(attachment: AttachmentPayload): string | undefined {
  if (attachment.kind !== "image") return undefined;
  if (attachment.thumbnailUrl) return apiUrl(attachment.thumbnailUrl);
  const mimeType = attachment.mimeType.toLowerCase();
  if (!attachment.dataUrl || !isBrowserRenderableImageMimeType(mimeType)) return undefined;
  return attachment.dataUrl;
}

export function isReadableComposerFile(file: File): boolean {
  return file.size > 0 || isComposerImageFile(file) || Boolean(file.name);
}

function isBrowserRenderableImageMimeType(mimeType: string): boolean {
  return (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/jpg" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp" ||
    mimeType === "image/svg+xml" ||
    mimeType === "image/avif"
  );
}

function dedupeClipboardFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const deduped: File[] = [];
  for (const file of files) {
    const key = `${file.name}:${file.type}:${file.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(file);
  }
  return deduped;
}

function composerAttachmentContentKey(attachment: AttachmentPayload): string {
  const content = attachment.dataUrl ?? attachment.text ?? attachment.error ?? "";
  return [
    attachment.kind,
    attachment.name,
    attachment.mimeType,
    attachment.size,
    content.length,
    hashComposerAttachmentContent(content),
  ].join("\0");
}

function hashComposerAttachmentContent(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function inlineImageFilesFromClipboardData(clipboardData: DataTransfer): File[] {
  const files: File[] = [];
  const plainText = clipboardData.getData("text/plain").trim();
  const plainFile = dataImageUrlToFile(plainText, "pasted-image.png");
  if (plainFile) files.push(plainFile);

  const html = clipboardData.getData("text/html");
  const imageSourcePattern = /<img\b[^>]*\bsrc=(["'])(data:image\/[^"']+)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = imageSourcePattern.exec(html)) && files.length < MAX_COMPOSER_ATTACHMENTS) {
    const file = dataImageUrlToFile(match[2] ?? "", `pasted-image-${files.length + 1}.png`);
    if (file) files.push(file);
  }
  return files;
}

function dataImageUrlToFile(dataUrl: string, name: string): File | undefined {
  if (!dataUrl.startsWith("data:image/")) return undefined;
  const match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) return undefined;
  const mimeType = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  if (!payload || payload.length > MAX_INLINE_DATA_IMAGE_PAYLOAD_CHARS) return undefined;
  const normalizedPayload = isBase64 ? payload.replace(/\s/g, "") : payload;
  const estimatedBytes = isBase64 ? Math.ceil((normalizedPayload.length * 3) / 4) : normalizedPayload.length;
  if (estimatedBytes > MAX_IMAGE_ATTACHMENT_BYTES) return undefined;
  try {
    const binary = isBase64 ? atob(normalizedPayload) : decodeURIComponent(normalizedPayload);
    if (binary.length > MAX_IMAGE_ATTACHMENT_BYTES) return undefined;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], name, { type: mimeType });
  } catch {
    return undefined;
  }
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("file_read_failed"));
    reader.readAsText(file);
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

export function createImageThumbnail(dataUrl: string, maxEdge = 180): Promise<string | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      if (!sourceWidth || !sourceHeight) {
        resolve(dataUrl);
        return;
      }
      const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(dataUrl);
        return;
      }
      try {
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/webp", 0.78));
      } catch {
        resolve(dataUrl);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = dataUrl;
  });
}

// Returns the media type encoded in a data URL (e.g. "image/png"), or undefined.
export function dataUrlMimeType(dataUrl: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1]?.toLowerCase();
}

// Downscale an image data URL so its long edge is at most maxEdge, preserving
// aspect ratio. Images already within the limit are returned unchanged. PNG and
// WebP keep their format (lossless text/screenshots); everything else re-encodes
// as high-quality JPEG. Returns undefined on decode/encode failure so callers can
// fall back to the original data URL.
export function downscaleImageDataUrl(dataUrl: string, maxEdge: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      if (!sourceWidth || !sourceHeight) {
        resolve(dataUrl);
        return;
      }
      if (Math.max(sourceWidth, sourceHeight) <= maxEdge) {
        resolve(dataUrl);
        return;
      }
      const scale = maxEdge / Math.max(sourceWidth, sourceHeight);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(undefined);
        return;
      }
      try {
        context.drawImage(image, 0, 0, width, height);
        const sourceType = dataUrlMimeType(dataUrl);
        const outputType = sourceType === "image/png" || sourceType === "image/webp" ? sourceType : "image/jpeg";
        resolve(canvas.toDataURL(outputType, 0.92));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = dataUrl;
  });
}

export function isTextLikeFile(file: File): boolean {
  const mimeType = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/x-yaml",
      "application/toml",
      "image/svg+xml",
    ].includes(mimeType) ||
    /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|cc|cpp|h|hpp|swift|kt|sh|zsh|bash|yaml|yml|toml|ini|sql|log)$/i.test(
      name,
    )
  );
}

export function guessMimeType(fileName: string): string {
  if (/\.svg$/i.test(fileName)) return "image/svg+xml";
  if (/\.png$/i.test(fileName)) return "image/png";
  if (/\.jpe?g$/i.test(fileName)) return "image/jpeg";
  if (/\.webp$/i.test(fileName)) return "image/webp";
  if (/\.jsonl?$/i.test(fileName)) return "application/json";
  if (/\.ya?ml$/i.test(fileName)) return "application/x-yaml";
  if (/\.toml$/i.test(fileName)) return "application/toml";
  if (/\.csv$/i.test(fileName)) return "text/csv";
  if (/\.tsx?$/i.test(fileName)) return "text/typescript";
  if (/\.jsx?$/i.test(fileName)) return "text/javascript";
  if (/\.(md|markdown)$/i.test(fileName)) return "text/markdown";
  return "application/octet-stream";
}

export function fileNameFromAssetUri(uri: string): string {
  try {
    const url = new URL(uri, window.location.origin);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "");
  } catch {
    return "";
  }
}

export function mimeTypeFromAssetUri(uri: string): string {
  const value = String(uri || "");
  if (value.startsWith("data:image/")) {
    const mimeType = value.slice(5, value.indexOf(";") > 0 ? value.indexOf(";") : undefined);
    return mimeType || "image/*";
  }
  return guessMimeType(fileNameFromAssetUri(value));
}

export function createAttachmentId(): string {
  return `attachment_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

export function attachmentIcon(attachment: AttachmentPayload) {
  if (attachment.kind === "image") return ImageIcon;
  if (attachment.kind === "text") return FileText;
  return FileIcon;
}

export function formatAttachmentMeta(attachment: AttachmentPayload, t: TranslationFn = translate): string {
  if (attachment.error) {
    return ` · ${attachment.error}`;
  }
  if (attachment.kind === "image") {
    return ` · ${t("runtime.attachmentImage")} · ${formatBytes(attachment.size)}`;
  }
  if (attachment.kind === "text") {
    return ` · ${t("runtime.attachmentText")} · ${formatBytes(attachment.size)}`;
  }
  return ` · ${t("runtime.attachmentFile")} · ${formatBytes(attachment.size)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function collectMessageRunIds(messages: StoredMessage[]): string[] {
  return uniqueIds(
    messages
      .map((message) => message.runId)
      .filter((runId): runId is string => typeof runId === "string" && runId.length > 0),
  );
}

export function resolveCurrentSession(
  sessions: SessionRecord[],
  workingState: WorkingStateRecord,
  threadId: string,
  latestRun: RunRecord | undefined,
  hasThreadActivity: boolean,
): SessionRecord | undefined {
  if (!hasThreadActivity) {
    return undefined;
  }
  if (latestRun?.sessionId) {
    return sessions.find((item) => item?.id === latestRun.sessionId);
  }
  if (workingState.sessionId && workingState.sessionId === threadId) {
    return sessions.find((item) => item?.id === workingState.sessionId);
  }
  return undefined;
}

export function resolveLatestRun(
  runs: RunRecord[],
  sessionId: string,
  runIds: string[],
  hasThreadActivity: boolean,
): RunRecord | undefined {
  if (!hasThreadActivity) {
    return undefined;
  }
  if (runIds.length) {
    const runIdSet = new Set(runIds);
    return sortedRuns(runs).find((item) => runIdSet.has(item?.id) || runIdSet.has(item?.runId));
  }
  return sortedRuns(runs).find((item) => sessionId && item?.sessionId === sessionId);
}

export function resolveLatestRuntimeBlocker(
  executions: ExecutionRecord[],
  sessionId: string,
): ExecutionRecord | undefined {
  return sortedExecutions(executions).find((item) => {
    if (sessionId && item?.sessionId !== sessionId) {
      return false;
    }
    return Boolean(item?.data?.needsReobserve || item?.status === "environment_blocked" || item?.eventType === "error");
  });
}

export function buildApprovalResolutionMessage(
  result: Record<string, unknown>,
  action: string,
  t: TranslationFn = translate,
): string {
  if (action !== "approve") {
    return t("runtime.actionDenied");
  }
  if (result?.alreadyResolved) {
    return t("runtime.actionAlreadyResolved");
  }
  const toolResult =
    result.toolResult && typeof result.toolResult === "object" ? (result.toolResult as Record<string, unknown>) : {};
  const toolValue =
    toolResult.value && typeof toolResult.value === "object" ? (toolResult.value as Record<string, unknown>) : {};
  if (toolValue?.needsReobserve) {
    return t("runtime.actionNeedsReobserve");
  }
  if (toolValue?.status === "staged") {
    return t("runtime.actionStaged");
  }
  return t("runtime.actionApproved");
}

export function formatKernelLabel(value: string | undefined, t: TranslationFn = translate): string {
  const productName = {
    codex: "Codex",
    "claude-code": "Claude Agent",
    hermes: "Hermes",
    pi: "Pi",
    openclaw: "OpenClaw",
    opencode: "OpenCode",
    kimi: "Kimi Code",
  }[value || ""];
  return productName ? t("workspace.namedKernel", { name: productName }) : "";
}

export function readStoredAccessMode(): RuntimeAccessMode {
  const value = typeof window === "undefined" ? "" : window.localStorage.getItem(APP_STORAGE_KEYS.accessMode);
  return value === "default" || value === "auto-review" || value === "full-access" ? value : "default";
}

export interface ContextUsage {
  used: number;
  total: number;
  breakdown?: Array<{ category: string; tokens: number }>;
}

// Derive the context-window usage (for the composer ring) from the most recent
// model.response event that carries a context-window denominator. Returns undefined when
// no kernel reported a window — the ring then stays hidden rather than guessing.
export function latestContextUsage(
  events: AgentEventRecord[],
  options: { runIds?: string[] } = {},
): ContextUsage | undefined {
  const runIdFilter = options.runIds ? new Set(options.runIds.filter(Boolean)) : undefined;
  if (runIdFilter && !runIdFilter.size) {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (runIdFilter && !runIdFilter.has(String(event?.runId || ""))) {
      continue;
    }
    const usage = readEventUsage(event);
    if (!usage) continue;
    const total = readFiniteNumber(usage.contextWindowSize);
    if (total === undefined || total <= 0) continue;
    const used = readFiniteNumber(usage.contextUsedTokens);
    // A newer response with a known denominator but unavailable native
    // occupancy supersedes older telemetry. Do not show the previous turn's
    // value as though it described the current context.
    if (used === undefined) return undefined;
    const breakdown = Array.isArray(usage.contextBreakdown)
      ? usage.contextBreakdown
          .map((entry) => {
            const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
            const category = typeof record.category === "string" ? record.category : "";
            const tokens = readFiniteNumber(record.tokens) ?? 0;
            return category ? { category, tokens } : undefined;
          })
          .filter((entry): entry is { category: string; tokens: number } => Boolean(entry))
      : undefined;
    return { used: Math.max(0, Math.min(used, total)), total, ...(breakdown?.length ? { breakdown } : {}) };
  }
  return undefined;
}

function readEventUsage(event: AgentEventRecord | undefined): Record<string, unknown> | undefined {
  const usage =
    event?.response && typeof event.response === "object"
      ? (event.response as Record<string, unknown>).usage
      : undefined;
  return usage && typeof usage === "object" && !Array.isArray(usage) ? (usage as Record<string, unknown>) : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
