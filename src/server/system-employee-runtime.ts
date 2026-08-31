import type { JsonObject } from "../core.js";
import type { BridgeKernelId, BridgeRuntimeControlOption, BridgeState } from "./bridge-types.js";
import { BRIDGE_KERNEL_IDS, DEFAULT_BRIDGE_MODEL_ID } from "./bridge-types.js";
import {
  getBridgeKernelOptions,
  getBridgeRuntimeControlsForKernel,
  isBridgeKernelAvailable,
} from "./kernel-selection.js";
import { getBridgeKernelDescriptor } from "./kernel-registry.js";

export interface SystemEmployeeRuntime {
  kernel: BridgeKernelId;
  model: string;
}

export function resolveSystemEmployeeRuntime(state: BridgeState): SystemEmployeeRuntime {
  const activeCandidate = activeSystemRuntimeCandidate(state);
  if (activeCandidate) {
    return {
      kernel: activeCandidate.kernel,
      model: selectedModelForActiveKernel(activeCandidate, state.model),
    };
  }

  const candidates = availableSystemRuntimeCandidates(state);
  const discoveredActiveCandidate = candidates.find((candidate) => candidate.kernel === state.kernel);
  if (discoveredActiveCandidate) {
    return {
      kernel: discoveredActiveCandidate.kernel,
      model: selectedModelForActiveKernel(discoveredActiveCandidate, state.model),
    };
  }
  const ranked = candidates
    .map((candidate) => {
      const selected = selectPreferredModel(candidate.models, candidate.defaultModel);
      return {
        kernel: candidate.kernel,
        model: selected.model,
        score: selected.score + kernelTieBreakScore(candidate.kernel, state),
      };
    })
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];
  if (best?.model) {
    return {
      kernel: best.kernel,
      model: best.model,
    };
  }

  return {
    kernel: state.kernel || "codex",
    model: state.model || DEFAULT_BRIDGE_MODEL_ID,
  };
}

function activeSystemRuntimeCandidate(state: BridgeState): RuntimeCandidate | undefined {
  if (state.kernelUnavailableReason) return undefined;
  if (!isBridgeKernelAvailable(state, state.kernel)) return undefined;
  const controls = getBridgeRuntimeControlsForKernel(state, state.kernel);
  if (readString(controls.source) === "provider-unavailable") return undefined;
  const models = readRuntimeModels(controls);
  if (!models.length) return undefined;
  return {
    kernel: state.kernel,
    models,
    defaultModel: readString(controls.defaultModel),
  };
}

function selectedModelForActiveKernel(candidate: RuntimeCandidate, selectedModel: string | undefined): string {
  const selected = selectedModel?.trim();
  if (
    selected &&
    candidate.models.some(
      (model) => model.id === selected || model.apiModelId === selected || model.canonicalModelId === selected,
    )
  )
    return selected;
  if (candidate.defaultModel?.trim()) return candidate.defaultModel.trim();
  return candidate.models[0]?.id ?? nativeDefaultModelId(candidate.kernel);
}

function nativeDefaultModelId(kernel: BridgeKernelId): string {
  return `${kernel}-default`;
}

interface RuntimeCandidate {
  kernel: BridgeKernelId;
  models: BridgeRuntimeControlOption[];
  defaultModel?: string;
}

function availableSystemRuntimeCandidates(state: BridgeState): RuntimeCandidate[] {
  const options = getBridgeKernelOptions(state);
  let available = new Set(options.filter((option) => option.available === true).map((option) => String(option.id)));
  const hostToolCapable = new Set([...available].filter((kernel) => kernelSupportsSystemTools(kernel)));
  if (hostToolCapable.size > 0) {
    available = hostToolCapable;
  }
  const candidates: RuntimeCandidate[] = [];
  for (const kernel of BRIDGE_KERNEL_IDS) {
    if (!available.has(kernel)) continue;
    const controls = getBridgeRuntimeControlsForKernel(state, kernel);
    const models = readRuntimeModels(controls);
    candidates.push({
      kernel,
      models,
      defaultModel: readString(controls.defaultModel),
    });
  }
  return candidates;
}

function kernelSupportsSystemTools(kernel: string): boolean {
  return getBridgeKernelDescriptor(kernel as BridgeKernelId).hostTools;
}

function readRuntimeModels(controls: JsonObject): BridgeRuntimeControlOption[] {
  const rawModels = Array.isArray(controls.models) ? controls.models : [];
  const models: BridgeRuntimeControlOption[] = [];
  for (const item of rawModels) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = readString(record.id);
    if (!id) continue;
    const description = readString(record.description);
    const apiModelId = readString(record.apiModelId);
    const canonicalModelId = readString(record.canonicalModelId);
    const family = readString(record.family);
    models.push({
      id,
      label: readString(record.label) || id,
      ...(description ? { description } : {}),
      ...(apiModelId ? { apiModelId } : {}),
      ...(canonicalModelId ? { canonicalModelId } : {}),
      ...(family ? { family } : {}),
    });
  }
  return models;
}

function selectPreferredModel(
  models: BridgeRuntimeControlOption[],
  defaultModel: string | undefined,
): { model: string; score: number } {
  const candidates = models.length ? models.map((model) => model.id) : [];
  if (defaultModel && !candidates.includes(defaultModel)) {
    candidates.push(defaultModel);
  }
  if (!candidates.length) {
    return {
      model: defaultModel || DEFAULT_BRIDGE_MODEL_ID,
      score: 0,
    };
  }
  return candidates
    .map((model) => ({
      model,
      score: modelPreferenceScore(model) + (model === defaultModel ? 5 : 0),
    }))
    .sort((left, right) => right.score - left.score)[0]!;
}

function modelPreferenceScore(model: string): number {
  const normalized = model.trim().toLowerCase();
  if (/claude.*opus.*4[.-]8|opus.*4[.-]8/.test(normalized)) return 2_200;
  if (normalized === "gpt-5.5") return 2_000;
  if (/claude.*4[.-]7/.test(normalized)) return 1_200;
  if (normalized === "glm-5.1") return 1_150;
  if (normalized === "gpt-5.4") return 1_100;
  if (/claude.*4[.-]6/.test(normalized)) return 1_050;
  if (normalized === "gpt-5.4-mini") return 1_000;
  if (/^gpt-5\./.test(normalized)) return 950;
  if (/^glm-5/.test(normalized)) return 900;
  if (normalized === "mimo-v2-pro") return 850;
  if (normalized.includes("latest")) return 820;
  if (normalized.includes("default")) return 200;
  return 500;
}

function kernelTieBreakScore(kernel: BridgeKernelId, state: BridgeState): number {
  const active = kernel === state.kernel ? 20 : 0;
  const score: Record<string, number> = {
    codex: 12,
    "claude-code": 10,
    hermes: 8,
    opencode: 5,
  };
  return active + (score[kernel] ?? 0);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}
