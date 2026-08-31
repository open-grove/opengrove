import type { KernelOptionUnavailableCode } from "@opengrove/agent-protocol";
import type { KernelOption, ModelId, RuntimeControlOption, RuntimeControls } from "../bridge";
import { DEFAULT_MODEL_ID, MODEL_OPTIONS } from "../bridge";
import { translate } from "../i18n";
import type { TranslationFn, TranslationKey } from "../i18n";

export type KernelModelOption = RuntimeControlOption & { routeModelIds?: string[] };

const BINDING_STATUS_LABELS: Record<
  "selection-required" | "missing-key" | "missing-provider" | "disabled" | "unsupported" | "unknown",
  TranslationKey
> = {
  "selection-required": "settings.bindingSelectionRequired",
  "missing-key": "settings.bindingMissingKey",
  "missing-provider": "settings.noAvailableProvider",
  disabled: "settings.bindingDisabled",
  unsupported: "settings.bindingUnsupported",
  unknown: "settings.bindingUnknown",
};

const KERNEL_UNAVAILABLE_LABEL_KEYS: Record<string, TranslationKey> = {
  ww_provider_key_missing: "settings.kernelUnavailableProviderKey",
  provider_key_missing: "settings.kernelUnavailableProviderKey",
  provider_disabled: "settings.kernelUnavailableProviderDisabled",
  provider_unsupported: "settings.kernelUnavailableProviderUnsupported",
  provider_not_found: "settings.kernelUnavailableProviderMissing",
  provider_selection_required: "settings.bindingSelectionRequired",
  kernel_provider_unavailable: "settings.kernelUnavailableProvider",
  kernel_executable_missing: "settings.kernelUnavailableExecutable",
  kernel_runtime_unavailable: "settings.kernelUnavailableRuntime",
} satisfies Record<KernelOptionUnavailableCode, TranslationKey>;

// 卡片副标题恒定描述「Provider 路径」：显式绑定显示 Provider 名（附异常状态），
// Login 路径只在探测到可用账号登录时显示其名称。
export function kernelBindingLabel(
  kernel: Pick<KernelOption, "bindingKind" | "bindingStatus" | "providerId" | "providerLabel">,
  t: TranslationFn = translate,
): string {
  if (kernel.bindingKind === "provider") {
    const name = kernel.providerLabel || kernel.providerId || "Provider";
    const status =
      kernel.bindingStatus && kernel.bindingStatus !== "ready" ? t(BINDING_STATUS_LABELS[kernel.bindingStatus]) : "";
    return status ? `${name} · ${status}` : name;
  }
  if (kernel.bindingKind === "login") {
    return kernel.bindingStatus === "ready" && kernel.providerLabel
      ? kernel.providerLabel
      : t("settings.noAvailableLogin");
  }
  if (kernel.bindingKind === "unresolved") {
    return t("settings.bindingSelectionRequired");
  }
  return kernel.providerLabel || "";
}

