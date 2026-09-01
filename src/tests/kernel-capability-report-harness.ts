import assert from "node:assert/strict";
import { KERNEL_CAPABILITY_CONTRACTS } from "../kernel/capabilities/contracts.js";
import {
  CERTIFIED_KERNEL_CONTRACT_TESTS,
  SIMULATED_KERNEL_CONTRACT_TESTS,
} from "../kernel/capabilities/contract-test-evidence.js";
import { KERNEL_NATIVE_CAPABILITY_FACTS } from "../kernel/capabilities/native-facts.js";
import { buildKernelCapabilityReport } from "../kernel/capabilities/report.js";
import { STANDARD_KERNEL_CAPABILITY_IDS } from "../kernel/capabilities/types.js";

async function main() {
  const noCertifiedEvidence: typeof CERTIFIED_KERNEL_CONTRACT_TESTS = [];

  assert.equal(CERTIFIED_KERNEL_CONTRACT_TESTS.length, 84);
  assert.deepEqual(
    Object.fromEntries(
      [...new Set(CERTIFIED_KERNEL_CONTRACT_TESTS.map((evidence) => evidence.kernel))]
        .sort()
        .map((kernel) => [
          kernel,
          CERTIFIED_KERNEL_CONTRACT_TESTS.filter((evidence) => evidence.kernel === kernel).length,
        ]),
    ),
    {
      "claude-code": 15,
      codex: 19,
      hermes: 10,
      kimi: 12,
      openclaw: 6,
      opencode: 12,
      pi: 10,
    },
  );

  const codexReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: noCertifiedEvidence,
    generatedAt: "2026-06-08T00:00:00.000Z",
  });
  assert.equal(codexReport.capabilities.length, STANDARD_KERNEL_CAPABILITY_IDS.length);
  assert.ok(codexReport.capabilities.some((entry) => entry.capability === "media.input"));
  assert.ok(codexReport.capabilities.some((entry) => entry.capability === "budget.limit"));

  const codexAskUser = codexReport.capabilities.find((entry) => entry.capability === "interaction.askUser");
  assert.equal(codexAskUser?.native, "yes");
  assert.equal(codexAskUser?.exposed, "unknown");
  assert.equal(codexAskUser?.productBehavior, "hide");
  assert.deepEqual(codexAskUser?.auditStatuses, ["needs_real_runtime_verification"]);

  const codexPlan = codexReport.capabilities.find((entry) => entry.capability === "planning.plan");
  assert.equal(codexPlan?.native, "yes");
  assert.equal(codexPlan?.exposed, "unknown");
  assert.deepEqual(codexPlan?.auditStatuses, ["needs_real_runtime_verification"]);

  const codexBudget = codexReport.capabilities.find((entry) => entry.capability === "budget.limit");
  assert.equal(codexBudget?.native, "unknown");
  assert.equal(codexBudget?.productBehavior, "hide");
  assert.equal(codexBudget?.auditStatus, "needs_native_verification");

  const simulatedCodexReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: SIMULATED_KERNEL_CONTRACT_TESTS,
    generatedAt: "2026-06-08T00:00:00.000Z",
  });
  const simulatedCodexAskUser = simulatedCodexReport.capabilities.find(
    (entry) => entry.capability === "interaction.askUser",
  );
  assert.equal(
    simulatedCodexAskUser?.contractTests.some((item) => item.verification === "simulated"),
    true,
  );
  assert.equal(simulatedCodexAskUser?.exposed, "unknown", "Simulated tests must not enable exposed=yes");

  const runtimeVerifiedCodexReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [
      {
        kernel: "codex",
        capability: "interaction.askUser",
        testId: "codex.interaction.askUser",
        passed: true,
        checkedAt: "2026-06-08",
        hostVersion: "0.6.5",
        kernelVersion: "1.2.3",
        runtimeMode: "app-server",
        verification: "real_runtime",
        source: "real runtime contract probe",
      },
    ],
    generatedAt: "2026-06-08T00:00:00.000Z",
  });
  const runtimeVerifiedCodexAskUser = runtimeVerifiedCodexReport.capabilities.find(
    (entry) => entry.capability === "interaction.askUser",
  );
  assert.equal(runtimeVerifiedCodexAskUser?.exposed, "unknown");
  assert.equal(
    runtimeVerifiedCodexAskUser?.productBehavior,
    "hide",
    "fully bound evidence must not enable a runtime when the current Kernel version and mode are unknown",
  );

  const versionBoundEvidence = {
    kernel: "codex",
    capability: "interaction.askUser" as const,
    testId: "codex.interaction.askUser",
    passed: true,
    checkedAt: "2026-08-31",
    hostVersion: "0.6.5",
    kernelVersion: "1.2.3",
    runtimeMode: "app-server",
    provider: { kind: "native" as const },
    verification: "real_runtime" as const,
  };
  const matchingBoundReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [versionBoundEvidence],
    generatedAt: "2026-08-31T00:00:00.000Z",
    evidenceContext: {
      hostVersion: "0.6.5",
      kernelVersion: "1.2.3",
      runtimeMode: "app-server",
      provider: { kind: "native" },
    },
  });
  assert.equal(
    matchingBoundReport.capabilities.find((entry) => entry.capability === "interaction.askUser")?.exposed,
    "yes",
  );
  const mismatchedBoundReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [versionBoundEvidence],
    generatedAt: "2026-08-31T00:00:00.000Z",
    evidenceContext: {
      hostVersion: "0.6.5",
      kernelVersion: "2.0.0",
      runtimeMode: "app-server",
      provider: { kind: "native" },
    },
  });
  assert.equal(
    mismatchedBoundReport.capabilities.find((entry) => entry.capability === "interaction.askUser")?.exposed,
    "unknown",
    "evidence from another Kernel version must not enable the current runtime",
  );
  const partiallyKnownRuntimeReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [versionBoundEvidence],
    generatedAt: "2026-08-31T00:00:00.000Z",
    evidenceContext: { hostVersion: "0.6.5" },
  });
  assert.equal(
    partiallyKnownRuntimeReport.capabilities.find((entry) => entry.capability === "interaction.askUser")?.exposed,
    "unknown",
    "missing current Kernel version or runtime mode must fail closed",
  );
  const historicalLegacyReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [
      {
        kernel: "codex",
        capability: "interaction.askUser",
        testId: "codex.interaction.askUser",
        passed: true,
        checkedAt: "2026-01-01",
        verification: "real_runtime",
      },
    ],
    generatedAt: "2026-08-31T00:00:00.000Z",
  });
  assert.equal(
    historicalLegacyReport.capabilities.find((entry) => entry.capability === "interaction.askUser")?.exposed,
    "unknown",
    "unbound evidence must not enable a current runtime",
  );
  const legacyMigrationEvidence = {
    kernel: "codex",
    capability: "interaction.askUser" as const,
    testId: "codex.interaction.askUser",
    passed: true,
    checkedAt: "2026-01-01",
    legacyHostVersion: "0.6.5",
    verification: "real_runtime" as const,
  };
  const legacyCurrentHostReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [legacyMigrationEvidence],
    evidenceContext: { hostVersion: "0.6.5" },
  });
  assert.equal(
    legacyCurrentHostReport.capabilities.find((entry) => entry.capability === "interaction.askUser")?.exposed,
    "yes",
  );
  const legacyNextHostReport = buildKernelCapabilityReport({
    kernel: "codex",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [legacyMigrationEvidence],
    evidenceContext: { hostVersion: "0.6.6" },
  });
  assert.equal(
    legacyNextHostReport.capabilities.find((entry) => entry.capability === "interaction.askUser")?.exposed,
    "unknown",
    "imported legacy evidence must fail closed on the next Host release until a bound receipt replaces it",
  );

  const claudeReportWithoutTests = buildKernelCapabilityReport({
    kernel: "claude-code",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: [],
    generatedAt: "2026-06-08T00:00:00.000Z",
  });
  const claudeAskUser = claudeReportWithoutTests.capabilities.find(
    (entry) => entry.capability === "interaction.askUser",
  );
  assert.equal(claudeAskUser?.native, "yes");
  assert.equal(claudeAskUser?.exposed, "unknown");
  assert.equal(claudeAskUser?.auditStatus, "needs_real_runtime_verification");

  const kimiReport = buildKernelCapabilityReport({
    kernel: "kimi",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: CERTIFIED_KERNEL_CONTRACT_TESTS,
    generatedAt: "2026-08-14T00:00:00.000Z",
    evidenceContext: { hostVersion: "0.6.5", kernelVersion: "0.36.1", runtimeMode: "acp" },
  });
  for (const capability of ["tools.hostTool", "tools.mcpServers"] as const) {
    const entry = kimiReport.capabilities.find((candidate) => candidate.capability === capability);
    assert.equal(entry?.native, "yes");
    assert.equal(entry?.exposed, "yes", `${capability} requires a passing Kimi real-runtime probe`);
  }

  const piReport = buildKernelCapabilityReport({
    kernel: "pi",
    nativeFacts: KERNEL_NATIVE_CAPABILITY_FACTS,
    contracts: KERNEL_CAPABILITY_CONTRACTS,
    contractTests: CERTIFIED_KERNEL_CONTRACT_TESTS,
    generatedAt: "2026-09-01T00:00:00.000Z",
    evidenceContext: { hostVersion: "0.6.6", kernelVersion: "0.83.0", runtimeMode: "sdk" },
  });
  const piNativeTools = piReport.capabilities.find((entry) => entry.capability === "tools.nativeTool");
  assert.equal(piNativeTools?.native, "yes");
  assert.equal(piNativeTools?.exposed, "yes", "Pi native tools require a fresh real-runtime certification");

  for (const evidence of CERTIFIED_KERNEL_CONTRACT_TESTS) {
    assert.equal(evidence.verification, "real_runtime");
    assert.equal(evidence.source, undefined, "Published certification data must omit raw probe source details");
    assert.equal(evidence.sourcePath, undefined, "Published certification data must omit local evidence paths");
    assert.ok(
      evidence.legacyHostVersion || (evidence.hostVersion && evidence.kernelVersion && evidence.runtimeMode),
      `${evidence.testId} must be either release-bound migration evidence or fully runtime-bound evidence`,
    );
    const contract = KERNEL_CAPABILITY_CONTRACTS.find((item) => item.kernel === evidence.kernel);
    const mapping = contract?.mappings.find(
      (item) => item.capability === evidence.capability && item.expectedContractTest === evidence.testId,
    );
    assert.ok(mapping, `${evidence.testId} must correspond to a declared kernel capability mapping`);
  }

  console.log("✓ kernel capability report requires real runtime contract evidence for exposed capabilities");
  console.log("✓ simulated contract evidence does not enable exposed capabilities");
  console.log("✓ unknown native facts hide dedicated UI and enter the audit backlog");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
