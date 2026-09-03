import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AgentEvent,
  AgentAttachmentContext,
  AgentRuntime,
  AgentTurnRequest,
  JsonObject,
  JsonValue,
  ToolDefinition,
} from "../core.js";
import { createOpenGrove } from "../app/create-opengrove.js";
import { createKernelRuntime } from "../kernel/adapter.js";
import {
  hasCorrelatedToolProgress,
  hasFinishedTool,
  inspectAgentTurnEvents,
} from "./harnesses/kernel-event-contract.js";
import { providerUnavailableReason } from "./kernel-real-runtime-probe-classification.js";
import type { KernelAdapter } from "../kernel/types.js";
import { createClaudeCodeKernelAdapter } from "../kernel/adapters/claude-code.js";
import { createCodexKernelAdapter } from "../kernel/adapters/codex.js";
import { createKimiKernelAdapter, resolveKimiCommand } from "../kernel/adapters/kimi.js";
import { createOpenCodeKernelAdapter, resolveOpenCodeCommand } from "../kernel/adapters/opencode.js";
import { createHermesKernelAdapter } from "../kernel/adapters/hermes.js";
import { createOpenClawGatewayKernelAdapter } from "../kernel/adapters/openclaw.js";
import { createPiKernelAdapter } from "../kernel/adapters/pi.js";
import { resolveHermesCommandPath } from "../runtime/hermes-runtime.js";
import { resolveOpenClawGatewayConnection } from "../runtime/openclaw-gateway-runtime.js";
import { BRIDGE_KERNEL_IDS, type BridgeKernelId, type BridgeProviderProfile } from "../server/bridge-types.js";
import { hermesProviderConfigForKernel, providerEnvForKernel } from "../server/provider-profiles.js";
import { KERNEL_CAPABILITY_CONTRACTS } from "../kernel/capabilities/contracts.js";
import {
  REAL_RUNTIME_EVIDENCE_PATH,
  readRealRuntimeEvidenceFile,
  type KernelRealRuntimeEvidenceFile,
  type KernelRuntimeProbeEventSummary,
  type KernelRuntimeProbeRecord,
} from "../kernel/capabilities/real-runtime-evidence.js";
import {
  STANDARD_KERNEL_CAPABILITY_IDS,
  type KernelCapabilityId,
  type KernelContractMapping,
  type KernelContractTestEvidence,
} from "../kernel/capabilities/types.js";

interface RunnerOptions {
  cwd: string;
  outPath: string;
  kernels: BridgeKernelId[];
  capabilities: KernelCapabilityId[];
  timeoutMs: number;
  openAiBaseUrl?: string;
  openAiApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicApiKey?: string;
  model?: string;
  mergeExisting: boolean;
}

interface AdapterResolution {
  adapter?: KernelAdapter;
  providerKind: "native" | "openai-compatible" | "anthropic-compatible" | "unknown";
  providerBaseUrl?: string;
  providerModel?: string;
  command?: string;
  kernelVersion?: string;
  runtimeMode?: string;
  skippedReason?: string;
}

interface CollectedTurn {
  events: AgentEvent[];
  durationMs: number;
  error?: string;
  timedOut: boolean;
  aborted: boolean;
  steer?: {
    attempted: boolean;
    ok: boolean;
    guided: boolean;
    error?: string;
  };
  compact?: {
    attempted: boolean;
    ok: boolean;
    compacted: boolean;
    error?: string;
  };
}

type ProbeCaseKind =
  | "basic"
  | "planning"
  | "ask-user"
  | "host-tool"
  | "parallel-tools"
  | "progress-tool"
  | "native-tool"
  | "approval"
  | "stop"
  | "steer"
  | "compact"
  | "goal"
  | "budget-limit"
  | "auth-refresh"
  | "sandbox-policy"
  | "speed-control"
  | "artifact"
  | "media"
  | "structured-output"
  | "reasoning";

interface ProbeCase {
  kind: ProbeCaseKind;
  marker: string;
  input: string;
  tools?: ToolDefinition[];
  accessMode?: AgentTurnRequest["accessMode"];
  requestedEffort?: AgentTurnRequest["requestedEffort"];
  threadGoal?: AgentTurnRequest["threadGoal"];
  policy?: AgentTurnRequest["policy"];
  runtimeEnv?: NodeJS.ProcessEnv;
  codexApprovalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  budgetLimitUsd?: number;
  abortAfterMs?: number;
  timeoutMs?: number;
  attachments?: AgentAttachmentContext[];
  structuredOutputSchema?: JsonObject;
  contextTokenBudget?: number;
  artifactPath?: string;
  cleanupPaths?: string[];
}

interface ProbeCaseResult {
  kind: ProbeCaseKind;
  case: ProbeCase;
  resolution: AdapterResolution;
  collected?: CollectedTurn;
  skippedReason?: string;
}

interface CapabilityOutcome {
  passed: boolean;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const STOP_ABORT_AFTER_MS = 2_000;
const STOP_TIMEOUT_MS = 25_000;
const CERTIFIABLE_MAPPING_STATUSES = new Set<KernelContractMapping["status"]>(["mapped", "fallback"]);
const HOST_ECHO_TOOL_ID = "host.echo";
const HOST_APPROVAL_TOOL_ID = "host.approval_probe";
const HOST_DELAY_A_TOOL_ID = "host.delay_a";
const HOST_DELAY_B_TOOL_ID = "host.delay_b";
const HOST_STOP_TOOL_ID = "host.stop_probe";
const HOST_PROGRESS_TOOL_ID = "host.progress_probe";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const options = parseArgs(args);
  const generatedAt = new Date().toISOString();
  const probes: KernelRuntimeProbeRecord[] = [];

  for (const kernel of options.kernels) {
    const records = await runKernelCapabilityProbes(kernel, options, generatedAt);
    probes.push(...records);
  }

  const contractTests = probes
    .filter((probe) => probe.status === "passed")
    .flatMap((probe) => toContractEvidence(probe, evidenceSourcePath(options.outPath, options.cwd)));

