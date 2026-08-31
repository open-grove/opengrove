export type ClaudeModelAliasMap = Record<string, string>;

const CLAUDE_NATIVE_MODEL_SELECTIONS = new Set([
  "mimo-v2-pro",
  "claude-code-default",
  "claude-opus-4-8",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
]);

export function normalizeClaudeRuntimeModelId(
  value: string | undefined,
  aliases?: ClaudeModelAliasMap,
): string | undefined {
  const trimmed = resolveClaudeModelAlias(value, aliases)?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (
    CLAUDE_NATIVE_MODEL_SELECTIONS.has(normalized) ||
    normalized === "claude code" ||
    normalized === "aws bedrock (api key)" ||
    normalized.endsWith("(claude code)") ||
    normalized.startsWith("gpt-")
  ) {
    return undefined;
  }
  return trimmed;
}

export function isConcreteClaudeRuntimeModel(value: string | undefined, aliases?: ClaudeModelAliasMap): boolean {
  return Boolean(normalizeClaudeRuntimeModelId(value, aliases));
}

export function isClaudeNativeModelSelection(value: string | undefined, aliases?: ClaudeModelAliasMap): boolean {
  return !isConcreteClaudeRuntimeModel(value, aliases);
}

export function resolveClaudeRuntimeModel(
  requestedModel: string | undefined,
  configuredModel: string | undefined,
  aliases?: ClaudeModelAliasMap,
): string | undefined {
  return (
    normalizeClaudeRuntimeModelId(requestedModel, aliases) ?? normalizeClaudeRuntimeModelId(configuredModel, aliases)
  );
}

function resolveClaudeModelAlias(value: string | undefined, aliases?: ClaudeModelAliasMap): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const direct = aliases?.[trimmed]?.trim();
  if (direct) return direct;
  const normalized = trimmed.toLowerCase();
  const insensitive = Object.entries(aliases ?? {})
    .find(([key]) => key.toLowerCase() === normalized)?.[1]
    ?.trim();
  return insensitive || trimmed;
}