export function kernelExecutableProbeDescription(
  kernel: Pick<KernelOption, "label" | "executableProbe">,
  t: TranslationFn = translate,
): string {
  const probe = kernel.executableProbe;
  if (!probe || probe.status === "available") return "";
  const optional = probe.role === "optional-diagnostic";
  const sourceLabel =
    probe.source === "configured"
      ? t("settings.configuredKernelCommand", { kernel: kernel.label })
      : probe.source === "environment"
        ? probe.sourceName
        : undefined;
  const explicitSource =
    sourceLabel && probe.requestedCommand ? { sourceLabel, requestedCommand: probe.requestedCommand } : undefined;
  if (probe.status === "missing") {
    if (optional) {
      return explicitSource
        ? t("settings.kernelOptionalExecutableOverrideMissing", {
            source: explicitSource.sourceLabel,
            command: explicitSource.requestedCommand,
            kernel: kernel.label,
          })
        : "";
    }
    return explicitSource
      ? t("settings.kernelExecutableOverrideMissing", {
          source: explicitSource.sourceLabel,
          command: explicitSource.requestedCommand,
        })
      : t("settings.kernelUnavailableExecutable", { kernel: kernel.label });
  }
  const path = probe.path || kernel.label;
  if (probe.status === "timeout") {
    if (optional) {
      return explicitSource
        ? t("settings.kernelOptionalExecutableOverrideProbeTimedOut", {
            source: explicitSource.sourceLabel,
            path,
            kernel: kernel.label,
          })
        : t("settings.kernelOptionalExecutableProbeTimedOut", { path, kernel: kernel.label });
    }
    return t("settings.kernelExecutableProbeTimedOut", { path });
  }
  if (probe.exitCode !== undefined) {
    if (optional) {
      return explicitSource
        ? t("settings.kernelOptionalExecutableOverrideExitFailed", {
            source: explicitSource.sourceLabel,
            path,
            exitCode: probe.exitCode,
            kernel: kernel.label,
          })
        : t("settings.kernelOptionalExecutableExitFailed", {
            path,
            exitCode: probe.exitCode,
            kernel: kernel.label,
          });
    }
    if (explicitSource) {
      return t("settings.kernelExecutableOverrideExitFailed", {
        source: explicitSource.sourceLabel,
        path,
        exitCode: probe.exitCode,
      });
    }
    return t("settings.kernelExecutableExitFailed", { path, exitCode: probe.exitCode });
  }
  if (probe.errorCode) {
    if (optional) {
      return explicitSource
        ? t("settings.kernelOptionalExecutableOverrideErrorFailed", {
            source: explicitSource.sourceLabel,
            path,
            errorCode: probe.errorCode,
            kernel: kernel.label,
          })
        : t("settings.kernelOptionalExecutableErrorFailed", {
            path,
            errorCode: probe.errorCode,
            kernel: kernel.label,
          });
    }
    if (explicitSource) {
      return t("settings.kernelExecutableOverrideErrorFailed", {
        source: explicitSource.sourceLabel,
        path,
        errorCode: probe.errorCode,
      });
    }
    return t("settings.kernelExecutableErrorFailed", { path, errorCode: probe.errorCode });
  }
  if (optional) {
    return explicitSource
      ? t("settings.kernelOptionalExecutableOverrideProbeFailed", {
          source: explicitSource.sourceLabel,
          path,
          kernel: kernel.label,
        })
      : t("settings.kernelOptionalExecutableProbeFailed", { path, kernel: kernel.label });
  }
  if (explicitSource) {
    return t("settings.kernelExecutableOverrideProbeFailed", { source: explicitSource.sourceLabel, path });
  }
  return t("settings.kernelExecutableProbeFailed", { path });
}

export function kernelRuntimeExecutableProbeDescription(
  kernel: Pick<KernelOption, "label" | "executableProbe">,
  t: TranslationFn = translate,
): string {
  return kernel.executableProbe?.role === "runtime-required" ? kernelExecutableProbeDescription(kernel, t) : "";
}

export function kernelUnavailableDescription(
  kernel: Pick<KernelOption, "label" | "reason" | "unavailableCode" | "executableProbe">,
  t: TranslationFn = translate,
): string {
  const executableDiagnostic = kernelRuntimeExecutableProbeDescription(kernel, t);
  if (executableDiagnostic) return executableDiagnostic;
  const labelKey = kernel.unavailableCode ? KERNEL_UNAVAILABLE_LABEL_KEYS[kernel.unavailableCode] : undefined;
  if (labelKey) return t(labelKey, { kernel: kernel.label });
  return kernel.reason || t("settings.kernelUnavailableRuntime", { kernel: kernel.label });
}

// 只有 Host 为当前内核生成的 *-default 才是本机 Provider 配置占位符；Provider 可以合法声明同名真实模型。
export function isKernelDefaultModelOption(
  kernelId: string | undefined,
  option: KernelModelOption,
  runtimeControls?: Pick<RuntimeControls, "source">,
): boolean {
  return Boolean(kernelId && option.id === `${kernelId}-default` && !runtimeControls?.source.startsWith("provider:"));
}

export const MODEL_LABELS: Record<string, string> = {
  get "claude-code-default"() {
    return translate("runtime.followClaudeCodeConfig");
  },
  get "pi-default"() {
    return translate("runtime.followPiConfig");
  },
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.2": "GPT-5.2",
  "claude-opus-4-6": "Claude Opus 4.6",
  "MiMo-V2-Pro": "MiMo-V2-Pro",
};

export function runtimeControlsForKernel(
  kernelId: string | undefined,
  activeRuntimeControls: RuntimeControls | undefined,
  controlsByKernel: Record<string, RuntimeControls> | undefined,
): RuntimeControls | undefined {
  if (!kernelId) return undefined;
  return (
    controlsByKernel?.[kernelId] ?? (activeRuntimeControls?.kernel === kernelId ? activeRuntimeControls : undefined)
  );
}