  const file: KernelRealRuntimeEvidenceFile = mergeRealRuntimeEvidence(options, {
    schemaVersion: 1,
    generatedAt,
    source: "kernel-capability-real-runtime-probe-runner",
    probes,
    contractTests,
  });

  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(file, null, 2)}\n`);

  printSummary(file, options.outPath, probes);
}

async function runKernelCapabilityProbes(
  kernel: BridgeKernelId,
  options: RunnerOptions,
  generatedAt: string,
): Promise<KernelRuntimeProbeRecord[]> {
  const contract = KERNEL_CAPABILITY_CONTRACTS.find((item) => item.kernel === kernel);
  const records: KernelRuntimeProbeRecord[] = [];
  const caseCache = new Map<ProbeCaseKind, Promise<ProbeCaseResult>>();
  const checkedAtValue = checkedAt(generatedAt);
  const hostVersion = readHostVersion();

  const getCase = (kind: ProbeCaseKind): Promise<ProbeCaseResult> => {
    const existing = caseCache.get(kind);
    if (existing) return existing;
    const promise = runProbeCase(kind, kernel, options);
    caseCache.set(kind, promise);
    return promise;
  };

  for (const capability of options.capabilities) {
    const mapping = contract?.mappings.find((item) => item.capability === capability);
    const testId = mapping?.expectedContractTest ?? `${kernel}.${capability}`;
    const marker = createMarker(testId);
    const emptyBase = {
      kernel,
      verification: "real_runtime" as const,
      checkedAt: checkedAtValue,
      ...(hostVersion ? { hostVersion } : {}),
      marker,
      provider: { kind: "unknown" as const },
    };

    if (!mapping) {
      records.push(skippedProbe(emptyBase, capability, testId, "no_contract_mapping"));
      continue;
    }

    if (!CERTIFIABLE_MAPPING_STATUSES.has(mapping.status)) {
      records.push(skippedProbe(emptyBase, capability, testId, `contract_${mapping.status}`));
      continue;
    }

    if (!mapping.expectedContractTest) {
      records.push(skippedProbe(emptyBase, capability, testId, "no_contract_test_declared"));
      continue;
    }

    const kind = probeKindForCapability(kernel, capability);
    if (!kind) {
      records.push(failedProbe(emptyBase, capability, testId, "no_real_runtime_probe_implemented"));
      continue;
    }

    const result = await getCase(kind);
    const base = {
      kernel,
      verification: "real_runtime" as const,
      checkedAt: checkedAtValue,
      ...(hostVersion ? { hostVersion } : {}),
      ...(result.resolution.kernelVersion ? { kernelVersion: result.resolution.kernelVersion } : {}),
      ...(result.resolution.runtimeMode ? { runtimeMode: result.resolution.runtimeMode } : {}),
      marker: result.case.marker,
      provider: providerMetadata(result.resolution),
      command: evidenceCommand(result.resolution.command),
    };

    if (result.skippedReason || !result.collected) {
      records.push(skippedProbe(base, capability, testId, result.skippedReason ?? "probe_case_unavailable"));
      continue;
    }

    const events = summarizeEvents(result.collected.events, result.collected.steer, result.collected.compact);
    const outcome = evaluateCapabilityProbe({
      kernel,
      capability,
      kind,
      result,
      events,
    });
    const common = {
      ...base,
      durationMs: result.collected.durationMs,
      timedOut: result.collected.timedOut,
      aborted: result.collected.aborted,
      events,
      responsePreview: responsePreview(result.collected.events),
      error: result.collected.error,
    };
    const providerUnavailable = providerUnavailableReason(outcome.reason);
    if (!outcome.passed && providerUnavailable) {
      records.push({
        id: testId,
        capability,
        testId,
        status: "skipped",
        ...common,
        reason: `provider_unavailable: ${providerUnavailable}`,
      });
      continue;
    }
    records.push({
      id: testId,
      capability,
      testId,
      status: outcome.passed ? "passed" : "failed",
      ...common,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
  }

  for (const result of await Promise.all(caseCache.values())) {
    cleanupProbeCase(result.case);
  }

  return records;
}

async function runProbeCase(
  kind: ProbeCaseKind,
  kernel: BridgeKernelId,
  options: RunnerOptions,
): Promise<ProbeCaseResult> {
  const probeCase = createProbeCase(kind, kernel, options);
  const resolution = await createAgentAdapter(kernel, options, probeCase);
  if (!resolution.adapter) {
    return {
      kind,
      case: probeCase,
      resolution,
      skippedReason: resolution.skippedReason ?? "adapter_unavailable",
    };
  }

  const health = await resolution.adapter.healthCheck().catch((error: unknown) => ({
    status: "unavailable" as const,
    message: error instanceof Error ? error.message : String(error),
  }));
  if (health.status !== "ok") {
    await resolution.adapter.dispose?.();
    return {
      kind,
      case: probeCase,
      resolution,
      skippedReason: health.message || `kernel_health_${health.status}`,
    };
  }

  resolution.runtimeMode = resolution.adapter.contract.labels.integrationMode;
  const discovery = await resolution.adapter.discover?.().catch(() => undefined);
  resolution.kernelVersion =
    discovery?.version ?? (kernel === "pi" ? readDependencyVersion("@earendil-works/pi-agent-core") : undefined);

  const runtime = createKernelRuntime(resolution.adapter);
  const collected = await collectProbeTurn({
    runtime,
    probeCase,
    kernel,
    options,
    requestedModelId: isExternalProbeProvider(resolution.providerKind) ? options.model : undefined,
  });
  await resolution.adapter.dispose?.();

  return {
    kind,
    case: probeCase,
    resolution,
    collected,
  };
}

async function createAgentAdapter(
  kernel: BridgeKernelId,
  options: RunnerOptions,
  probeCase?: ProbeCase,
): Promise<AdapterResolution> {
  const provider = probeProvider(options);
  const providerEnv = providerEnvForKernel(kernel, provider, options.model);
  const providerKind =
    provider && providerEnv
      ? provider.protocol === "anthropic-compatible"
        ? "anthropic-compatible"
        : "openai-compatible"
      : "native";
  const configuredModel = isExternalProbeProvider(providerKind) ? options.model : undefined;
  const providerBaseUrl =
    providerKind === "anthropic-compatible"
      ? provider?.anthropicBaseUrl
      : providerKind === "openai-compatible"
        ? provider?.openaiBaseUrl
        : undefined;

  if (kernel === "codex") {
    return {
      adapter: createCodexKernelAdapter({
        cwd: options.cwd,
        env: probeCase?.runtimeEnv,
        approvalPolicy: probeCase?.codexApprovalPolicy,
      }),
      providerKind: "native",
    };
  }

  if (kernel === "claude-code") {
    return {
      adapter: createClaudeCodeKernelAdapter({
        cwd: options.cwd,
        permissionMode: "default",
        configuredModel,
        env: providerEnv,
      }),
      providerKind,
      providerBaseUrl,
      providerModel: isExternalProbeProvider(providerKind) ? options.model : undefined,
    };
  }

  if (kernel === "hermes") {
    const command = resolveHermesCommandPath();
    if (!command) {
      return { providerKind, skippedReason: "Hermes CLI command was not found." };
    }
    const providerConfig = hermesProviderConfigForKernel(provider, options.model);
    return {
      adapter: createHermesKernelAdapter({
        command,
        cwd: options.cwd,
        configuredModel: providerConfig ? configuredModel : undefined,
        configuredProvider: providerConfig?.providerKey,
        providerConfig,
        env: providerEnv,
      }),
      providerKind,
      providerBaseUrl,
      providerModel: isExternalProbeProvider(providerKind) ? options.model : undefined,
      command,
    };
  }

  if (kernel === "pi") {
    return {
      adapter: createPiKernelAdapter({
        cwd: options.cwd,
        configuredModel,
        env: providerEnv,
      }),
      providerKind,
      providerBaseUrl,
      providerModel: isExternalProbeProvider(providerKind) ? options.model : undefined,
    };
  }

  if (kernel === "openclaw") {
    const connection = resolveOpenClawGatewayConnection({ ...process.env, ...providerEnv });
    if (!connection) {
      return { providerKind, skippedReason: "OpenClaw Gateway is not configured." };
    }
    return {
      adapter: createOpenClawGatewayKernelAdapter({
        ...connection,
        cwd: options.cwd,
        configuredModel,
        env: providerEnv,
      }),
      providerKind,
      providerBaseUrl,
      providerModel: isExternalProbeProvider(providerKind) ? options.model : undefined,
      command: connection.url,
    };
  }

  if (kernel === "opencode") {
    const command = resolveOpenCodeCommand();
    if (!command) {
      return { providerKind, skippedReason: "OpenCode CLI command was not found." };
    }
    return {
      adapter: createOpenCodeKernelAdapter({
        command,
        cwd: options.cwd,
        configuredModel,
        env: providerEnv,
      }),
      providerKind,
      providerBaseUrl,
      providerModel: isExternalProbeProvider(providerKind) ? options.model : undefined,
      command,
    };
  }

  if (kernel === "kimi") {
    const command = resolveKimiCommand();
    if (!command) {
      return { providerKind, skippedReason: "Kimi Code CLI command was not found." };
    }
    return {
      adapter: createKimiKernelAdapter({
        command,
        cwd: options.cwd,
        configuredModel,
        env: providerEnv,
      }),
      providerKind,
      providerBaseUrl,
      providerModel: isExternalProbeProvider(providerKind) ? options.model : undefined,
      command,
    };
  }

  return { providerKind: "unknown", skippedReason: `Unsupported kernel: ${kernel}` };
}

async function collectProbeTurn(input: {
  runtime: AgentRuntime;
  probeCase: ProbeCase;
  kernel: BridgeKernelId;
  options: RunnerOptions;
  requestedModelId: string | undefined;
}): Promise<CollectedTurn> {
  const { app, request } = createProbeRequest({
    kernel: input.kernel,
    probeCase: input.probeCase,
    options: input.options,
    requestedModelId: input.requestedModelId,
  });
  const controller = new AbortController();
  const started = performance.now();
  let timedOut = false;
  let aborted = false;
  const timeoutMs = input.probeCase.timeoutMs ?? input.options.timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("real_runtime_probe_timeout");
  }, timeoutMs);
  const abortTimer = input.probeCase.abortAfterMs
    ? setTimeout(() => {
        aborted = true;
        controller.abort("real_runtime_probe_abort");
      }, input.probeCase.abortAfterMs)
    : undefined;
  const events: AgentEvent[] = [];
  let error: string | undefined;
  let steer:
    | {
        attempted: boolean;
        ok: boolean;
        guided: boolean;
        error?: string;
      }
    | undefined;
  let steerPromise: Promise<void> | undefined;
  let compact:
    | {
        attempted: boolean;
        ok: boolean;
        compacted: boolean;
        error?: string;
      }
    | undefined;

  try {
    if (input.probeCase.kind === "compact" && input.kernel === "pi") {
      for (let seedIndex = 1; seedIndex <= 2; seedIndex += 1) {
        const seedEvents: AgentEvent[] = [];
        const seedRequest: AgentTurnRequest = {
          ...request,
          runId: `${request.runId}_seed_${seedIndex}`,
          input: [
            `OpenGrove Pi compaction seed turn ${seedIndex}.`,
            `Reference id: ${input.probeCase.marker}`,
            "Disposable history padding; Pi native compaction may summarize this on the next budget-aware turn.\n".repeat(
              80,
            ),
            "Reply in one short sentence and include the reference id.",
          ].join("\n"),
          contextTokenBudget: undefined,
          signal: controller.signal,
        };
        for await (const event of input.runtime.runTurn(seedRequest)) seedEvents.push(event);
        const seedError = firstErrorMessage(seedEvents);
        if (seedError) throw new Error(`pi_compaction_seed_failed:${seedError}`);
      }
    }
    if (input.probeCase.kind === "compact" && input.kernel === "claude-code") {
      for (let seedIndex = 1; seedIndex <= 3; seedIndex += 1) {
        const seedEvents: AgentEvent[] = [];
        const seedRequest: AgentTurnRequest = {
          ...request,
          runId: `${request.runId}_seed_${seedIndex}`,
          input: [
            `OpenGrove Claude Code compaction seed turn ${seedIndex}.`,
            `Reference id: ${input.probeCase.marker}`,
            "Keep this disposable history in the native session until the following /compact probe.\n".repeat(40),
            "Reply in one short sentence and include the reference id.",
          ].join("\n"),
          signal: controller.signal,
        };
        for await (const event of input.runtime.runTurn(seedRequest)) seedEvents.push(event);
        const seedError = firstErrorMessage(seedEvents);
        if (seedError) throw new Error(`claude_compaction_seed_failed:${seedError}`);
      }
    }
    for await (const event of input.runtime.runTurn({ ...request, signal: controller.signal })) {
      events.push(event);
      if (input.probeCase.kind === "steer" && event.type === "turn.started" && !steerPromise) {
        steer = { attempted: true, ok: false, guided: false };
        steerPromise = (async () => {
          try {
            const result = await input.runtime.steerTurn?.({
              runId: request.runId ?? "",
              threadId: request.context.sessionId,
              instruction: [
                "OpenGrove real runtime same-turn steering probe.",
                `Reference id: ${input.probeCase.marker}`,
                "Acknowledge this appended instruction before the final answer.",
              ].join("\n"),
            });
            steer = {
              attempted: true,
              ok: result?.ok === true,
              guided: result?.guided === true,
              ...(result?.error ? { error: result.error } : {}),
            };
          } catch (caught) {
            steer = {
              attempted: true,
              ok: false,
              guided: false,
              error: caught instanceof Error ? caught.message : String(caught),
            };
          }
        })();
      }
      if (event.type === "approval.requested") {
        app.approvals.decide(event.request.id, "approved", { realRuntimeProbe: true });
      }
      if (event.type === "question.requested") {
        app.questions.decide(event.question.id, "answered", {
          answer: input.probeCase.marker,
          realRuntimeProbe: true,
        });
      }
    }
    if (
      input.probeCase.kind === "approval" &&
      input.kernel === "hermes" &&
      !events.some((event) => event.type === "approval.requested")
    ) {
      const retryRequest: AgentTurnRequest = {
        ...request,
        runId: `${request.runId}_approval_retry`,
        input: [
          "The prior response did not complete the requested disposable directory cleanup.",
          "Please execute the terminal command from this task now, then report the result briefly.",
          "Task:",
          request.input,
        ].join("\n"),
        signal: controller.signal,
      };
      for await (const event of input.runtime.runTurn(retryRequest)) {
        events.push(event);
        if (event.type === "approval.requested") {
          app.approvals.decide(event.request.id, "approved", { realRuntimeProbe: true, retry: true });
        }
        if (event.type === "question.requested") {
          app.questions.decide(event.question.id, "answered", {
            answer: input.probeCase.marker,
            realRuntimeProbe: true,
            retry: true,
          });
        }
      }
    }
    if (steerPromise) {
      await steerPromise;
    }
    if (input.probeCase.kind === "compact" && usesDirectCompactProbe(input.kernel)) {
      compact = { attempted: true, ok: false, compacted: false };
      try {
        const result = await input.runtime.compactSession?.({
          runId: request.runId,
          threadId: request.context.sessionId,
          reason: "OpenGrove real runtime compaction probe.",
          maxTokens: input.kernel === "pi" ? 1_000 : undefined,
          metadata: { marker: input.probeCase.marker },
        });
        compact = {
          attempted: true,
          ok: result?.ok === true,
          compacted: result?.compacted === true,
          ...(result?.error ? { error: result.error } : {}),
        };
      } catch (caught) {
        compact = {
          attempted: true,
          ok: false,
          compacted: false,
          error: caught instanceof Error ? caught.message : String(caught),
        };
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
    if (abortTimer) clearTimeout(abortTimer);
  }

  return {
    events,
    durationMs: Math.round(performance.now() - started),
    error,
    timedOut,
    aborted,
    ...(steer ? { steer } : {}),
    ...(compact ? { compact } : {}),
  };
}

function createProbeRequest(input: {
  kernel: BridgeKernelId;
  probeCase: ProbeCase;
  options: RunnerOptions;
  requestedModelId: string | undefined;
}): { app: ReturnType<typeof createOpenGrove>; request: AgentTurnRequest } {
  const app = createOpenGrove({
    cwd: input.options.cwd,
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        return;
      },
    },
  });
  return {
    app,
    request: {
      input: input.probeCase.input,
      runId: `run_probe_${input.kernel}_${input.probeCase.kind}_${Date.now().toString(36)}`,
      requestedModelId: input.requestedModelId,
      requestedEffort: input.probeCase.requestedEffort,
      responseSpeed: "fast",
      budgetLimitUsd: input.probeCase.budgetLimitUsd,
      threadGoal: input.probeCase.threadGoal,
      structuredOutputSchema: input.probeCase.structuredOutputSchema,
      contextTokenBudget: input.probeCase.contextTokenBudget,
      accessMode: input.probeCase.accessMode ?? "default",
      sessionHistoryMode: "native",
      context: {
        sessionId: `session_probe_${input.kernel}_${input.probeCase.kind}_${Date.now().toString(36)}`,
        activity: "chat",
        memory: app.memory,
        artifacts: app.artifacts,
        skills: app.skills,
        packs: app.packs,
        sessions: app.sessions,
        executions: app.executions,
        workingState: app.workingState,
        approvals: app.approvals,
        questions: app.questions,
        page: input.probeCase.attachments?.length
          ? {
              title: "OpenGrove media input probe",
              url: "opengrove://real-runtime-probe/media",
              attachments: input.probeCase.attachments,
            }
          : undefined,
      },
      tools: input.probeCase.tools ?? [],
      policy: input.probeCase.policy,
      runtimeEnv: input.probeCase.runtimeEnv,
    },
  };
}

function createProbeCase(kind: ProbeCaseKind, kernel: BridgeKernelId, options: RunnerOptions): ProbeCase {
  const marker = createMarker(`${kernel}.${kind}`);
  // The prompt reads like a normal session opener, not a system-level probe.
  // An earlier phrasing ("real runtime capability probe … echo this reference
  // id … say it succeeded") matched the prompt-injection template closely enough
  // that the model intermittently refused to comply, producing flaky
  // reference_id_not_returned failures (the CLI runtime tripped this more often
  // than the SDK). We keep the marker for turn-freshness verification but carry
  // it as a natural conversation tag the model has no reason to distrust.
  const base = [
    "Hi! Let's start a quick session.",
    `For my own logs, please use this session tag when you reply: ${marker}`,
  ].join("\n");

  if (kind === "basic") {
    return {
      kind,
      marker,
      input: [
        base,
        "Just say hi back in one short sentence, and include the session tag once so I can match this reply in my notes.",
      ].join("\n"),
    };
  }

  if (kind === "planning") {
    return {
      kind,
      marker,
      input: [
        base,
        "Before the final answer, use your native task/plan channel to create a task named 'Prepare reply', then mark that task completed.",
        "Then answer in one short sentence and include the session tag.",
      ].join("\n"),
    };
  }

  if (kind === "ask-user") {
    const codexAskUserMcp = kernel === "codex" ? createCodexAskUserMcpProbe(marker) : undefined;
    return {
      kind,
      marker,
      runtimeEnv: codexAskUserMcp?.runtimeEnv,
      codexApprovalPolicy: codexAskUserMcp ? "on-request" : undefined,
      cleanupPaths: codexAskUserMcp?.cleanupPaths,
      input: [
        base,
        codexAskUserMcp
          ? `Use the MCP server ${codexAskUserMcp.serverName} tool ${codexAskUserMcp.toolName} exactly once with {"ref":"${marker}"}.`
          : "Before the final answer, use your native ask-user or clarification channel to ask the human for the reference id.",
        codexAskUserMcp
          ? "That MCP tool will ask the human for structured input through the kernel's native elicitation channel."
          : "The OpenGrove probe runner will answer with the reference id.",
        "After receiving the answer, respond in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "host-tool") {
    return {
      kind,
      marker,
      tools: [hostEchoTool()],
      accessMode: "full-access",
      input: [
        base,
        `Use the available OpenGrove host tool ${HOST_ECHO_TOOL_ID} exactly once with {"ref":"${marker}"}.`,
        "After the tool returns, answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "parallel-tools") {
    return {
      kind,
      marker,
      tools: [hostDelayTool(HOST_DELAY_A_TOOL_ID), hostDelayTool(HOST_DELAY_B_TOOL_ID)],
      accessMode: "full-access",
      input: [
        base,
        `Call both OpenGrove host tools ${HOST_DELAY_A_TOOL_ID} and ${HOST_DELAY_B_TOOL_ID} with {"ref":"${marker}"}.`,
        "Use both tools before your final answer. Include the reference id in the answer.",
      ].join("\n"),
    };
  }

  if (kind === "progress-tool") {
    return {
      kind,
      marker,
      tools: [hostProgressTool()],
      accessMode: "full-access",
      input: [
        base,
        `Call the OpenGrove host tool ${HOST_PROGRESS_TOOL_ID} exactly once with {"ref":"${marker}"}.`,
        "Wait for its progress update and result, then answer in one short sentence with the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "native-tool") {
    return {
      kind,
      marker,
      accessMode: "full-access",
      input: [
        base,
        "Use your native file, shell, or workspace inspection tool to perform a harmless read-only check of the current working directory.",
        "Do not modify files. After the native tool finishes, answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "approval") {
    if (kernel === "hermes" || kernel === "kimi") {
      const approvalDirRelativePath = join(".opengrove-real-runtime-probes", marker);
      const approvalDir = resolve(options.cwd, approvalDirRelativePath);
      mkdirSync(approvalDir, { recursive: true });
      const approvalTargetRelativePath = join(approvalDirRelativePath, "approval-target");
      const approvalTargetPath = resolve(options.cwd, approvalTargetRelativePath);
      mkdirSync(approvalTargetPath, { recursive: true });
      writeFileSync(join(approvalTargetPath, "marker.txt"), marker);
      const approvalCommand =
        kernel === "hermes" ? `rm -r ${approvalTargetRelativePath}` : `rm -rf ${approvalTargetRelativePath}`;
      const approvalInput =
        kernel === "hermes"
          ? [
              "Please remove this disposable local test directory and its marker file:",
              approvalTargetRelativePath,
              `Use the terminal to run: ${approvalCommand}`,
              "The directory was created solely for this cleanup check and contains only the marker file.",
              `After the command completes, reply briefly and include this reference id: ${marker}`,
            ].join("\n")
          : [
              base,
              "Use Kimi's terminal/shell tool to run this exact command from the current working directory:",
              approvalCommand,
              "The target is a disposable probe directory created by OpenGrove and contains only a marker file.",
              "The operation exercises Kimi's native permission path, so wait for host approval if the runtime asks.",
              "Do not explain, simulate, or merely print the command. Your next action must be the terminal/shell tool.",
              "After the operation is approved or completed, answer in one short sentence and include the reference id.",
            ].join("\n");
      return {
        kind,
        marker,
        accessMode: "default",
        cleanupPaths: [approvalDir],
        input: approvalInput,
      };
    }
    if (kernel !== "pi") {
      const approvalDirRelativePath = join(".opengrove-real-runtime-probes", marker);
      const approvalDir = resolve(options.cwd, approvalDirRelativePath);
      mkdirSync(approvalDir, { recursive: true });
      const approvalRelativePath = join(approvalDirRelativePath, "approval.txt");
      return {
        kind,
        marker,
        accessMode: "default",
        cleanupPaths: [approvalDir],
        input: [
          base,
          "Use your native file, shell, or workspace editing tool to create this text file inside the current working directory:",
          approvalRelativePath,
          `The file content must include this reference id: ${marker}`,
          "This is intentionally a write operation under the default permission mode, so wait for the host approval if your runtime requests one.",
          "After the operation is approved or completed, answer in one short sentence and include the reference id.",
        ].join("\n"),
      };
    }
    return {
      kind,
      marker,
      tools: [hostApprovalTool()],
      accessMode: "default",
      input: [
        base,
        `Use the OpenGrove host tool ${HOST_APPROVAL_TOOL_ID} exactly once with {"ref":"${marker}"}.`,
        "This tool intentionally requires approval; wait for approval, then answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "stop") {
    if (kernel === "pi") {
      return {
        kind,
        marker,
        tools: [hostStopTool()],
        abortAfterMs: STOP_ABORT_AFTER_MS,
        timeoutMs: STOP_TIMEOUT_MS,
        accessMode: "full-access",
        input: [
          base,
          `Call the OpenGrove host tool ${HOST_STOP_TOOL_ID} exactly once with {"ref":"${marker}"}.`,
          "The tool deliberately runs longer than the cancellation delay. Wait for its result before answering.",
        ].join("\n"),
      };
    }
    return {
      kind,
      marker,
      abortAfterMs: STOP_ABORT_AFTER_MS,
      timeoutMs: STOP_TIMEOUT_MS,
      accessMode: "full-access",
      input: [
        base,
        "Start a long-running response or long-running harmless operation and keep it active for at least 60 seconds.",
        "Do not finish immediately. This probe will send a real cancellation signal after a short delay.",
      ].join("\n"),
    };
  }

  if (kind === "steer") {
    return {
      kind,
      marker,
      timeoutMs: 90_000,
      accessMode: "full-access",
      input: [
        base,
        "Begin a short but not instant active turn.",
        "Wait briefly for a same-turn appended instruction from the host before finalizing if your runtime supports steering.",
        "After any appended instruction is received, answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "compact") {
    if (usesDirectCompactProbe(kernel)) {
      if (kernel === "kimi") {
        return {
          kind,
          marker,
          accessMode: "full-access",
          input: [
            base,
            "Use the native shell tool exactly once to run: python3 -c \"print('OG_COMPACTION_PADDING\\n' * 3000)\"",
            "Read the output but do not repeat it in the answer; this disposable tool result creates native history that compaction can remove.",
            "After the tool finishes, answer in one short sentence and include the reference id.",
            "OpenGrove will then call the native compact API directly and verify that the context token count decreases.",
          ].join("\n"),
        };
      }
      return {
        kind,
        marker,
        input: [
          base,
          "Create a short normal response that can remain in the native session history.",
          "After this turn finishes, OpenGrove will call the native compact API directly.",
          "Answer in one short sentence and include the reference id.",
        ].join("\n"),
      };
    }
    if (kernel === "pi") {
      return {
        kind,
        marker,
        contextTokenBudget: 9_000,
        input: [
          base,
          "This turn follows two disposable seed turns and applies a small context budget.",
          "Answer in one short sentence and include the reference id.",
        ].join("\n"),
      };
    }
    return {
      kind,
      marker,
      input: "/compact",
    };
  }

  if (kind === "goal") {
    const objective = [
      "OpenGrove real runtime native goal probe.",
      `Reference id: ${marker}.`,
      "The goal is complete when the assistant gives one short final answer that includes the reference id.",
      "Do not continue into extra investigation after that final answer.",
    ].join(" ");
    return {
      kind,
      marker,
      threadGoal: {
        enabled: true,
        objective,
        tokenBudget: 3_000,
      },
      input: [
        base,
        "This turn requests a native persisted thread goal before the model turn starts.",
        "The probe passes only if OpenGrove records the native goal configuration event.",
        "Answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "budget-limit") {
    return {
      kind,
      marker,
      budgetLimitUsd: 0.25,
      input: [
        base,
        "Run a normal short response under the host-provided hard budget limit.",
        "The probe passes only if OpenGrove records that the native runtime received the hard budget setting.",
        "Answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "auth-refresh") {
    const codexAuth = kernel === "codex" ? createCodexAuthRefreshProbe() : undefined;
    return {
      kind,
      marker,
      runtimeEnv: codexAuth?.runtimeEnv,
      cleanupPaths: codexAuth?.cleanupPaths,
      input: [
        base,
        "Start a normal Codex turn using the configured ChatGPT account auth if available.",
        "The probe only passes if the real app-server requests account/chatgptAuthTokens/refresh.",
        "Answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "sandbox-policy") {
    return {
      kind,
      marker,
      accessMode: "default",
      input: [
        base,
        "Run a normal harmless response under the requested OpenGrove access mode.",
        "The probe only passes if OpenGrove records the actual sandbox and approval policy supplied to the kernel runtime.",
        "Answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "artifact") {
    const artifactDir = resolve(options.cwd, ".opengrove-real-runtime-probes", marker);
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "artifact.txt");
    return {
      kind,
      marker,
      artifactPath,
      cleanupPaths: [artifactDir],
      accessMode: "full-access",
      input: [
        base,
        `Create a text file at this exact path: ${artifactPath}`,
        `The file content must include this reference id: ${marker}`,
        "After the file exists, answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "media") {
    const attachmentName = `${marker}.png`;
    return {
      kind,
      marker,
      attachments: [
        {
          id: `${marker}-image`,
          name: attachmentName,
          kind: "image",
          mimeType: "image/png",
          size: mediaProbePngSize(),
          dataUrl: mediaProbeDataUrl(),
        },
      ],
      input: [
        base,
        `A harmless image attachment named ${attachmentName} is attached to this turn.`,
        "The probe passes only if OpenGrove records that the native runtime received an image input item.",
        "Answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  if (kind === "structured-output") {
    return {
      kind,
      marker,
      structuredOutputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          ok: { type: "boolean" },
        },
        required: ["ref", "ok"],
        additionalProperties: false,
      },
      input: [
        base,
        "Return a JSON object that matches the host-provided output schema.",
        `The ref field must be exactly ${marker}.`,
        "The ok field must be true.",
      ].join("\n"),
    };
  }

  if (kind === "speed-control") {
    return {
      kind,
      marker,
      input: [
        base,
        "This turn requests OpenGrove's fast response-speed setting.",
        "The probe passes only if OpenGrove records that the native runtime received the speed or service-tier setting.",
        "Answer in one short sentence and include the reference id.",
      ].join("\n"),
    };
  }

  return {
    kind,
    marker,
    requestedEffort: "high",
    input: [
      base,
      "Use the native high-reasoning mode if this runtime supports it. Work through the constraints internally before answering.",
      "Compute 37 × 48 in two different ways, then internally verify the result by reducing both factors and the product modulo 9.",
      "If your runtime exposes reasoning/thinking summaries to OpenGrove, emit that summary through the native reasoning channel.",
      "Final answer only: the product, a one-line modulo-9 check, and the reference id.",
    ].join("\n"),
  };
}

function mediaProbeDataUrl(): string {
  return `data:image/png;base64,${MEDIA_PROBE_PNG_BASE64}`;
}

function mediaProbePngSize(): number {
  return Buffer.from(MEDIA_PROBE_PNG_BASE64, "base64").length;
}

const MEDIA_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVR4nGP4DwUMMAYAj4IP8TylVlEAAAAASUVORK5CYII=";

function createCodexAuthRefreshProbe(): {
  runtimeEnv: NodeJS.ProcessEnv;
  cleanupPaths: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "opengrove-codex-auth-refresh-probe-"));
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const sourceCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const sourceAuth = join(sourceCodexHome, "auth.json");
  if (existsSync(sourceAuth)) {
    copyFileSync(sourceAuth, join(codexHome, "auth.json"));
  }
  writeFileSync(
    join(codexHome, "config.toml"),
    ['approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', ""].join("\n"),
    "utf8",
  );
  return {
    runtimeEnv: {
      CODEX_HOME: codexHome,
    },
    cleanupPaths: [root],
  };
}

function createCodexAskUserMcpProbe(marker: string): {
  runtimeEnv: NodeJS.ProcessEnv;
  cleanupPaths: string[];
  serverName: string;
  toolName: string;
} {
  const root = mkdtempSync(join(tmpdir(), "opengrove-codex-ask-user-probe-"));
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const sourceCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const sourceAuth = join(sourceCodexHome, "auth.json");
  if (existsSync(sourceAuth)) {
    copyFileSync(sourceAuth, join(codexHome, "auth.json"));
  }
  const serverPath = join(root, "ask-user-mcp-server.mjs");
  const serverName = "opengrove_ask_user_probe";
  const toolName = "ask_user_probe";
  writeFileSync(serverPath, codexAskUserMcpServerSource(toolName), "utf8");
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'approval_policy = "on-request"',
      'sandbox_mode = "danger-full-access"',
      "",
      `[mcp_servers.${serverName}]`,
      `command = ${tomlString(process.execPath)}`,
      `args = [${tomlString(serverPath)}]`,
      "startup_timeout_sec = 20",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    runtimeEnv: {
      CODEX_HOME: codexHome,
      OPENGROVE_CODEX_ASK_USER_PROBE_MARKER: marker,
    },
    cleanupPaths: [root],
    serverName,
    toolName,
  };
}

function codexAskUserMcpServerSource(toolName: string): string {
  return `import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 1;

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, code, message) {
  send({ id, error: { code, message } });
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(method + " timed out"));
    }, 60000).unref?.();
  });
}

