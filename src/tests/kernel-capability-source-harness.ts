import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KERNEL_CAPABILITY_CONTRACTS } from "../kernel/capabilities/contracts.js";
import {
  CERTIFIED_KERNEL_CONTRACT_TESTS,
  SIMULATED_KERNEL_CONTRACT_TESTS,
} from "../kernel/capabilities/contract-test-evidence.js";
import { KERNEL_NATIVE_CAPABILITY_FACTS } from "../kernel/capabilities/native-facts.js";
import { buildKernelCapabilityReport } from "../kernel/capabilities/report.js";
import { STANDARD_KERNEL_CAPABILITY_IDS, type KernelContractMapping } from "../kernel/capabilities/types.js";
import { BRIDGE_KERNEL_IDS } from "../server/bridge-types.js";
import { getKernelContract } from "../server/kernel-registry.js";
import { createClaudeCodeKernelAdapter } from "../kernel/adapters/claude-code.js";
import { createCodexKernelAdapter } from "../kernel/adapters/codex.js";
import { createHermesKernelAdapter } from "../kernel/adapters/hermes.js";
import { createKimiKernelAdapter } from "../kernel/adapters/kimi.js";
import { createOpenClawGatewayKernelAdapter } from "../kernel/adapters/openclaw.js";
import { createOpenCodeKernelAdapter } from "../kernel/adapters/opencode.js";
import { createPiKernelAdapter } from "../kernel/adapters/pi.js";
import type { KernelAdapter } from "../kernel/types.js";

async function main() {
  assertNativeFactSources();
  assertContractShape();
  assertAdapterCapabilityDeclarationsMatchContracts();
  assertRealRuntimeProbeProviderWiring();
  assertKernelOwnershipBoundaries();
  assertGenericKernelBoundariesStayGeneric();
  assertCertifiedEvidenceIsRuntimeOnly();
  assertReportsStayConservativeWithoutRuntimeEvidence();
  console.log("✓ kernel capability native facts point at real local sources");
  console.log("✓ capability contracts are unique and use the standard vocabulary");
  console.log("✓ adapter capability declarations match their mapped capability contracts");
  console.log("✓ real-runtime probes pass external Provider bindings to every supported adapter");
  console.log("✓ every registered kernel declares the complete Host/Adapter/Kernel ownership boundary");
  console.log("✓ generic Kernel seams reject native-type and Host-trim leakage");
  console.log("✓ certified exposed evidence is restricted to real runtime probes");
}

