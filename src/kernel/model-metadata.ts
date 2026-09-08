/** Model facts supplied by a catalog or provider, never inferred from the model name. */
export interface ModelMetadata {
  reasoning?: boolean;
  toolCall?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoningEfforts?: string[];
  interleaved?: { field: "reasoning_content" | "reasoning_details" };
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export function normalizeModelMetadata(value: unknown): ModelMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const metadata: ModelMetadata = {};
  if (typeof source.reasoning === "boolean") metadata.reasoning = source.reasoning;
  if (typeof source.toolCall === "boolean") metadata.toolCall = source.toolCall;
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const limit = source[key];
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) metadata[key] = limit;
  }
  for (const key of ["inputModalities", "outputModalities", "reasoningEfforts"] as const) {
    const items = source[key];
    if (!Array.isArray(items)) continue;
    const strings = [
      ...new Set(
        items
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim()),
      ),
    ];
    if (strings.length) metadata[key] = strings;
  }
  if (source.interleaved && typeof source.interleaved === "object" && "field" in source.interleaved) {
    const field = source.interleaved.field;
    if (field === "reasoning_content" || field === "reasoning_details") metadata.interleaved = { field };
  }
  if (source.cost && typeof source.cost === "object" && !Array.isArray(source.cost)) {
    const cost = source.cost as Record<string, unknown>;
    if (isRate(cost.input) && isRate(cost.output)) {
      metadata.cost = { input: cost.input, output: cost.output };
      if (isRate(cost.cacheRead)) metadata.cost.cacheRead = cost.cacheRead;
      if (isRate(cost.cacheWrite)) metadata.cost.cacheWrite = cost.cacheWrite;
    }
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