lines.on("line", (line) => {
  void handleLine(line).catch((error) => {
    process.stderr.write(String(error?.stack || error) + "\\n");
  });
});

async function handleLine(line) {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) return;
    pending.delete(message.id);
    if (message.error) pendingRequest.reject(new Error(message.error.message || "request failed"));
    else pendingRequest.resolve(message.result);
    return;
  }
  if (!message.method) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "opengrove-ask-user-probe", version: "0.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") {
    respond(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [{
        name: ${JSON.stringify(toolName)},
        title: "Ask User Probe",
        description: "Triggers an MCP elicitation so OpenGrove can verify Codex native ask-user bridging.",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Reference id to include in the final answer." },
          },
          required: ["ref"],
        },
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    const args = message.params?.arguments || {};
    const ref = typeof args.ref === "string" ? args.ref : process.env.OPENGROVE_CODEX_ASK_USER_PROBE_MARKER || "";
    const elicitation = await request("elicitation/create", {
      message: "Please confirm this OpenGrove real runtime probe reference id.",
      requestedSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            title: "Reference id",
            description: "Return the reference id supplied by the probe runner.",
          },
        },
        required: ["ref"],
      },
    });
    respond(message.id, {
      content: [{
        type: "text",
        text: "MCP elicitation completed for " + ref + ": " + JSON.stringify(elicitation),
      }],
      structuredContent: { ref, elicitation },
      isError: false,
    });
    return;
  }
  fail(message.id, -32601, "Method not found");
}
`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function hostEchoTool(): ToolDefinition {
  return {
    spec: {
      id: HOST_ECHO_TOOL_ID,
      title: "Host Echo Probe",
      description: "Echoes a reference id for real runtime host-tool capability probing.",
      activity: "local",
      risk: "read",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      },
      permission: { mode: "allow", reason: "Real runtime host tool probe." },
    },
    async execute(input) {
      return { ok: true, value: { ref: readRef(input), source: "host.echo" } };
    },
  };
}

function hostApprovalTool(): ToolDefinition {
  return {
    spec: {
      id: HOST_APPROVAL_TOOL_ID,
      title: "Host Approval Probe",
      description: "Requires approval before echoing a reference id for real runtime approval probing.",
      activity: "local",
      risk: "write",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      },
      permission: { mode: "ask", reason: "Real runtime approval probe." },
    },
    async execute(input) {
      return { ok: true, value: { ref: readRef(input), source: "host.approval_probe" } };
    },
  };
}

function hostDelayTool(id: typeof HOST_DELAY_A_TOOL_ID | typeof HOST_DELAY_B_TOOL_ID): ToolDefinition {
  return {
    spec: {
      id,
      title: id === HOST_DELAY_A_TOOL_ID ? "Host Delay A Probe" : "Host Delay B Probe",
      description: "Sleeps briefly and echoes a reference id for real runtime parallel-tool probing.",
      activity: "local",
      risk: "read",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      },
      permission: { mode: "allow", reason: "Real runtime parallel tool probe." },
    },
    async execute(input) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
      return { ok: true, value: { ref: readRef(input), source: id } };
    },
  };
}

function hostStopTool(): ToolDefinition {
  return {
    spec: {
      id: HOST_STOP_TOOL_ID,
      title: "Host Stop Probe",
      description: "Runs long enough for the real runtime cancellation probe to interrupt the active Pi turn.",
      activity: "local",
      risk: "read",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      },
      permission: { mode: "allow", reason: "Real runtime cancellation probe." },
    },
    async execute(input, context) {
      await new Promise<void>((resolveDelay, reject) => {
        const timeout = setTimeout(() => {
          context.signal?.removeEventListener("abort", onAbort);
          resolveDelay();
        }, 10_000);
        const onAbort = () => {
          clearTimeout(timeout);
          reject(new Error("host_stop_probe_aborted"));
        };
        context.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return { ok: true, value: { ref: readRef(input), source: HOST_STOP_TOOL_ID } };
    },
  };
}

function hostProgressTool(): ToolDefinition {
  return {
    spec: {
      id: HOST_PROGRESS_TOOL_ID,
      title: "Host Progress Probe",
      description: "Reports structured progress before returning a reference id.",
      activity: "local",
      risk: "read",
      input: {
        type: "json-schema",
        schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      },
      permission: { mode: "allow", reason: "Real runtime tool progress probe." },
    },
    async execute(input, context) {
      context.onProgress?.({ phase: "halfway", ref: readRef(input) });
      return { ok: true, value: { ref: readRef(input), source: HOST_PROGRESS_TOOL_ID } };
    },
  };
}

function readRef(input: JsonValue): string {
  return isJsonObject(input) && typeof input.ref === "string" ? input.ref : "";
}

function probeKindForCapability(kernel: BridgeKernelId, capability: KernelCapabilityId): ProbeCaseKind | undefined {
  if (
    capability === "message.streamText" ||
    capability === "turn.lifecycle" ||
    capability === "session.lifecycle" ||
    capability === "diagnostics.usage"
  ) {
    return "basic";
  }
  if (capability === "planning.plan") return "planning";
  if (capability === "interaction.askUser") return "ask-user";
  if (capability === "tools.hostTool" || capability === "tools.mcpServers") return "host-tool";
  if (capability === "tools.parallelCalls") return "parallel-tools";
  if (capability === "tool.progress" && kernel === "pi") return "progress-tool";
  if (capability === "tools.nativeTool" || capability === "tool.progress") return "native-tool";
  if (capability === "approval.request") return "approval";
  if (capability === "control.stop") return "stop";
  if (capability === "control.steer" && (kernel === "codex" || kernel === "hermes")) return "steer";
  if (capability === "session.compact") return "compact";
  if (capability === "session.goal" && kernel === "codex") return "goal";
  if (capability === "response.speed" && kernel === "codex") return "speed-control";
  if (capability === "budget.limit" && kernel === "claude-code") return "budget-limit";
  if (capability === "auth.refresh" && kernel === "codex") return "auth-refresh";
  if (capability === "output.artifacts") return "artifact";
  if (
    capability === "media.input" &&
    (kernel === "codex" || kernel === "claude-code" || kernel === "pi" || kernel === "opencode" || kernel === "kimi")
  )
    return "media";
  if (capability === "output.structured" && kernel === "codex") return "structured-output";
  if (capability === "reasoning.nativeText" || capability === "reasoning.summary") return "reasoning";
  if (capability === "sandbox.policy" && kernel === "codex") return "sandbox-policy";
  if (capability === "sandbox.policy" && (kernel === "codex" || kernel === "claude-code")) return "approval";
  return undefined;
}

function usesDirectCompactProbe(kernel: BridgeKernelId): boolean {
  return (
    kernel === "claude-code" ||
    kernel === "hermes" ||
    kernel === "openclaw" ||
    kernel === "opencode" ||
    kernel === "kimi" ||
    kernel === "pi"
  );
}

function evaluateCapabilityProbe(input: {
  kernel: BridgeKernelId;
  capability: KernelCapabilityId;
  kind: ProbeCaseKind;
  result: ProbeCaseResult;
  events: KernelRuntimeProbeEventSummary;
}): CapabilityOutcome {
  const collected = input.result.collected;
  if (!collected) return { passed: false, reason: "probe_case_missing" };
  const markerMatched = textFromEvents(collected.events).includes(input.result.case.marker);
  const cleanTurn = !collected.error && !collected.timedOut && !input.events.error;
  const turnContract = inspectAgentTurnEvents(collected.events);
  const terminalMarkerMatched = turnContract.responseText.includes(input.result.case.marker);
  const terminalAssistantConsistent =
    turnContract.assistantDeltaCount === 0 || turnContract.assistantTextMatchesResponse;
  const completedTerminalTurn =
    cleanTurn &&
    turnContract.lifecycleClosedExactlyOnce &&
    turnContract.modelResponseCount === 1 &&
    turnContract.modelResponseBeforeTurnFinished &&
    terminalAssistantConsistent &&
    terminalMarkerMatched;
  const blockingError = collected.error ?? firstErrorMessage(collected.events);
  if (providerUnavailableReason(blockingError)) {
    return { passed: false, reason: blockingError };
  }

  if (input.capability === "message.streamText") {
    return outcome(
      completedTerminalTurn && turnContract.assistantDeltaBeforeResponse && turnContract.assistantTextMatchesResponse,
      {
        markerMatched: terminalMarkerMatched,
        cleanTurn,
        events: input.events,
        timedOut: collected.timedOut,
        error: collected.error ?? firstErrorMessage(collected.events),
      },
    );
  }

  if (input.capability === "turn.lifecycle") {
    return outcome(cleanTurn && turnContract.lifecycleClosedExactlyOnce, {
      markerMatched,
      cleanTurn,
      events: input.events,
      timedOut: collected.timedOut,
      error: collected.error ?? firstErrorMessage(collected.events),
    });
  }

  if (input.capability === "session.lifecycle") {
    return outcome(Boolean(input.events.sessionTrace), { reason: "missing_session_trace" });
  }

  if (input.capability === "diagnostics.usage") {
    return outcome(Boolean(input.events.modelUsage || input.events.usageDiagnostic), { reason: "missing_usage_event" });
  }

  if (input.capability === "response.speed") {
    return outcome(Boolean(input.events.responseSpeedConfigured), {
      reason: "response_speed_not_observed_as_runtime_event",
    });
  }

  if (input.capability === "planning.plan") {
    return outcome(input.events.planningUpdated, { reason: "missing_planning_updated" });
  }

  if (input.capability === "interaction.askUser") {
    return outcome(input.events.questionRequested, { reason: "missing_question_requested" });
  }

  if (input.capability === "tools.hostTool") {
    return outcome(cleanTurn && hasFinishedTool(collected.events, HOST_ECHO_TOOL_ID), {
      reason: "host_tool_not_completed",
    });
  }

  if (input.capability === "tools.mcpServers") {
    return outcome(cleanTurn && hasFinishedTool(collected.events, HOST_ECHO_TOOL_ID), {
      reason: "mcp_host_tool_not_completed",
    });
  }

  if (input.capability === "tools.parallelCalls") {
    return outcome(parallelToolsOverlapped(collected.events), { reason: "parallel_tool_overlap_not_observed" });
  }

  if (input.capability === "tools.nativeTool") {
    return outcome(Boolean(input.events.nativeToolFinished), { reason: "native_tool_not_observed" });
  }

  if (input.capability === "tool.progress") {
    const matchesTool =
      input.kind === "progress-tool" ? (toolId: string) => toolId === HOST_PROGRESS_TOOL_ID : isNativeProbeTool;
    return outcome(cleanTurn && hasCorrelatedToolProgress(collected.events, matchesTool), {
      reason: "tool_progress_lifecycle_not_observed",
    });
  }

  if (input.capability === "approval.request") {
    if (!cleanTurn) {
      return outcome(false, {
        markerMatched,
        cleanTurn,
        events: input.events,
        timedOut: collected.timedOut,
        error: collected.error ?? firstErrorMessage(collected.events),
      });
    }
    return outcome(
      input.events.approvalRequested &&
        input.events.approvalResolved &&
        input.events.toolFinished &&
        input.events.turnFinished &&
        markerMatched,
      { reason: "approval_same_loop_continuation_not_observed" },
    );
  }

  if (input.capability === "control.stop") {
    if (
      collected.aborted &&
      !collected.timedOut &&
      !collected.error &&
      collected.durationMs < STOP_TIMEOUT_MS &&
      !markerMatched &&
      turnContract.lifecycleClosedExactlyOnce
    ) {
      return { passed: true };
    }
    if (!collected.aborted) {
      const preview = responsePreview(collected.events);
      return {
        passed: false,
        reason: preview ? `turn_finished_before_abort: ${preview}` : "turn_finished_before_abort",
      };
    }
    return { passed: false, reason: "cancellation_not_observed" };
  }

  if (input.capability === "control.steer") {
    return outcome(Boolean(input.events.steerAttempted && input.events.steerAccepted), {
      reason: input.events.steerError || "steer_not_accepted",
    });
  }

  if (input.capability === "session.compact") {
    return outcome(
      Boolean(input.events.compactionStarted || input.events.compactionFinished || input.events.compactAccepted),
      { reason: input.events.compactError || "missing_compaction_event" },
    );
  }

  if (input.capability === "session.goal") {
    return outcome(Boolean(input.events.goalConfigured), { reason: "missing_goal_configured_event" });
  }

  if (input.capability === "budget.limit") {
    return outcome(Boolean(input.events.budgetLimitConfigured), {
      reason: "budget_limit_not_observed_as_runtime_event",
    });
  }

  if (input.capability === "auth.refresh") {
    return outcome(Boolean(input.events.authRefreshRequested), { reason: "missing_auth_refresh_request" });
  }

  if (input.capability === "output.artifacts") {
    const artifactPath = input.result.case.artifactPath;
    const fileCreated = Boolean(
      artifactPath && existsSync(artifactPath) && readFileSync(artifactPath, "utf8").includes(input.result.case.marker),
    );
    return outcome(Boolean(fileCreated || input.events.artifactResult), { reason: "artifact_not_created_or_reported" });
  }

  if (input.capability === "media.input") {
    return outcome(cleanTurn && Boolean(input.events.mediaInputConfigured), {
      reason: input.events.mediaInputConfigured ? "media_turn_not_clean" : "media_input_item_not_observed",
    });
  }

  if (input.capability === "output.structured") {
    return outcome(
      cleanTurn &&
        Boolean(input.events.structuredOutputConfigured) &&
        structuredOutputContainsMarker(collected.events, input.result.case.marker),
      {
        reason: !input.events.structuredOutputConfigured
          ? "structured_output_schema_not_observed"
          : "structured_output_response_not_observed",
      },
    );
  }

  if (input.capability === "reasoning.nativeText") {
    if (!input.events.reasoningNativeText) {
      return { passed: false, reason: "missing_native_reasoning_text" };
    }
    return outcome(completedTerminalTurn, {
      markerMatched: terminalMarkerMatched,
      cleanTurn,
      events: input.events,
      timedOut: collected.timedOut,
      error: collected.error ?? firstErrorMessage(collected.events),
    });
  }

  if (input.capability === "reasoning.summary") {
    if (!input.events.reasoningSummary) {
      return { passed: false, reason: "missing_reasoning_summary" };
    }
    return outcome(completedTerminalTurn, {
      markerMatched: terminalMarkerMatched,
      cleanTurn,
      events: input.events,
      timedOut: collected.timedOut,
      error: collected.error ?? firstErrorMessage(collected.events),
    });
  }

  if (input.capability === "sandbox.policy") {
    return outcome(Boolean(input.events.sandboxPolicyConfigured), {
      reason: "sandbox_policy_not_observed_as_runtime_event",
    });
  }

  return { passed: false, reason: "no_evaluator_for_capability" };
}

function outcome(
  passed: boolean,
  failure: { reason?: string } | Parameters<typeof failureReason>[0],
): CapabilityOutcome {
  if (passed) return { passed: true };
  if ("events" in failure) {
    return { passed: false, reason: failureReason(failure) };
  }
  return { passed: false, reason: failure.reason ?? "probe_failed" };
}

function toContractEvidence(probe: KernelRuntimeProbeRecord, sourcePath: string): KernelContractTestEvidence[] {
  const mapping = findExpectedMapping(probe.kernel, probe.capability, probe.testId);
  if (!mapping || !CERTIFIABLE_MAPPING_STATUSES.has(mapping.status)) {
    return [];
  }
  return [
    {
      kernel: probe.kernel,
      capability: probe.capability,
      testId: probe.testId,
      passed: true,
      checkedAt: probe.checkedAt,
      ...(probe.hostVersion ? { hostVersion: probe.hostVersion } : {}),
      ...(probe.kernelVersion ? { kernelVersion: probe.kernelVersion } : {}),
      ...(probe.runtimeMode ? { runtimeMode: probe.runtimeMode } : {}),
      ...(providerSensitiveCapability(probe.capability) && probe.provider
        ? {
            provider: {
              kind: probe.provider.kind,
              ...(probe.provider.model ? { model: probe.provider.model } : {}),
            },
          }
        : {}),
      verification: "real_runtime",
      source: "Generated by kernel-capability-real-runtime-probe-runner",
      sourcePath,
    },
  ];
}

function findExpectedMapping(
  kernel: string,
  capability: KernelCapabilityId,
  testId: string,
): KernelContractMapping | undefined {
  const contract = KERNEL_CAPABILITY_CONTRACTS.find((item) => item.kernel === kernel);
  return contract?.mappings.find(
    (mapping) => mapping.capability === capability && mapping.expectedContractTest === testId,
  );
}

function skippedProbe(
  base: {
    kernel: BridgeKernelId;
    verification: "real_runtime";
    checkedAt: string;
    marker: string;
    provider: KernelRuntimeProbeRecord["provider"];
    command?: string;
  },
  capability: KernelCapabilityId,
  testId: string,
  reason: string,
): KernelRuntimeProbeRecord {
  return {
    id: testId,
    capability,
    testId,
    status: "skipped",
    ...base,
    reason,
  };
}

function failedProbe(
  base: {
    kernel: BridgeKernelId;
    verification: "real_runtime";
    checkedAt: string;
    marker: string;
    provider: KernelRuntimeProbeRecord["provider"];
    command?: string;
  },
  capability: KernelCapabilityId,
  testId: string,
  reason: string,
): KernelRuntimeProbeRecord {
  return {
    id: testId,
    capability,
    testId,
    status: "failed",
    ...base,
    reason,
  };
}

function summarizeEvents(
  events: AgentEvent[],
  steer?: CollectedTurn["steer"],
  compact?: CollectedTurn["compact"],
): KernelRuntimeProbeEventSummary {
  const turnContract = inspectAgentTurnEvents(events);
  const toolIds = events
    .filter(
      (event): event is Extract<AgentEvent, { type: "tool.started" | "tool.finished" }> =>
        event.type === "tool.started" || event.type === "tool.finished",
    )
    .map((event) => event.toolId);
  const diagnosticEvents = events.filter(
    (event): event is Extract<AgentEvent, { type: "runtime.diagnostic" }> => event.type === "runtime.diagnostic",
  );
  const budgetCompactionTriggered = diagnosticEvents.some(
    (event) => event.name === "context.budget.applied" && event.data.compactionTriggered === true,
  );
  const budgetCompactionSucceeded = diagnosticEvents.some(
    (event) => event.name === "context.budget.applied" && event.data.compactionSucceeded === true,
  );
  // Evidence records capability presence, not stream-event frequency. Hermes
  // can emit thousands of reasoning deltas in one turn, so keep this list
  // ordered but unique instead of bloating the checked-in ledger.
  const diagnosticNames = Array.from(new Set(diagnosticEvents.map((event) => event.name)));
  const codexServerRequestMethods = diagnosticEvents
    .filter((event) => event.name === "codex.app_server.request")
    .map((event) => (typeof event.data.method === "string" ? event.data.method : ""))
    .filter(Boolean);
  const policyDiagnostics = diagnosticEvents.filter((event) => event.name.endsWith(".policy.configured"));
  const budgetDiagnostic = diagnosticEvents.find((event) => event.name === "claude.budget.configured");
  const speedDiagnostic = policyDiagnostics.find(
    (event) => event.data.responseSpeed === "fast" || event.data.serviceTier === "fast",
  );
  const mediaDiagnostic = diagnosticEvents.find((event) => event.name.endsWith(".media_input.configured"));
  const structuredOutputDiagnostic = diagnosticEvents.find((event) => event.name === "codex.output_schema.configured");
  const goalDiagnostic = diagnosticEvents.find((event) => event.name === "codex.goal.configured");
  const sandboxPolicies = policyDiagnostics
    .map((event) =>
      typeof event.data.sandbox === "string"
        ? event.data.sandbox
        : typeof event.data.permissionMode === "string"
          ? event.data.permissionMode
          : "",
    )
    .filter(Boolean);
  const approvalPolicies = policyDiagnostics
    .map((event) =>
      typeof event.data.approvalPolicy === "string"
        ? event.data.approvalPolicy
        : typeof event.data.policySurface === "string"
          ? event.data.policySurface
          : "",
    )
    .filter(Boolean);
  const sessionTrace = events.some(
    (event) => event.type === "model.requested" && Boolean(event.request.session?.sessionId),
  );
  const modelUsage = events.some((event) => event.type === "model.response" && Boolean(event.response.usage));
  const usageDiagnostic =
    diagnosticNames.some((name) => /usage|cost|token/i.test(name)) ||
    diagnosticEvents.some(
      (event) => event.name === "context.budget.applied" && typeof event.data.contextUsedTokens === "number",
    );
  const reasoningDiagnostic = diagnosticNames.some((name) => /reason|thinking|thought/i.test(name));
  const reasoningNativeText = events.some(
    (event) =>
      event.type === "reasoning.completed" && event.reasoning.kind === "native" && Boolean(event.reasoning.text.trim()),
  );
  const reasoningSummary = events.some(
    (event) =>
      event.type === "reasoning.completed" &&
      event.reasoning.kind === "summary" &&
      Boolean(event.reasoning.text.trim()),
  );
  const nativeToolStarted = events.some((event) => event.type === "tool.started" && isNativeProbeTool(event.toolId));
  const nativeToolFinished = events.some((event) => event.type === "tool.finished" && isNativeProbeTool(event.toolId));
  const artifactResult = events.some(
    (event) =>
      event.type === "tool.finished" &&
      isJsonObject(event.result.value) &&
      typeof event.result.value.artifactId === "string",
  );

  return {
    turnStarted: events.some((event) => event.type === "turn.started"),
    turnFinished: events.some((event) => event.type === "turn.finished"),
    turnStartedCount: turnContract.turnStartedCount,
    turnFinishedCount: turnContract.turnFinishedCount,
    assistantDelta: events.some((event) => event.type === "assistant.delta"),
    assistantDeltaCount: turnContract.assistantDeltaCount,
    modelResponse: events.some((event) => event.type === "model.response"),
    modelResponseCount: turnContract.modelResponseCount,
    lifecycleClosedExactlyOnce: turnContract.lifecycleClosedExactlyOnce,
    assistantDeltaBeforeResponse: turnContract.assistantDeltaBeforeResponse,
    modelResponseBeforeTurnFinished: turnContract.modelResponseBeforeTurnFinished,
    assistantTextMatchesResponse: turnContract.assistantTextMatchesResponse,
    assistantTextLength: turnContract.assistantText.length,
    responseTextLength: turnContract.responseText.length,
    assistantTextTrimmedMatchesResponse: turnContract.assistantText.trimEnd() === turnContract.responseText.trimEnd(),
    assistantTextCommonPrefixLength: commonPrefixLength(turnContract.assistantText, turnContract.responseText),
    planningUpdated: events.some((event) => event.type === "planning.updated"),
    questionRequested: events.some((event) => event.type === "question.requested"),
    questionAnswered: events.some((event) => event.type === "question.answered"),
    toolStarted: events.some((event) => event.type === "tool.started"),
    toolProgress: events.some((event) => event.type === "tool.progress"),
    toolProgressCorrelated: hasCorrelatedToolProgress(events, () => true),
    toolFinished: events.some((event) => event.type === "tool.finished"),
    approvalRequested: events.some((event) => event.type === "approval.requested"),
    approvalResolved: events.some((event) => event.type === "approval.resolved"),
    error: events.some((event) => event.type === "error"),
    compactionStarted: budgetCompactionTriggered || events.some((event) => event.type === "compaction.started"),
    compactionFinished: budgetCompactionSucceeded || events.some((event) => event.type === "compaction.finished"),
    runtimeDiagnostic: diagnosticNames.length > 0,
    modelUsage,
    usageDiagnostic,
    reasoningDiagnostic,
    reasoningNativeText,
    reasoningSummary,
    sessionTrace,
    nativeToolStarted,
    nativeToolFinished,
    artifactResult,
    authRefreshRequested:
      codexServerRequestMethods.includes("account/chatgptAuthTokens/refresh") ||
      diagnosticNames.includes("codex.auth.refresh"),
    sandboxPolicyConfigured: Boolean(policyDiagnostics.length && sandboxPolicies.length),
    budgetLimitConfigured: Boolean(budgetDiagnostic && typeof budgetDiagnostic.data.maxBudgetUsd === "number"),
    budgetLimitUsd:
      typeof budgetDiagnostic?.data.maxBudgetUsd === "number" ? budgetDiagnostic.data.maxBudgetUsd : undefined,
    responseSpeedConfigured: Boolean(
      speedDiagnostic && speedDiagnostic.data.responseSpeed === "fast" && speedDiagnostic.data.serviceTier === "fast",
    ),
    responseSpeed:
      typeof speedDiagnostic?.data.responseSpeed === "string" ? speedDiagnostic.data.responseSpeed : undefined,
    serviceTier: typeof speedDiagnostic?.data.serviceTier === "string" ? speedDiagnostic.data.serviceTier : undefined,
    mediaInputConfigured: Boolean(
      mediaDiagnostic && typeof mediaDiagnostic.data.imageInputs === "number" && mediaDiagnostic.data.imageInputs > 0,
    ),
    imageInputCount:
      typeof mediaDiagnostic?.data.imageInputs === "number" ? mediaDiagnostic.data.imageInputs : undefined,
    mentionInputCount:
      typeof mediaDiagnostic?.data.mentionInputs === "number" ? mediaDiagnostic.data.mentionInputs : undefined,
    structuredOutputConfigured: Boolean(structuredOutputDiagnostic),
    goalConfigured: Boolean(goalDiagnostic),
    goalStatus: typeof goalDiagnostic?.data.status === "string" ? goalDiagnostic.data.status : undefined,
    steerAttempted: steer?.attempted,
    steerAccepted: steer ? steer.ok && steer.guided : undefined,
    steerError: steer?.error,
    compactAttempted: compact?.attempted,
    compactAccepted: compact ? compact.ok && compact.compacted : undefined,
    compactError: compact?.error,
    toolIds,
    diagnosticNames,
    codexServerRequestMethods,
    sandboxPolicies,
    approvalPolicies,
  };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function isNativeProbeTool(toolId: string): boolean {
  if (
    toolId === HOST_ECHO_TOOL_ID ||
    toolId === HOST_APPROVAL_TOOL_ID ||
    toolId === HOST_DELAY_A_TOOL_ID ||
    toolId === HOST_DELAY_B_TOOL_ID ||
    toolId === HOST_STOP_TOOL_ID ||
    toolId === HOST_PROGRESS_TOOL_ID
  ) {
    return false;
  }
  return true;
}

function parallelToolsOverlapped(events: AgentEvent[]): boolean {
  const startA = events.findIndex((event) => event.type === "tool.started" && event.toolId === HOST_DELAY_A_TOOL_ID);
  const startB = events.findIndex((event) => event.type === "tool.started" && event.toolId === HOST_DELAY_B_TOOL_ID);
  const firstFinish = events.findIndex(
    (event) =>
      event.type === "tool.finished" &&
      (event.toolId === HOST_DELAY_A_TOOL_ID || event.toolId === HOST_DELAY_B_TOOL_ID),
  );
  return startA >= 0 && startB >= 0 && firstFinish >= 0 && startA < firstFinish && startB < firstFinish;
}

function textFromEvents(events: AgentEvent[]): string {
  return events
    .map((event) => {
      if (event.type === "assistant.delta") return event.text;
      if (event.type === "model.response") return event.response.text;
      if (event.type === "error") return event.message;
      return "";
    })
    .join("");
}

function structuredOutputContainsMarker(events: AgentEvent[], marker: string): boolean {
  const candidates = events
    .map((event) => {
      if (event.type === "assistant.delta") return event.text;
      if (event.type === "model.response") return event.response.text;
      return "";
    })
    .map((text) => text.trim())
    .filter(Boolean)
    .flatMap((text) => [
      text,
      text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim(),
    ]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!isJsonObject(parsed)) continue;
      if (parsed.ref === marker && parsed.ok === true) return true;
    } catch {
      // Keep checking other render forms.
    }
  }
  return false;
}

function responsePreview(events: AgentEvent[]): string {
  const final = [...events].reverse().find((event) => event.type === "assistant.final");
  const response = [...events].reverse().find((event) => event.type === "model.response");
  const text =
    final?.type === "assistant.final"
      ? final.text
      : response?.type === "model.response"
        ? response.response.text
        : events
            .filter((event) => event.type === "assistant.delta")
            .map((event) => (event.type === "assistant.delta" ? event.text : ""))
            .join("") ||
          firstErrorMessage(events) ||
          "";
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function firstErrorMessage(events: AgentEvent[]): string | undefined {
  const message = events.find(
    (event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error",
  )?.message;
  return message?.replace(/\s+/g, " ").trim() || undefined;
}

function failureReason(input: {
  markerMatched: boolean;
  cleanTurn: boolean;
  events: KernelRuntimeProbeEventSummary;
  timedOut: boolean;
  error?: string;
}): string {
  if (input.timedOut) return "probe_timeout";
  if (input.error) return input.error;
  if (input.events.error) return "runtime_emitted_error";
  if ((input.events.turnStartedCount ?? 0) !== 1) return "turn_started_not_exactly_once";
  if ((input.events.turnFinishedCount ?? 0) !== 1) return "turn_finished_not_exactly_once";
  if (!input.events.turnStarted) return "missing_turn_started";
  if (!input.events.turnFinished) return "missing_turn_finished";
  if (!input.events.assistantDelta) return "missing_assistant_delta";
  if (!input.events.modelResponse) return "missing_model_response";
  if ((input.events.modelResponseCount ?? 0) !== 1) return "model_response_not_exactly_once";
  if (!input.events.assistantDeltaBeforeResponse) return "assistant_delta_not_before_model_response";
  if (!input.events.modelResponseBeforeTurnFinished) return "model_response_not_before_turn_finished";
  if (!input.events.assistantTextMatchesResponse) return "assistant_stream_does_not_match_model_response";
  if (!input.markerMatched) return "reference_id_not_returned";
  if (!input.cleanTurn) return "unclean_turn";
  return "probe_failed";
}

function providerMetadata(resolution: AdapterResolution): KernelRuntimeProbeRecord["provider"] {
  return {
    kind: resolution.providerKind,
    ...(resolution.providerBaseUrl ? { baseUrl: resolution.providerBaseUrl } : {}),
    ...(resolution.providerModel ? { model: resolution.providerModel } : {}),
  };
}

function probeProvider(options: RunnerOptions): BridgeProviderProfile | undefined {
  if (options.anthropicBaseUrl && options.anthropicApiKey) {
    return {
      id: "real-runtime-anthropic-compatible",
      name: "Real runtime Anthropic-compatible probe provider",
      protocol: "anthropic-compatible",
      enabled: true,
      credentialKind: "api-key",
      anthropicBaseUrl: options.anthropicBaseUrl,
      apiKey: options.anthropicApiKey,
      models: options.model ? [{ id: options.model, label: options.model }] : [],
    };
  }
  if (!options.openAiBaseUrl || !options.openAiApiKey) return undefined;
  return {
    id: "real-runtime-openai-compatible",
    name: "Real runtime OpenAI-compatible probe provider",
    protocol: "openai-compatible",
    enabled: true,
    credentialKind: "api-key",
    openaiBaseUrl: options.openAiBaseUrl,
    apiKey: options.openAiApiKey,
    models: options.model ? [{ id: options.model, label: options.model }] : [],
  };
}

function isExternalProbeProvider(
  kind: AdapterResolution["providerKind"],
): kind is "openai-compatible" | "anthropic-compatible" {
  return kind === "openai-compatible" || kind === "anthropic-compatible";
}

function parseArgs(args: string[]): RunnerOptions {
  let outPath = resolve(process.cwd(), REAL_RUNTIME_EVIDENCE_PATH);
  let kernels: BridgeKernelId[] = [...BRIDGE_KERNEL_IDS];
  let capabilities: KernelCapabilityId[] = [...STANDARD_KERNEL_CAPABILITY_IDS];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let cwd = process.cwd();
  let mergeExisting = false;
  let openAiBaseUrl = process.env.OPENGROVE_REAL_RUNTIME_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL;
  let openAiApiKey =
    process.env.OPENGROVE_REAL_RUNTIME_OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  let anthropicBaseUrl = process.env.OPENGROVE_REAL_RUNTIME_ANTHROPIC_BASE_URL;
  let anthropicApiKey = process.env.OPENGROVE_REAL_RUNTIME_ANTHROPIC_API_KEY;
  let model =
    process.env.OPENGROVE_REAL_RUNTIME_OPENAI_MODEL ||
    process.env.OPENGROVE_REAL_RUNTIME_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.DEFAULT_MODEL;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--out" && value) {
      outPath = resolve(process.cwd(), value);
      index += 1;
    } else if (arg === "--kernels" && value) {
      kernels = value
        .split(",")
        .map((item) => item.trim())
        .filter(isBridgeKernelId);
      index += 1;
    } else if (arg === "--capabilities" && value) {
      capabilities = value
        .split(",")
        .map((item) => item.trim())
        .filter(isKernelCapabilityId);
      index += 1;
    } else if (arg === "--timeout-ms" && value) {
      timeoutMs = Number(value) || DEFAULT_TIMEOUT_MS;
      index += 1;
    } else if (arg === "--cwd" && value) {
      cwd = resolve(process.cwd(), value);
      mkdirSync(cwd, { recursive: true });
      index += 1;
    } else if (arg === "--openai-base-url" && value) {
      openAiBaseUrl = value;
      index += 1;
    } else if (arg === "--anthropic-base-url" && value) {
      anthropicBaseUrl = value;
      index += 1;
    } else if (arg === "--model" && value) {
      model = value;
      index += 1;
    } else if (arg === "--merge-existing") {
      mergeExisting = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}. Run with --help for usage.`);
    }
  }

  return {
    cwd,
    outPath,
    kernels,
    capabilities,
    timeoutMs,
    mergeExisting,
    ...(openAiBaseUrl ? { openAiBaseUrl } : {}),
    ...(openAiApiKey ? { openAiApiKey } : {}),
    ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(model ? { model } : {}),
  };
}