export function modelOptionsForKernel(kernelId?: string, runtimeControls?: RuntimeControls): KernelModelOption[] {
  const controls = runtimeControls?.kernel === kernelId ? runtimeControls : undefined;
  const discovered = controls?.models
    ?.filter((item): item is KernelModelOption => Boolean(item.id.trim()))
    .map((item) => ({ ...item }));
  if (controls && Array.isArray(controls.models)) {
    return collapseModelOptions(discovered ?? []);
  }
  if (kernelId === "codex") {
    return MODEL_OPTIONS.filter((item) => item.id.startsWith("gpt-"));
  }
  if (kernelId === "claude-code") {
    return [{ id: "claude-code-default", label: MODEL_LABELS["claude-code-default"]! }];
  }
  if (kernelId === "pi") {
    return [{ id: "pi-default", label: MODEL_LABELS["pi-default"]! }];
  }
  return [...MODEL_OPTIONS];
}

export function collapseModelOptions(options: KernelModelOption[]): KernelModelOption[] {
  const collapsed = new Map<string, KernelModelOption>();
  const primaryOfferingByCanonicalId = new Map<string, string>();
  for (const option of options) {
    const id = option.id.trim();
    if (!id) continue;
    const canonicalId = option.canonicalModelId?.trim() || id;
    const offeringKey = modelOfferingKey(option);
    const routeModelIds = uniqueModelIds([...(option.routeModelIds ?? []), id, option.apiModelId]);
    const current = collapsed.get(offeringKey);
    if (!current) {
      const primaryOffering = primaryOfferingByCanonicalId.get(canonicalId);
      primaryOfferingByCanonicalId.set(canonicalId, primaryOffering ?? offeringKey);
      collapsed.set(offeringKey, {
        ...option,
        id: primaryOffering ? id : canonicalId,
        canonicalModelId: primaryOffering ? undefined : option.canonicalModelId,
        routeModelIds,
      });
      continue;
    }
    current.routeModelIds = uniqueModelIds([...(current.routeModelIds ?? []), ...routeModelIds]);
    current.defaultProviderId ||= option.defaultProviderId;
  }
  return [...collapsed.values()];
}

export function modelOfferingKey(option: Pick<KernelModelOption, "id" | "label" | "canonicalModelId">): string {
  const id = option.id.trim();
  const canonicalId = option.canonicalModelId?.trim() || id;
  const catalogName = option.label.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  return catalogName ? `name:${catalogName}` : `id:${canonicalId}`;
}

export function modelOptionMatchesId(option: KernelModelOption, modelId: string | undefined): boolean {
  const normalized = modelId?.trim();
  if (!normalized) return false;
  return (
    option.id === normalized ||
    option.apiModelId === normalized ||
    option.canonicalModelId === normalized ||
    option.routeModelIds?.includes(normalized) === true
  );
}

function uniqueModelIds(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

export function modelLabel(option: KernelModelOption): string {
  // 数据源(内核缓存/provider 发现)给出的真实标签优先;label 只是 id 回显时,
  // 才用本地美化名兜底,避免硬编码名单否决上游声明。
  if (option.label && option.label !== option.id) return option.label;
  return MODEL_LABELS[option.id as ModelId] || option.label;
}

export function resolveDefaultModelForKernel(input: {
  kernelId: string;
  activeKernel: string | undefined;
  activeModel: ModelId;
  runtimeControls?: RuntimeControls;
  runtimeControlsByKernel?: Record<string, RuntimeControls>;
  options?: KernelModelOption[];
}): string {
  const controls = runtimeControlsForKernel(input.kernelId, input.runtimeControls, input.runtimeControlsByKernel);
  const options = input.options ?? modelOptionsForKernel(input.kernelId, controls);
  const activeOption =
    input.kernelId === input.activeKernel
      ? options.find((option) => modelOptionMatchesId(option, input.activeModel))
      : undefined;
  if (activeOption) {
    return activeOption.id;
  }
  const defaultOption = controls?.defaultModel
    ? options.find((option) => modelOptionMatchesId(option, controls.defaultModel))
    : undefined;
  if (defaultOption) {
    return defaultOption.id;
  }
  return options[0]?.id || input.activeModel || DEFAULT_MODEL_ID;
}