function assertRealRuntimeProbeProviderWiring() {
  const probeRunner = readFileSync(
    join(process.cwd(), "src/tests/kernel-capability-real-runtime-probe-runner.ts"),
    "utf8",
  );
  const claudeBranch = probeRunner.match(/if \(kernel === "claude-code"\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.match(claudeBranch, /configuredModel,/);
  assert.match(claudeBranch, /env: providerEnv,/);
  assert.match(claudeBranch, /providerKind,/);
  assert.doesNotMatch(claudeBranch, /providerKind:\s*"native"/);
  const reasoningBranch =
    probeRunner.match(/if \(input\.capability === "reasoning\.nativeText"\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.match(reasoningBranch, /completedTerminalTurn/);
  assert.match(probeRunner, /requestedEffort:\s*"high"/);
  assert.doesNotMatch(probeRunner, /requestedEffort:\s*"xhigh"/);
  assert.match(probeRunner, /timedOut:\s*result\.collected\.timedOut/);
}

function assertAdapterCapabilityDeclarationsMatchContracts() {
  const adapters: KernelAdapter[] = [
    createCodexKernelAdapter({ command: "/bin/false" }),
    createClaudeCodeKernelAdapter({ cliPath: "/bin/false" }),
    createHermesKernelAdapter({ command: "/bin/false" }),
    createPiKernelAdapter(),
    createOpenClawGatewayKernelAdapter({ url: "ws://127.0.0.1:1" }),
    createOpenCodeKernelAdapter({ command: "/bin/false" }),
    createKimiKernelAdapter({ command: "/bin/false" }),
  ];
  const capabilityFields = [
    ["message.streamText", "streaming", ["mapped"]],
    ["tools.hostTool", "hostTools", ["mapped"]],
    ["approval.request", "approvals", ["mapped"]],
    ["interaction.askUser", "elicitation", ["mapped"]],
    ["output.artifacts", "artifacts", ["mapped", "fallback"]],
    ["session.compact", "compaction", ["mapped"]],
    ["auth.refresh", "authRefresh", ["mapped", "fallback"]],
    ["session.goal", "nativeThreadGoal", ["mapped"]],
  ] as const;

  for (const adapter of adapters) {
    const contract = KERNEL_CAPABILITY_CONTRACTS.find((entry) => entry.kernel === adapter.id);
    if (!contract) throw new Error(`${adapter.id} must have a capability contract`);
    for (const [capability, field, enabledStatuses] of capabilityFields) {
      const mapping: KernelContractMapping | undefined = contract.mappings.find(
        (entry) => entry.capability === capability,
      );
      assert.ok(mapping, `${adapter.id}.${capability} must be declared`);
      assert.equal(
        adapter.capabilities[field],
        new Set<string>(enabledStatuses).has(mapping.status),
        `${adapter.id}.${field} must match ${capability} mapping status`,
      );
    }
    const mapped = (capability: KernelContractMapping["capability"], statuses = ["mapped", "fallback"]): boolean => {
      const mapping = contract.mappings.find((entry) => entry.capability === capability);
      if (!mapping) throw new Error(`${adapter.id}.${capability} must be declared`);
      return statuses.includes(mapping.status);
    };
    assert.equal(
      adapter.capabilities.toolCalls,
      mapped("tools.hostTool") || mapped("tools.nativeTool"),
      `${adapter.id}.toolCalls must match an exposed Host or native tool lifecycle`,
    );
    assert.equal(
      adapter.capabilities.reasoning.nativeText !== "unsupported",
      mapped("reasoning.nativeText"),
      `${adapter.id}.reasoning.nativeText must match its capability mapping`,
    );
    assert.equal(
      adapter.capabilities.reasoning.summary !== "unsupported",
      mapped("reasoning.summary"),
      `${adapter.id}.reasoning.summary must match its capability mapping`,
    );
  }
}

function assertGenericKernelBoundariesStayGeneric() {
  const coreTypes = readFileSync(join(process.cwd(), "src/core/types.ts"), "utf8");
  const kernelTypes = readFileSync(join(process.cwd(), "src/kernel/types.ts"), "utf8");
  const contextBudget = readFileSync(join(process.cwd(), "src/runtime/context-token-budget.ts"), "utf8");
  const piRuntime = readFileSync(join(process.cwd(), "src/runtime/native-pi-session.ts"), "utf8");
  const appRuntime = readFileSync(join(process.cwd(), "src/app/create-opengrove.ts"), "utf8");
  const sessionHistoryMode = readFileSync(join(process.cwd(), "src/kernel/session-history-mode.ts"), "utf8");

  assert.doesNotMatch(coreTypes, /(?:codex|claude|pi|hermes|opencode|kimi|openclaw)\.native/);
  assert.doesNotMatch(kernelTypes, /codexWireApi|claude-family|opencode-provider/);
  assert.doesNotMatch(contextBudget, /host-trim|hard.?trim|truncate.*history/i);
  assert.doesNotMatch(piRuntime, /transformContext|retainedMessageLimit|host-trim/);
  assert.doesNotMatch(appRuntime, /Codex compaction/);
  assert.doesNotMatch(sessionHistoryMode, /["'](?:codex|claude(?:-code)?|pi|hermes|opencode|kimi|openclaw)["']/i);
  assert.match(kernelTypes, /sessionHistory:\s*"kernel"\s*\|\s*"host"/);
  assert.match(kernelTypes, /nativeText:\s*KernelReasoningSupport/);
  assert.match(kernelTypes, /summary:\s*KernelReasoningSupport/);
}

function assertKernelOwnershipBoundaries() {
  const required = [
    "session",
    "turn_lifecycle",
    "model_loop",
    "native_tool_execution",
    "host_tool_execution",
    "approval",
    "user_question",
    "skill_discovery",
    "skill_loading",
    "context_assembly",
    "knowledge_retrieval",
    "artifact_extraction",
    "memory_write",
    "compaction",
    "auth",
    "sandbox",
    "transport",
    "trajectory",
    "diagnostics",
  ] as const;
  for (const kernelId of BRIDGE_KERNEL_IDS) {
    const ownership = getKernelContract(kernelId).ownership;
    const features = new Set(ownership.map((rule) => rule.feature));
    const missing = required.filter((feature) => !features.has(feature));
    assert.deepEqual(missing, [], `${kernelId} ownership contract is incomplete`);
    assert.equal(features.size, ownership.length, `${kernelId} ownership contract contains duplicate features`);
  }
}

function assertNativeFactSources() {
  const seen = new Set<string>();
  const capabilityIds = new Set<string>(STANDARD_KERNEL_CAPABILITY_IDS);
  for (const fact of KERNEL_NATIVE_CAPABILITY_FACTS) {
    assert.equal(capabilityIds.has(fact.capability), true, `Unknown capability id: ${fact.capability}`);
    const key = `${fact.kernel}:${fact.capability}`;
    assert.equal(seen.has(key), false, `Duplicate native capability fact: ${key}`);
    seen.add(key);

    assert.ok(fact.evidence, `${key} must include evidence`);
    assert.equal(fact.evidence?.confidence, "verified", `${key} evidence must be verified`);
    assert.ok(fact.evidence?.kind, `${key} evidence must include kind`);
    assert.ok(fact.evidence?.sourcePath, `${key} evidence must include sourcePath`);
    const sourcePath = fact.evidence?.sourcePath ?? "";
    assert.equal(
      existsSync(join(process.cwd(), sourcePath)),
      true,
      `${key} evidence source does not exist: ${sourcePath}`,
    );
  }
}

function assertContractShape() {
  const capabilityIds = new Set<string>(STANDARD_KERNEL_CAPABILITY_IDS);
  const seenKernels = new Set<string>();
  for (const contract of KERNEL_CAPABILITY_CONTRACTS) {
    assert.equal(seenKernels.has(contract.kernel), false, `Duplicate capability contract: ${contract.kernel}`);
    seenKernels.add(contract.kernel);
    const seenMappings = new Set<string>();
    for (const mapping of contract.mappings) {
      assert.equal(
        capabilityIds.has(mapping.capability),
        true,
        `Unknown contract capability id: ${mapping.capability}`,
      );
      const key = `${contract.kernel}:${mapping.capability}`;
      assert.equal(seenMappings.has(mapping.capability), false, `Duplicate contract mapping: ${key}`);
      seenMappings.add(mapping.capability);
      assert.ok(mapping.from, `${key} must include a native/source description`);
      if (mapping.status === "mapped") {
        assert.ok(mapping.to, `${key} mapped entries must include an OpenGrove target`);
      }
    }
    const missing = STANDARD_KERNEL_CAPABILITY_IDS.filter((capability) => !seenMappings.has(capability));
    assert.deepEqual(
      missing,
      [],
      `${contract.kernel} contract must explicitly map or reject every standard capability`,
    );
  }
}

function assertCertifiedEvidenceIsRuntimeOnly() {
  for (const evidence of SIMULATED_KERNEL_CONTRACT_TESTS) {
    assert.equal(evidence.verification, "simulated", `${evidence.testId} must be marked simulated`);
  }
  for (const evidence of CERTIFIED_KERNEL_CONTRACT_TESTS) {
    assert.equal(evidence.verification, "real_runtime", `${evidence.testId} must be real_runtime`);
    assert.equal(evidence.passed, true, `${evidence.testId} certified evidence must pass`);
  }
}

function assertReportsStayConservativeWithoutRuntimeEvidence() {
  for (const contract of KERNEL_CAPABILITY_CONTRACTS) {
    const report = buildKernelCapabilityReport({
      kernel: contract.kernel,
      nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
      contracts: KERNEL_CAPABILITY_CONTRACTS,
      contractTests: SIMULATED_KERNEL_CONTRACT_TESTS,
      generatedAt: "2026-06-08T00:00:00.000Z",
    });
    assert.equal(report.capabilities.length, STANDARD_KERNEL_CAPABILITY_IDS.length);
    const wronglyExposed = report.capabilities.filter((entry) => entry.exposed === "yes");
    assert.deepEqual(
      wronglyExposed.map((entry) => entry.capability),
      [],
      `${contract.kernel} must not expose capabilities from simulated evidence`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