function printHelp(): void {
  console.log(
    [
      "Usage: node dist/tests/kernel-capability-real-runtime-probe-runner.js [options]",
      "",
      "Options:",
      "  --kernels <ids>              Comma-separated kernel ids.",
      "  --capabilities <ids>         Comma-separated capability ids.",
      "  --out <path>                 Evidence output path.",
      "  --cwd <path>                 Disposable probe working directory.",
      "  --timeout-ms <number>        Per-probe timeout.",
      "  --openai-base-url <url>      OpenAI-compatible provider base URL.",
      "  --anthropic-base-url <url>   Anthropic-compatible provider base URL.",
      "  --model <id>                 Provider model id.",
      "  --merge-existing             Replace only selected evidence records.",
      "  --help, -h                   Show this help without running probes.",
      "",
      "Provider credentials are read only from OPENGROVE_REAL_RUNTIME_OPENAI_API_KEY or",
      "OPENGROVE_REAL_RUNTIME_ANTHROPIC_API_KEY; API keys are intentionally not accepted as CLI flags.",
    ].join("\n"),
  );
}

function mergeRealRuntimeEvidence(
  options: RunnerOptions,
  next: KernelRealRuntimeEvidenceFile,
): KernelRealRuntimeEvidenceFile {
  if (!options.mergeExisting) return next;
  const existing = readRealRuntimeEvidenceFile(options.outPath);
  if (!existing) return next;
  const replacementKeys = new Set(next.probes.map((probe) => probeKey(probe.kernel, probe.capability)));
  return {
    schemaVersion: 1,
    generatedAt: next.generatedAt,
    source: "kernel-capability-real-runtime-probe-runner",
    probes: replaceEvidenceInPlace(existing.probes, next.probes, replacementKeys).map(redactProbeCommand),
    contractTests: replaceEvidenceInPlace(existing.contractTests, next.contractTests, replacementKeys),
  };
}

