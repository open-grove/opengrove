import type { KernelCapabilityReport, KernelCapabilityReportEntry } from "../bridge";

export interface KernelCapabilityUiState {
  canShowPlanMode: boolean;
  canShowGoalMode: boolean;
  canShowReasoningControls: boolean;
  canShowSpeedControls: boolean;
  canShowBudgetControls: boolean;
  canUseNativeMediaInput: boolean;
  canGuideActiveTurn: boolean;
  canShowQuestionCard: boolean;
  canShowToolSource: boolean;
}

// Kernels whose runtime implements plan mode via prompt injection (planModeRuntimeInput
// in create-opengrove.ts). For these the plan toggle does exactly what it claims even
// even when certified real-runtime capability evidence is not available yet. Keep this
// prompt-mode fallback independent of whether a kernel also emits a structured plan stream.
const PROMPT_PLAN_MODE_KERNELS = new Set(["codex", "claude-code"]);

function kernelSupportsPromptPlanMode(kernel?: string): boolean {
  return Boolean(kernel && PROMPT_PLAN_MODE_KERNELS.has(kernel));
}

export function buildKernelCapabilityUiState(
  report?: KernelCapabilityReport,
  kernel?: string,
): KernelCapabilityUiState {
  const canShowPlanMode = capabilityEnabled(report, "planning.plan") || kernelSupportsPromptPlanMode(kernel);
  return {
    canShowPlanMode,
    canShowGoalMode: capabilityEnabled(report, "session.goal"),
    canShowReasoningControls: capabilityEnabled(report, "reasoning.summary"),
    canShowSpeedControls: capabilityEnabled(report, "response.speed"),
    canShowBudgetControls: capabilityEnabled(report, "budget.limit"),
    canUseNativeMediaInput: capabilityEnabled(report, "media.input"),
    canGuideActiveTurn: capabilityEnabled(report, "control.steer"),
    canShowQuestionCard: capabilityVisible(report, "interaction.askUser"),
    canShowToolSource: capabilityVisible(report, "tools.hostTool") || capabilityVisible(report, "tools.nativeTool"),
  };
}

export function capabilityEnabled(report: KernelCapabilityReport | undefined, capability: string): boolean {
  const entry = capabilityEntry(report, capability);
  return entry?.productBehavior === "enable";
}

export function capabilityVisible(report: KernelCapabilityReport | undefined, capability: string): boolean {
  const entry = capabilityEntry(report, capability);
  return entry?.productBehavior === "enable" || entry?.productBehavior === "fallback";
}

function capabilityEntry(
  report: KernelCapabilityReport | undefined,
  capability: string,
): KernelCapabilityReportEntry | undefined {
  return report?.capabilities.find((entry) => entry.capability === capability);
}
