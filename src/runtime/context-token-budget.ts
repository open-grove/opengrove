import type { AgentEvent, JsonObject } from "../core.js";

export type ContextBudgetUsageSource = "native" | "estimated" | "unavailable";
export type ContextBudgetEnforcementMode = "native-auto" | "native-trigger";
export type ContextBudgetSource = "configured" | "unconfigured";

export interface ContextBudgetResolution {
  requestedBudget?: number;
  effectiveBudget?: number;
  modelContextWindow?: number;
  budgetSource: ContextBudgetSource;
}

export interface ContextBudgetDiagnosticInput extends ContextBudgetResolution {
  runId: string;
  kernel: string;
  usageSource: ContextBudgetUsageSource;
  enforcementMode: ContextBudgetEnforcementMode;
  contextUsedTokens?: number;
  compactionTriggered?: boolean;
  compactionSucceeded?: boolean;
  reason?: string;
}

export function resolveContextTokenBudget(requested: unknown, modelContextWindow?: unknown): ContextBudgetResolution {
  const configuredBudget = positiveInteger(requested);
  const normalizedWindow = positiveInteger(modelContextWindow);
  const budgetSource: ContextBudgetSource = configuredBudget !== undefined ? "configured" : "unconfigured";
  const effectiveBudget =
    configuredBudget !== undefined
      ? normalizedWindow
        ? Math.min(configuredBudget, normalizedWindow)
        : configuredBudget
      : undefined;
  return {
    budgetSource,
    ...(configuredBudget !== undefined ? { requestedBudget: configuredBudget } : {}),
    ...(effectiveBudget !== undefined ? { effectiveBudget } : {}),
    ...(normalizedWindow ? { modelContextWindow: normalizedWindow } : {}),
  };
}

export function contextBudgetExceeded(contextUsedTokens: unknown, effectiveBudget: number | undefined): boolean {
  const used = positiveInteger(contextUsedTokens);
  return used !== undefined && effectiveBudget !== undefined && used >= effectiveBudget;
}

export function hardContextWindowExceeded(contextUsedTokens: unknown, resolution: ContextBudgetResolution): boolean {
  const used = positiveInteger(contextUsedTokens);
  return used !== undefined && resolution.modelContextWindow !== undefined && used >= resolution.modelContextWindow;
}

export function contextBudgetDiagnostic(
  input: ContextBudgetDiagnosticInput,
): Extract<AgentEvent, { type: "runtime.diagnostic" }> {
  const data: JsonObject = {
    kernel: input.kernel,
    budgetSource: input.budgetSource,
    usageSource: input.usageSource,
    enforcementMode: input.enforcementMode,
    compactionTriggered: input.compactionTriggered === true,
    compactionSucceeded: input.compactionSucceeded === true,
  };
  if (input.requestedBudget !== undefined) data.requestedBudget = input.requestedBudget;
  if (input.effectiveBudget !== undefined) data.effectiveBudget = input.effectiveBudget;
  if (input.modelContextWindow !== undefined) data.modelContextWindow = input.modelContextWindow;
  if (input.contextUsedTokens !== undefined) data.contextUsedTokens = input.contextUsedTokens;
  if (input.reason) data.reason = input.reason;
  return {
    type: "runtime.diagnostic",
    runId: input.runId,
    at: new Date().toISOString(),
    name: "context.budget.applied",
    data,
  };
}

export function estimateTextTokens(value: string): number {
  if (!value) return 0;
  // A conservative language-neutral estimate: CJK code points are commonly close
  // to one token, while Latin text averages roughly four UTF-8 characters/token.
  let cjk = 0;
  let other = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isCjkCodePoint(codePoint)) {
      cjk += 1;
    } else {
      other += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x1_0000 ? 3 : 4;
    }
  }
  return cjk + Math.ceil(other / 4);
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    // Han ideographs, compatibility ideographs, and extensions A-I.
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    codePoint === 0x3005 ||
    codePoint === 0x3007 ||
    codePoint === 0x303b ||
    (codePoint >= 0x16fe2 && codePoint <= 0x16fe3) ||
    (codePoint >= 0x2_0000 && codePoint <= 0x2_ee5f) ||
    (codePoint >= 0x2_f800 && codePoint <= 0x2_fa1f) ||
    (codePoint >= 0x3_0000 && codePoint <= 0x3_23af) ||
    // Hiragana and Katakana, including half-width and supplementary kana.
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x32d0 && codePoint <= 0x3357) ||
    (codePoint >= 0xff66 && codePoint <= 0xff9d) ||
    (codePoint >= 0x1_aff0 && codePoint <= 0x1_afff) ||
    (codePoint >= 0x1_b000 && codePoint <= 0x1_b16f) ||
    // Hangul jamo, compatibility jamo, extensions, and syllables.
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
  );
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