function redactProbeCommand(probe: KernelRuntimeProbeRecord): KernelRuntimeProbeRecord {
  const command = evidenceCommand(probe.command);
  return command === probe.command ? probe : { ...probe, ...(command ? { command } : { command: undefined }) };
}

function evidenceCommand(command: string | undefined): string | undefined {
  const normalized = command?.trim();
  if (!normalized || /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return normalized || undefined;
  const pathParts = normalized.replace(/\\/g, "/").split("/").filter(Boolean);
  return pathParts.length > 1 ? pathParts.at(-1) : normalized;
}

function replaceEvidenceInPlace<T extends { kernel: string; capability: KernelCapabilityId }>(
  existing: T[],
  replacements: T[],
  replacementKeys: Set<string>,
): T[] {
  const replacementByKey = new Map(replacements.map((item) => [probeKey(item.kernel, item.capability), item]));
  const existingKeys = new Set(existing.map((item) => probeKey(item.kernel, item.capability)));
  return [
    ...existing.flatMap((item) => {
      const key = probeKey(item.kernel, item.capability);
      if (!replacementKeys.has(key)) return [item];
      const replacement = replacementByKey.get(key);
      return replacement ? [replacement] : [];
    }),
    ...replacements.filter((item) => !existingKeys.has(probeKey(item.kernel, item.capability))),
  ];
}

function probeKey(kernel: string, capability: KernelCapabilityId): string {
  return `${kernel}.${capability}`;
}

function isBridgeKernelId(value: string): value is BridgeKernelId {
  return (BRIDGE_KERNEL_IDS as readonly string[]).includes(value);
}

function isKernelCapabilityId(value: string): value is KernelCapabilityId {
  return (STANDARD_KERNEL_CAPABILITY_IDS as readonly string[]).includes(value);
}

function checkedAt(iso: string): string {
  return iso.slice(0, 10);
}

function readHostVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readDependencyVersion(packageName: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    const version = parsed.dependencies?.[packageName];
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function providerSensitiveCapability(capability: KernelCapabilityId): boolean {
  return (
    capability === "diagnostics.usage" ||
    capability === "reasoning.nativeText" ||
    capability === "reasoning.summary" ||
    capability === "media.input" ||
    capability === "response.speed" ||
    capability === "budget.limit" ||
    capability === "output.structured" ||
    capability === "output.artifacts"
  );
}

function evidenceSourcePath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  return relativePath.startsWith("..") ? path : relativePath;
}

function createMarker(seed: string): string {
  const safeSeed = seed.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `OG_REAL_RUNTIME_${safeSeed}_${Date.now().toString(36).toUpperCase()}_${random}`;
}

function cleanupProbeCase(probeCase: ProbeCase): void {
  for (const path of probeCase.cleanupPaths ?? []) {
    try {
      if (existsSync(path)) {
        const isDir = lstatSync(path).isDirectory();
        rmSync(path, { recursive: isDir, force: true });
      }
      const parent = dirname(path);
      if (basename(parent) === ".opengrove-real-runtime-probes") {
        rmdirSync(parent);
      }
    } catch {
      // Best-effort cleanup only; evidence has already captured the probe result.
    }
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function printSummary(
  file: KernelRealRuntimeEvidenceFile,
  outPath: string,
  runProbes: KernelRuntimeProbeRecord[],
): void {
  const runPassed = runProbes.filter((probe) => probe.status === "passed").length;
  const runFailed = runProbes.filter((probe) => probe.status === "failed").length;
  const runSkipped = runProbes.filter((probe) => probe.status === "skipped").length;
  const passed = file.probes.filter((probe) => probe.status === "passed");
  const failed = file.probes.filter((probe) => probe.status === "failed");
  const skipped = file.probes.filter((probe) => probe.status === "skipped");
  console.log(`Real runtime evidence written: ${outPath}`);
  console.log(`Generated at: ${file.generatedAt}`);
  console.log(`Certified contract tests: ${file.contractTests.length}`);
  console.log(`This run selection: passed=${runPassed} failed=${runFailed} skipped=${runSkipped}`);
  console.log(`Cumulative ledger: passed=${passed.length} failed=${failed.length} skipped=${skipped.length}`);
  for (const probe of runProbes) {
    const reason = probe.reason ? ` (${probe.reason})` : "";
    console.log(`${probe.status.padEnd(7)} ${probe.testId}${reason}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
