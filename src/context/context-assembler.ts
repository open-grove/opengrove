import type { AgentContext, AgentAttachmentContext, ContextEnvelope, ContextItem } from "../core.js";
import type { KernelCapabilities } from "../kernel/types.js";
import { KERNEL_CAPABILITY_CONTRACTS } from "../kernel/capabilities/contracts.js";

// Single source of truth: an image attachment only reaches the model when the
// kernel's media.input capability is actually wired ("mapped"). Used to avoid
// telling the model an image was "attached separately" when the runtime drops it.
function kernelSupportsMediaInput(kernelId: string | undefined): boolean {
  if (!kernelId) return false;
  const contract = KERNEL_CAPABILITY_CONTRACTS.find((entry) => entry.kernel === kernelId);
  return (
    contract?.mappings.some((mapping) => mapping.capability === "media.input" && mapping.status === "mapped") ?? false
  );
}

export interface ContextAssemblerOptions {
  maxItems?: number;
  maxCharacters?: number;
}

export type ContextAssembler = (
  input: string,
  context: AgentContext,
  request?: ContextAssemblyRequest,
) => ContextEnvelope;

export interface ContextAssemblyRequest {
  runId?: string;
  kernelId?: string;
  kernelCapabilities?: KernelCapabilities;
}

export function createDefaultContextAssembler(options: ContextAssemblerOptions = {}): ContextAssembler {
  return (input, context, request) => assembleDefaultContext(input, context, options, request);
}

export function assembleDefaultContext(
  input: string,
  context: AgentContext,
  options: ContextAssemblerOptions = {},
  request: ContextAssemblyRequest = {},
): ContextEnvelope {
  void input;
  const maxItems = options.maxItems ?? 8;
  const maxCharacters = options.maxCharacters ?? 6000;
  const mediaInputSupported = kernelSupportsMediaInput(request.kernelId);

  const items = assembleExplicitContextItems(context, mediaInputSupported);
  const selected = fitContext(items, maxItems, maxCharacters);
  return createEnvelope(
    selected,
    maxItems,
    maxCharacters,
    renderExplicitPromptBlock(selected.items, selected.truncated),
  );
}

function assembleExplicitContextItems(context: AgentContext, mediaInputSupported: boolean): ContextItem[] {
  const items: ContextItem[] = [];

  if (isExplicitUserSelection(context.page)) {
    items.push({
      id: "user.explicit_context",
      kind: "selection",
      title: "Explicitly added user context",
      text: context.page.selection,
      source: {
        quote: context.page.selection,
      },
    });
  }

  for (const attachment of context.page?.attachments ?? []) {
    items.push(createAttachmentContextItem(attachment, mediaInputSupported));
  }

  return items;
}

function isExplicitUserSelection(
  page: AgentContext["page"],
): page is NonNullable<AgentContext["page"]> & { selection: string } {
  return Boolean(page?.selection && (page.locator === "standalone-ui" || page.title === "Added context"));
}

function createAttachmentContextItem(attachment: AgentAttachmentContext, mediaInputSupported: boolean): ContextItem {
  return {
    id: `attachment.${attachment.id || attachment.name}`,
    kind: "attachment",
    title: attachment.name || "Attached file",
    text: summarizeAttachment(attachment, mediaInputSupported),
    data: {
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType ?? "",
      size: attachment.size ?? 0,
      hasText: Boolean(attachment.text),
      hasImage: Boolean(attachment.dataUrl && attachment.kind === "image"),
      localPath: attachment.localPath ?? "",
    },
  };
}

function fitContext(
  items: ContextItem[],
  maxItems: number,
  maxCharacters: number,
): { items: ContextItem[]; usedCharacters: number; truncated: boolean } {
  const fitted: ContextItem[] = [];
  let usedCharacters = 0;
  let truncated = false;

  for (const item of items) {
    if (fitted.length >= maxItems) {
      truncated = true;
      break;
    }

    const remaining = maxCharacters - usedCharacters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const text = item.text.length > remaining ? `${item.text.slice(0, Math.max(0, remaining - 1))}...` : item.text;
    if (text.length !== item.text.length) {
      truncated = true;
    }

    fitted.push({ ...item, text });
    usedCharacters += text.length;
  }

  return { items: fitted, usedCharacters, truncated };
}

function summarizeContext(items: ContextItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }

  return (
    Array.from(counts.entries())
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ") || "empty context"
  );
}

function createEnvelope(
  selected: { items: ContextItem[]; usedCharacters: number; truncated: boolean },
  maxItems: number,
  maxCharacters: number,
  promptBlock: string,
): ContextEnvelope {
  return {
    id: `ctx_${Date.now()}`,
    createdAt: new Date().toISOString(),
    summary: summarizeContext(selected.items),
    items: selected.items,
    budget: {
      maxItems,
      usedItems: selected.items.length,
      maxCharacters,
      usedCharacters: selected.usedCharacters,
      truncated: selected.truncated,
    },
    promptBlock,
  };
}

function renderExplicitPromptBlock(items: ContextItem[], truncated: boolean): string {
  if (items.length === 0) {
    return "";
  }

  const lines = ["Explicit context added by the user for this turn:"];
  for (const item of items) {
    lines.push(`\n[${item.kind}] ${item.title}`);
    if (item.source?.url) {
      lines.push(`Source: ${item.source.url}`);
    }
    if (item.source?.locator) {
      lines.push(`Locator: ${item.source.locator}`);
    }
    lines.push(item.text);
  }

  if (truncated) {
    lines.push("\nSome context was trimmed to stay within budget.");
  }

  return lines.join("\n");
}

function summarizeAttachment(attachment: AgentAttachmentContext, mediaInputSupported: boolean): string {
  const meta = [
    `Name: ${attachment.name}`,
    `Kind: ${attachment.kind}`,
    attachment.mimeType ? `MIME: ${attachment.mimeType}` : "",
    typeof attachment.size === "number" ? `Size: ${attachment.size} bytes` : "",
    attachment.localPath ? `Local path: ${attachment.localPath}` : "",
  ].filter(Boolean);

  if (attachment.text) {
    meta.push(`Content:\n${truncate(attachment.text, 3200)}`);
  } else if (attachment.kind === "image" && attachment.dataUrl) {
    if (mediaInputSupported) {
      meta.push("Image content is attached to the model input separately.");
    } else if (attachment.localPath) {
      meta.push("This runtime cannot receive image content directly; read the image file at the local path above.");
    } else {
      meta.push("This runtime cannot receive image content; only the metadata above is available for this image.");
    }
  } else if (attachment.localPath) {
    meta.push("The uploaded file copy is available on the local filesystem at the path above.");
  } else {
    meta.push("Only file metadata is available; this file type is not text-readable in the browser.");
  }

  return meta.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}
