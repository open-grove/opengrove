import type { MessagePart } from "../../bridge";

/** Preserve historical content while redacting credentials from retired Connector commands. */
export function normalizeClientConnectorHelpText(text: string): string {
  return text
    .replace(/(\s--pairing-code(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/(\s--cloud-url(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/(连接码[:：]\s*)[A-Z0-9_-]+/gi, "$1[redacted]");
}

/** Apply the same credential redaction to structured historical message parts. */
export function normalizeClientConnectorMessageParts(parts: MessagePart[] | undefined): MessagePart[] | undefined {
  if (!Array.isArray(parts)) return parts;
  let changed = false;
  const normalized = parts.map((part) => {
    if (part.type !== "text" && part.type !== "note") return part;
    const text = normalizeClientConnectorHelpText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? normalized : parts;
}
