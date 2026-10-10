import { resolve } from "node:path";
import {
  agentTurnContextPromptBlock,
  agentTurnFullContextPromptBlock,
  prepareAgentTurnContext,
  type HostContextBlock,
  type AgentTurnRequest,
} from "../../core.js";
import type { CodexAppServerClient } from "./app-server-client.js";
import type { CodexTurnInputItem } from "./types.js";

export function buildCodexDeveloperInstructions(request?: Pick<AgentTurnRequest, "sessionInstructions">): string {
  const sections = [
    "You are running inside the OpenGrove host.",
    "Use Codex native tools for local workspace operations, and use OpenGrove dynamic tools for browser state, memory, skills, and host actions when they are available.",
    "Do not treat an installed skill, slash-menu entry, plan, text direction, or prompt as a completed artifact. For image tasks, only say images were generated if a real image generation tool/item produced image output and the final response includes renderable image references.",
    "When you need structured user input, use Codex's native `request_user_input` tool. OpenGrove renders that request in the chat and returns the answer to the same pending turn. Do not replace it with `host.ui.requestChoices`, and do not stop the turn after asking; wait for the native tool result and continue. If the result contains no answers because the user declined or the request timed out, continue with your safest reasonable default and do not immediately ask the same question again.",
    "When an OpenGrove dynamic tool returns an approval_required result, stop and explain that the run is waiting for host approval.",
    "OpenGrove supplies mutable Room, Skill, and Turn context in each Turn. Treat the latest Turn context as authoritative; if a question depends on mutable room state, use the available OpenGrove room tools instead of guessing from stale memory.",
    request?.sessionInstructions?.trim()
      ? `OpenGrove stable session instructions:\n${request.sessionInstructions.trim()}`
      : "",
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

export function buildCodexTurnInput(request: AgentTurnRequest, state?: HostContextBlock[]): string {
  const prepared = prepareAgentTurnContext(request);
  return [
    state === undefined ? agentTurnFullContextPromptBlock(prepared) : agentTurnContextPromptBlock(prepared, state),
    `User request:\n${request.input}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildCodexTurnInputItems(request: AgentTurnRequest, text: string): CodexTurnInputItem[] {
  const items: CodexTurnInputItem[] = [{ type: "text", text, text_elements: [] }];
  const skillItem = buildCodexSkillInputItem(request);
  if (skillItem) {
    items.push(skillItem);
  }
  for (const attachment of request.context.page?.attachments ?? []) {
    if (attachment.localPath) {
      items.push({
        type: "mention",
        name: attachment.name,
        path: attachment.localPath,
      });
    }
    if (attachment.kind !== "image" || !attachment.dataUrl || !attachment.dataUrl.startsWith("data:image/")) {
      continue;
    }
    items.push({
      type: "image",
      url: attachment.dataUrl,
      detail: "auto",
    });
  }
  return items;
}

export async function refreshCodexNativeSkillList(
  client: CodexAppServerClient,
  cwd: string,
  request: AgentTurnRequest,
): Promise<void> {
  const invocation = request.requestedSkillInvocation;
  if (!invocation || invocation.content.trim() || !invocation.sourcePath) {
    return;
  }
  if (!isProjectCodexSkillPath(invocation.sourcePath, cwd)) {
    return;
  }
  try {
    await client.request(
      "skills/list",
      {
        cwds: [cwd],
        forceReload: true,
      },
      { timeoutMs: 10_000, signal: request.signal },
    );
  } catch {
    // Skill-list refresh is a cache hint. A failure here should not block a
    // turn that already carries the exact native skill input item.
  }
}

export function imageGenerationTruthCorrection(
  request: AgentTurnRequest,
  finalText: string,
  generatedImageCount: number,
): string {
  const skillName = request.requestedSkillInvocation?.skillName;
  if (skillName !== "bottle-reference-brief") {
    return "";
  }
  if (generatedImageCount > 0 || hasRenderableImageMarkdown(finalText)) {
    return "";
  }
  if (!/(已生成|生成.{0,12}(图|图片|产品图)|可见.{0,8}(图|图片)|方向图)/.test(finalText)) {
    return "";
  }
  return [
    "更正：当前这一轮没有收到真实 `imageGeneration` 结果，也没有可渲染图片文件，所以不能视为已经生成了图片。",
    "上面的内容只能算 brief 或方向说明。这个 skill 在没有真实图像生成工具时应该降级为 4 条白底产品图 prompt，而不是把文字方向当作图片产物。",
  ].join("\n");
}

function buildCodexSkillInputItem(request: AgentTurnRequest): CodexTurnInputItem | undefined {
  const invocation = request.requestedSkillInvocation;
  if (!invocation || invocation.content.trim() || !invocation.sourcePath) {
    return undefined;
  }
  return {
    type: "skill",
    name: invocation.skillName,
    path: invocation.sourcePath,
  };
}

function isProjectCodexSkillPath(path: string, cwd: string): boolean {
  const normalizedPath = resolve(path).replace(/\\/g, "/");
  const normalizedRoot = resolve(cwd, ".codex", "skills").replace(/\\/g, "/");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

// forwarding-boundary: names the final-answer evidence predicate used by truth correction.
function hasRenderableImageMarkdown(text: string): boolean {
  return /!\[[^\]]*]\((?:\/generated\/|data:image\/|https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/)[^)]+\)/.test(
    text,
  );
}
