import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-composer-gating-"));
const entryPath = join(tempDir, "composer-gating-entry.tsx");
const bundlePath = join(tempDir, "composer-gating-entry.cjs");
const require = createRequire(import.meta.url);

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    plugins: [cssStubPlugin()],
  });
  const mod = require(bundlePath);
  mod.runComposerCapabilityGatingHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function cssStubPlugin() {
  return {
    name: "css-stub",
    setup(buildApi) {
      buildApi.onResolve({ filter: /\.module\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-module-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-module-stub" }, () => ({
        contents: [
          "const styles = new Proxy({}, { get: (_target, key) => String(key) });",
          "export default styles;",
        ].join("\n"),
        loader: "js",
      }));
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path),
        namespace: "css-empty-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "css-empty-stub" }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  };
}

function entrySource() {
  const composerPath = resolve(projectRoot, "web/src/components/chat/chat-composer.tsx");
  const capabilityUiPath = resolve(projectRoot, "web/src/runtime/kernel-capability-ui.ts");
  const uiModelPath = resolve(projectRoot, "web/src/runtime/ui-model.ts");
  const i18nPath = resolve(projectRoot, "web/src/i18n.ts");
  return `
    import assert from "node:assert/strict";
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ChatComposer } from ${JSON.stringify(composerPath)};
    import { buildKernelCapabilityUiState } from ${JSON.stringify(capabilityUiPath)};
    import { buildConnectedToolsStatus, getKernelSlashCommands } from ${JSON.stringify(uiModelPath)};
    import { translateInLanguage } from ${JSON.stringify(i18nPath)};

    const t = (key, replacements) => translateInLanguage("en", key, replacements);

    const noop = () => {};
    const controls = {
      kernel: "codex",
      source: "harness",
      models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
      defaultModel: "gpt-5.4",
      reasoningEfforts: [{ id: "xhigh", label: t("composer.effortXHigh") }],
      defaultReasoningEffort: "xhigh",
      speedTiers: [{ id: "fast", label: t("composer.speedFast"), description: "1.5x speed" }],
      defaultSpeedTier: "fast",
    };

    function render(overrides = {}) {
      const props = {
        sending: false,
        contextText: "",
        attachments: [],
        contextArtifacts: [],
        composerSkillInvocation: null,
        composerQuestionValue: "",
        composerHeight: 144,
        model: "gpt-5.4",
        activeKernel: "codex",
        runtimeControls: controls,
        effort: "xhigh",
        responseSpeed: "fast",
        budgetLimitUsd: null,
        accessMode: "default",
        modelMenuKind: null,
        modelMenuPlacement: "up",
        planMode: true,
        goalMode: true,
        canShowPlanMode: false,
        canShowGoalMode: false,
        canShowReasoningControls: false,
        canShowSpeedControls: false,
        canShowBudgetControls: false,
        canGuideQueuedInstruction: false,
        queuedInstructions: [],
        composerInputRef: { current: null },
        fileInputRef: { current: null },
        modelMenuRef: { current: null },
        onPointerDown: noop,
        onClearContext: noop,
        onRemoveContextArtifact: noop,
        onRemoveAttachment: noop,
        onQuestionChange: noop,
        onKeyDown: noop,
        onPaste: noop,
        onCompositionStart: noop,
        onCompositionEnd: noop,
        onAttachmentInputChange: noop,
        onOpenAttachmentPicker: noop,
        onToggleModelMenu: noop,
        onTogglePlanMode: noop,
        onToggleGoalMode: noop,
        onGuideQueuedInstruction: noop,
        onRemoveQueuedInstruction: noop,
        onUpdateQueuedInstruction: noop,
        onMoveQueuedInstruction: noop,
        onSubmitQueuedInstructionNow: noop,
        onSetModel: noop,
        onSetEffort: noop,
        onSetResponseSpeed: noop,
        onSetBudgetLimitUsd: noop,
        onSetAccessMode: noop,
        onSubmitOrStop: noop,
        onRemoveSkillInvocation: noop,
        ...overrides,
      };
      return renderToStaticMarkup(React.createElement(ChatComposer, props));
    }

    function contains(html, text, label) {
      assert.ok(html.includes(text), label + " should include " + text);
    }

    function omits(html, text, label) {
      assert.equal(html.includes(text), false, label + " should not include " + text);
    }

    function capabilityReport(kernel, enabledCapabilities = []) {
      const enabled = new Set(enabledCapabilities);
      return {
        schemaVersion: 2,
        generatedAt: "2026-06-08T00:00:00.000Z",
        kernel,
        capabilities: [
          "planning.plan",
          "interaction.askUser",
          "tools.hostTool",
          "tools.nativeTool",
          "session.compact",
          "session.goal",
          "control.steer",
          "reasoning.summary",
          "budget.limit",
          "response.speed",
          "media.input",
        ].map((capability) => ({
          kernel,
          capability,
          native: "unknown",
          exposed: enabled.has(capability) ? "yes" : "unknown",
          productBehavior: enabled.has(capability) ? "enable" : "hide",
          contractTests: enabled.has(capability) ? [{ verification: "real_runtime", passed: true }] : [],
          notes: [],
        })),
      };
    }

    function commandNames(commands) {
      return commands.map((command) => command.name);
    }

    export function runComposerCapabilityGatingHarness() {
      const noCapabilityUi = buildKernelCapabilityUiState(capabilityReport("codex", []));
      assert.equal(noCapabilityUi.canShowPlanMode, false, "planning UI is hidden without enabled capability");
      assert.equal(noCapabilityUi.canShowGoalMode, false, "goal UI is hidden without enabled capability");
      assert.equal(noCapabilityUi.canShowReasoningControls, false, "reasoning UI is hidden without enabled capability");
      assert.equal(noCapabilityUi.canShowSpeedControls, false, "speed UI is not inferred from usage");
      assert.equal(noCapabilityUi.canShowBudgetControls, false, "budget UI is hidden without enabled capability");
      assert.equal(noCapabilityUi.canUseNativeMediaInput, false, "native media input is hidden without enabled capability");
      assert.equal(noCapabilityUi.canGuideActiveTurn, false, "guide UI is hidden without steer capability");

      const codexPlanningUi = buildKernelCapabilityUiState(capabilityReport("codex", ["planning.plan"]));
      assert.equal(codexPlanningUi.canShowPlanMode, true, "planning UI is shown with real-runtime planning evidence");
      assert.equal(codexPlanningUi.canShowGoalMode, false, "goal UI remains hidden even when planning is enabled");
      assert.equal(codexPlanningUi.canShowReasoningControls, false, "reasoning UI is not implied by planning");
      assert.equal(codexPlanningUi.canShowSpeedControls, false, "speed UI is not implied by planning");
      assert.equal(codexPlanningUi.canShowBudgetControls, false, "budget UI is not implied by planning");
      assert.equal(codexPlanningUi.canUseNativeMediaInput, false, "media input is not implied by planning");

      const codexGoalUi = buildKernelCapabilityUiState(capabilityReport("codex", ["session.goal"]));
      assert.equal(codexGoalUi.canShowGoalMode, true, "goal UI is shown with real-runtime native goal evidence");
      assert.equal(codexGoalUi.canShowPlanMode, false, "goal UI does not imply planning");

      const advancedUi = buildKernelCapabilityUiState(capabilityReport("codex", ["control.steer", "reasoning.summary", "budget.limit", "media.input"]));
      assert.equal(advancedUi.canGuideActiveTurn, true, "guide UI follows steer evidence");
      assert.equal(advancedUi.canShowReasoningControls, true, "reasoning UI follows reasoning evidence");
      assert.equal(advancedUi.canShowBudgetControls, true, "budget UI follows budget evidence");
      assert.equal(advancedUi.canUseNativeMediaInput, true, "native media input follows media evidence");
      assert.equal(advancedUi.canShowSpeedControls, false, "speed UI stays hidden until a separate speed capability exists");

      const addHidden = render({ modelMenuKind: "add", ...noCapabilityUi });
      omits(addHidden, t("composer.planMode"), "add menu with plan gate closed");
      omits(addHidden, t("composer.goalMode"), "add menu with goal gate closed");
      omits(addHidden, t("composer.disablePlanMode"), "active plan chip with plan gate closed");
      omits(addHidden, t("composer.disableGoalMode"), "active goal chip with goal gate closed");

      const addPlanVisible = render({ modelMenuKind: "add", ...codexPlanningUi });
      contains(addPlanVisible, t("composer.planMode"), "add menu with plan gate open");
      contains(addPlanVisible, t("composer.disablePlanMode"), "active plan chip with plan gate open");
      omits(addPlanVisible, t("composer.goalMode"), "goal remains hidden without goal gate");

      const addGoalVisible = render({ modelMenuKind: "add", canShowGoalMode: true });
      contains(addGoalVisible, t("composer.goalMode"), "add menu with goal gate open");
      contains(addGoalVisible, t("composer.disableGoalMode"), "active goal chip with goal gate open");

      const modelNoEffortControls = render({
        modelMenuKind: "model",
        runtimeControls: { ...controls, reasoningEfforts: [] },
      });
      omits(modelNoEffortControls, ">" + t("composer.intelligence") + "<", "model menu without advertised efforts");
      omits(modelNoEffortControls, t("composer.effortXHigh"), "model menu without advertised efforts");
      contains(modelNoEffortControls, 'aria-label="' + t("composer.model") + '"', "model-only picker label");

      const modelEffortVisible = render({ modelMenuKind: "model" });
      contains(modelEffortVisible, ">" + t("composer.intelligence") + "<", "model menu with advertised efforts");
      omits(modelEffortVisible, ">" + t("composer.speed") + "<", "model menu with speed gate closed");
      omits(modelEffortVisible, ">" + t("composer.budget") + "<", "model menu with budget gate closed");
      contains(modelEffortVisible, t("composer.effortXHigh"), "model menu with advertised efforts");
      omits(modelEffortVisible, t("composer.speedFast"), "model menu with speed gate closed");
      omits(modelEffortVisible, "$0.25", "model menu with budget gate closed");
      omits(modelEffortVisible, "data-speed=", "model button with speed gate closed");
      contains(modelEffortVisible, 'aria-label="' + t("composer.model") + " / " + t("composer.intelligence") + '"', "model and effort picker label");

      const modelVisible = render({
        modelMenuKind: "model",
        canShowReasoningControls: true,
        canShowSpeedControls: true,
        canShowBudgetControls: true,
        budgetLimitUsd: 0.25,
      });
      contains(modelVisible, ">" + t("composer.intelligence") + "<", "model menu with reasoning gate open");
      contains(modelVisible, ">" + t("composer.speed") + "<", "model menu with speed gate open");
      contains(modelVisible, ">" + t("composer.budget") + "<", "model menu with budget gate open");
      contains(modelVisible, t("composer.effortXHigh"), "model menu with reasoning gate open");
      contains(modelVisible, t("composer.speedFast"), "model menu with speed gate open");
      contains(modelVisible, "$0.25", "model menu with budget gate open");
      contains(modelVisible, t("composer.budgetHardLimitDescription"), "model menu with budget gate open");
      contains(modelVisible, 'data-speed="fast"', "model button with speed gate open");

      const queuedNoSteer = render({
        sending: true,
        queuedInstructions: [{ id: "q1", prompt: "继续看压缩能力", status: "queued" }],
        canGuideQueuedInstruction: false,
      });
      contains(queuedNoSteer, t("composer.guideUnavailable"), "queued instruction without steer gate");
      contains(queuedNoSteer, "disabled", "guide button without steer gate");

      assert.deepEqual(
        commandNames(getKernelSlashCommands("hermes", undefined, capabilityReport("hermes", []))).includes("compact"),
        false,
        "compact slash command should be hidden without session.compact evidence",
      );
      const toolsCommand = getKernelSlashCommands("hermes", undefined, capabilityReport("hermes", []))
        .find((command) => command.name === "tools");
      assert.equal(toolsCommand?.source, "opengrove", "tools status command is OpenGrove-owned, not a fake kernel command");
      const toolsStatus = buildConnectedToolsStatus("hermes", capabilityReport("hermes", ["tools.nativeTool"]), t);
      assert.match(toolsStatus, /Tool status · hermes/);
      assert.match(toolsStatus, /Kernel native tools: Available/);
      assert.match(toolsStatus, /Connected tool servers: Unknown|Connected tool servers: Not connected/);
      assert.equal(/exposed|probe|fallback/.test(toolsStatus), false, "tools status should avoid capability-ledger vocabulary");
      assert.equal(
        commandNames(getKernelSlashCommands("hermes", undefined, capabilityReport("hermes", ["session.compact"]))).includes("compact"),
        true,
        "compact slash command should be visible with session.compact evidence",
      );
      assert.equal(
        commandNames(getKernelSlashCommands("codex", undefined, capabilityReport("codex", ["session.compact"]))).includes("plan"),
        false,
        "Codex plan slash command should be hidden without planning.plan evidence",
      );
      assert.equal(
        commandNames(getKernelSlashCommands("codex", undefined, capabilityReport("codex", ["session.compact", "planning.plan"]))).includes("plan"),
        true,
        "Codex plan slash command should be visible with planning.plan evidence",
      );

    }
  `;
}
