import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-composer-interactions-"));
const entryPath = join(tempDir, "composer-interactions-entry.tsx");
const bundlePath = join(tempDir, "composer-interactions-entry.js");
const htmlPath = join(tempDir, "index.html");
const require = createRequire(import.meta.url);

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
    plugins: [cssStubPlugin()],
  });
  await writeFile(
    htmlPath,
    [
      "<!doctype html>",
      "<html>",
      '<head><meta charset="utf-8"><title>OpenGrove composer interaction harness</title></head>',
      '<body><div id="root"></div><script src="./composer-interactions-entry.js"></script></body>',
      "</html>",
    ].join("\n"),
    "utf8",
  );
  await runBrowserHarness(htmlPath);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function runBrowserHarness(path) {
  const browser = await launchChromiumForHarness();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, locale: "zh-CN" });
    await page.goto(pathToFileURL(path).href);
    await page.waitForSelector("[data-harness-ready='true']");

    await page.evaluate(() =>
      window.renderComposerHarness({
        sending: false,
        canGuideQueuedInstruction: true,
        queuedInstructions: [
          { id: "q1", prompt: "先整理压缩能力", status: "queued" },
          { id: "q2", prompt: "再复核 UI", status: "queued" },
        ],
      }),
    );
    await page
      .getByLabel(/More follow-up instruction actions|更多后续指令操作/)
      .first()
      .click();
    await page.getByRole("menuitem", { name: /Edit|编辑/ }).click();
    const editInput = page.getByLabel(/Edit|编辑/);
    await editInput.fill("先整理 Hermes 压缩能力");
    await page.getByLabel(/Save|保存/).click();
    assert.deepEqual(await page.evaluate(() => window.__composerCalls.update), [["q1", "先整理 Hermes 压缩能力"]]);

    await page
      .getByLabel(/More follow-up instruction actions|更多后续指令操作/)
      .nth(1)
      .click();
    await page.getByRole("menuitem", { name: /Move up|上移/, disabled: false }).click();
    assert.deepEqual(await page.evaluate(() => window.__composerCalls.move), [["q2", "up"]]);

    await page
      .getByLabel(/More follow-up instruction actions|更多后续指令操作/)
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: /Send now|立即发送/ })
      .last()
      .click();
    assert.deepEqual(await page.evaluate(() => window.__composerCalls.submitNow), ["q1"]);

    await page
      .getByRole("button", { name: /Guide|引导/ })
      .first()
      .click();
    assert.deepEqual(await page.evaluate(() => window.__composerCalls.guide), ["q1"]);

    await page
      .getByLabel(/Remove this follow-up instruction|移除这条后续指令/)
      .first()
      .click();
    assert.deepEqual(await page.evaluate(() => window.__composerCalls.remove), ["q1"]);

    await page.evaluate(() => window.renderQuestionHarness());
    await assertVisibleText(page, "你想让我接下来围绕哪类事情继续?");
    await assertVisibleText(page, "1 of 2");
    await page.getByRole("button", { name: /代码任务/ }).click();
    await assertVisibleText(page, "2 of 2");
    assert.equal(await page.evaluate(() => window.__questionCalls.answer.length), 0);
    await assertVisibleText(page, "你希望我的回答风格更偏哪一种?");
    await assertVisibleText(page, "2 of 2");
    await page.getByRole("button", { name: /简洁直接/ }).click();
    const answerCall = await page.evaluate(() => window.__questionCalls.answer[0]);
    assert.equal(answerCall[0], "question_1");
    assert.equal(answerCall[1], "answer");
    assert.deepEqual(answerCall[2], {
      answers: {
        next: { answers: ["code_task"] },
        style: { answers: ["concise"] },
      },
    });

    await page.evaluate(() => window.renderTextQuestionHarness());
    await assertVisibleText(page, "补充一个验收说明");
    await page.getByPlaceholder(/Enter your answer|输入回答/).fill("必须真实跑通");
    await page.getByRole("button", { name: /Answer|回答/, exact: true }).click();
    const textAnswerCall = await page.evaluate(() => window.__questionCalls.answer[0]);
    assert.equal(textAnswerCall[0], "question_text");
    assert.equal(textAnswerCall[1], "answer");
    assert.deepEqual(textAnswerCall[2], {
      answers: {
        acceptance: { answers: ["必须真实跑通"] },
      },
    });

    await page.evaluate(() => window.renderMultiTextQuestionHarness());
    await assertVisibleText(page, "第一题自由文本");
    assert.equal(await page.getByRole("button", { name: /Answer|回答/, exact: true }).count(), 0);
    await page.getByPlaceholder(/Enter your answer|输入回答/).fill("第一个回答");
    await page.getByRole("button", { name: /Continue|继续/, exact: true }).click();
    await assertVisibleText(page, "第二题自由文本");
    const finalAnswerButton = page.getByRole("button", { name: /Answer|回答/, exact: true });
    assert.equal(await finalAnswerButton.isDisabled(), true, "final answer should wait for the current text answer");
    await page.getByPlaceholder(/Enter your answer|输入回答/).fill("第二个回答");
    await finalAnswerButton.click();
    const multiTextAnswerCall = await page.evaluate(() => window.__questionCalls.answer[0]);
    assert.equal(multiTextAnswerCall[0], "question_text_multi");
    assert.equal(multiTextAnswerCall[1], "answer");
    assert.deepEqual(multiTextAnswerCall[2], {
      answers: {
        first: { answers: ["第一个回答"] },
        second: { answers: ["第二个回答"] },
      },
    });

    await page.evaluate(() => window.renderArtifactHarness());
    await assertVisibleText(page, "report.png");
    assert.ok(await page.getByText(/Image|图片/, { exact: true }).count(), "artifact kind should be localized");
    await assertVisibleText(page, "生成的检查截图");

    await page.evaluate(() => window.renderSkillInvokeHarness("complete"));
    const skillToggle = page.getByRole("button", { name: /story-outline/ });
    assert.equal(
      await skillToggle.getAttribute("aria-expanded"),
      "false",
      "skill.invoke should be collapsed by default",
    );
    assert.equal(
      await page.getByText("SKILL_INVOKE_FULL_BODY_MARKER", { exact: false }).count(),
      0,
      "collapsed skill body should not be mounted",
    );
    assert.equal(
      await page.getByText("OpenGrove 工具", { exact: true }).count(),
      0,
      "host-tool source pill should not render",
    );
    await skillToggle.click();
    await assertVisibleText(page, "SKILL_INVOKE_FULL_BODY_MARKER");
    assert.equal(await skillToggle.getAttribute("aria-expanded"), "true", "skill.invoke should expand on click");
    assert.equal(
      await page.getByText("OpenGrove 工具", { exact: true }).count(),
      0,
      "expanded skill detail should not restore the source pill",
    );
    await skillToggle.click();
    assert.equal(
      await skillToggle.getAttribute("aria-expanded"),
      "false",
      "skill.invoke should collapse again on click",
    );
    await page.getByText("SKILL_INVOKE_FULL_BODY_MARKER", { exact: false }).waitFor({ state: "hidden" });
    const retainedSkillBody = page.locator(".og-disclosure--exploration .og-disclosure-panel-inner");
    const retainedSkillPanel = page.locator(".og-disclosure--exploration .og-disclosure-panel-motion");
    assert.equal(await retainedSkillBody.count(), 1, "visited disclosure content should stay mounted when collapsed");
    await page.waitForFunction(() => {
      const panel = document.querySelector(".og-disclosure--exploration .og-disclosure-panel-motion");
      return panel instanceof HTMLElement && getComputedStyle(panel).display === "none";
    });
    assert.equal(await retainedSkillPanel.getAttribute("aria-hidden"), "true");
    assert.equal(await retainedSkillPanel.getAttribute("inert"), "");
    assert.equal(
      await retainedSkillPanel.evaluate((element) => getComputedStyle(element).display),
      "none",
      "collapsed mounted content must stop background animations",
    );

    await page.evaluate(() => window.renderSkillInvokeHarness("running"));
    const runningSkillToggle = page.locator(".og-disclosure--exploration .og-disclosure-toggle").first();
    assert.equal(
      await runningSkillToggle.getAttribute("aria-expanded"),
      "false",
      "running skill.invoke should still stay collapsed by default",
    );
    assert.equal(await page.getByText("SKILL_INVOKE_FULL_BODY_MARKER", { exact: false }).count(), 0);

    await page.evaluate(() => window.renderSkillInvokeHarness("failed"));
    const failedSkillToggle = page.getByRole("button", { name: /story-outline/ });
    assert.equal(
      await failedSkillToggle.getAttribute("aria-expanded"),
      "true",
      "failed skill.invoke should open so the error is visible",
    );
    await assertVisibleText(page, "SKILL_INVOKE_FULL_BODY_MARKER");
    assert.equal(await page.getByText("OpenGrove 工具", { exact: true }).count(), 0);

    await page.evaluate(() => window.renderRoomComposerHarness());
    await page
      .getByRole("textbox", { name: /Send to 测试房间|发送给 测试房间/ })
      .dispatchEvent("paste", { bubbles: true });
    assert.equal(
      await page.evaluate(() => window.__roomComposerPasteCalls),
      1,
      "room composer paste should not bubble into a second handler",
    );
    await page.evaluate(() =>
      window.renderRoomComposerHarness({
        draft: "你好",
        canSend: true,
      }),
    );
    assert.equal(
      await page.getByRole("button", { name: /Send message|发送消息/ }).isDisabled(),
      false,
      "a sendable Room draft must not be disabled by target runtime availability",
    );

    await page.evaluate(() => window.renderRoomReplyComposerHarness());
    await assertVisibleText(page, "需要保留的回复上下文");
    await page.getByRole("button", { name: /Cancel reply|取消回复/ }).click();
    assert.equal(await page.locator(".room-composer-reply").count(), 0);
    assert.equal(await page.evaluate(() => window.__roomComposerCancelCalls), 1);

    await page.evaluate(() => window.renderRoomReplyComposerHarness());
    const replyComposerInput = page.getByRole("textbox", { name: /Send to 测试房间|发送给 测试房间/ });
    await replyComposerInput.focus();
    await replyComposerInput.press("Escape");
    assert.equal(await page.locator(".room-composer-reply").count(), 0);
    assert.equal(await page.evaluate(() => window.__roomComposerCancelCalls), 2);

    await page.evaluate(() => window.renderRoomMentionHarness());
    const mentionComposerInput = page.getByRole("textbox", { name: /Send to 测试房间|发送给 测试房间/ });
    await page.getByRole("option", { name: /故事架构师/ }).waitFor();
    assert.equal(
      await page.locator(".rooms-mention-option:not(.all) small").count(),
      0,
      "member mention suggestions should only show the member name",
    );
    await mentionComposerInput.click({ position: { x: 24, y: 12 } });
    assert.equal(
      await mentionComposerInput.getAttribute("aria-expanded"),
      "true",
      "placing the caret must not dismiss Room mention suggestions",
    );
    await page.getByRole("option", { name: /故事架构师/ }).waitFor();
    await page.mouse.click(1190, 810);
    await page.getByRole("option", { name: /故事架构师/ }).waitFor({ state: "detached" });
    assert.equal(await mentionComposerInput.inputValue(), "@故事");

    await page.evaluate(() => window.renderRoomMentionHarness());
    await mentionComposerInput.focus();
    await mentionComposerInput.press("Escape");
    await page.getByRole("option", { name: /故事架构师/ }).waitFor({ state: "detached" });
    assert.equal(
      await mentionComposerInput.inputValue(),
      "@故事",
      "Escape must dismiss mentions without clearing the draft",
    );

    const [appShellCss, composerCss, skillMenuCss] = await Promise.all([
      readFile(join(projectRoot, "web/src/app-shell.css"), "utf8"),
      readFile(join(projectRoot, "web/src/components/chat/chat-composer.module.css"), "utf8"),
      readFile(join(projectRoot, "web/src/components/chat/skill-command-menu.css"), "utf8"),
    ]);
    await page.addStyleTag({ content: [appShellCss, composerCss, skillMenuCss].join("\n") });
    await page.evaluate(() => window.renderSkillMenuHarness());
    const mainComposerInput = page.locator("textarea").first();
    await page.getByRole("option", { name: "测试命令" }).waitFor();
    const slashMenuLayout = await page.evaluate(() => {
      const composer = document.querySelector(".opengrove-composer");
      const menu = document.querySelector(".skill-menu");
      if (!(composer instanceof HTMLElement) || !(menu instanceof HTMLElement)) return null;
      return {
        composerWidth: composer.offsetWidth,
        menuWidth: menu.offsetWidth,
      };
    });
    assert.ok(slashMenuLayout, "slash menu and composer should both be measurable");
    assert.ok(
      Math.abs(slashMenuLayout.menuWidth - slashMenuLayout.composerWidth) < 1,
      `slash menu must match the composer width: ${slashMenuLayout.menuWidth} vs ${slashMenuLayout.composerWidth}`,
    );
    await mainComposerInput.click({ position: { x: 24, y: 16 } });
    assert.equal(
      await mainComposerInput.getAttribute("aria-expanded"),
      "true",
      "placing the caret must not dismiss slash suggestions",
    );
    await page.getByRole("option", { name: "测试命令" }).waitFor();
    await page.mouse.click(1190, 810);
    await page.getByRole("option", { name: "测试命令" }).waitFor({ state: "detached" });
    assert.equal(await mainComposerInput.inputValue(), "/test");

    await page.evaluate(() => window.renderSkillMenuHarness());
    await mainComposerInput.focus();
    await mainComposerInput.press("Escape");
    await page.getByRole("option", { name: "测试命令" }).waitFor({ state: "detached" });
    assert.equal(
      await mainComposerInput.inputValue(),
      "/test",
      "Escape must dismiss slash suggestions without clearing the draft",
    );

    assert.deepEqual(await page.evaluate(() => window.testMergeComposerAttachments()), [
      "existing-image",
      "different-image",
    ]);

    // Reasoning-effort picker must appear when the kernel advertises efforts, even though
    // readable reasoning summaries are gated off (canShowReasoningControls=false).
    await page.evaluate(() => window.renderRuntimeControlsHarness({ canShowReasoningControls: false }));
    await assertVisibleText(page, "超高");

    // Speed lightning bolt must only appear in fast mode, never on standard.
    await page.evaluate(() =>
      window.renderRuntimeControlsHarness({ canShowSpeedControls: true, responseSpeed: "standard" }),
    );
    assert.equal(await page.locator(".lucide-zap").count(), 0, "standard speed must not show the lightning bolt");
    await page.evaluate(() =>
      window.renderRuntimeControlsHarness({ canShowSpeedControls: true, responseSpeed: "fast" }),
    );
    assert.ok((await page.locator(".lucide-zap").count()) > 0, "fast speed must show the lightning bolt");

    // Claude advertises a "max" effort level (dynamic from supportedModels); the picker shows it.
    await page.evaluate(() =>
      window.renderRuntimeControlsHarness({
        runtimeControls: {
          kernel: "claude-code",
          source: "harness",
          models: [{ id: "claude-opus-4-8", label: "Opus 4.8" }],
          reasoningEfforts: [
            { id: "low", label: "低" },
            { id: "medium", label: "中" },
            { id: "high", label: "高" },
            { id: "xhigh", label: "超高" },
            { id: "max", label: "最大" },
          ],
          defaultReasoningEffort: "high",
          speedTiers: [],
        },
        activeKernel: "claude-code",
        canShowReasoningControls: false,
        modelMenuKind: "model",
      }),
    );
    await assertVisibleText(page, "最大");

    // Context-window ring renders only when usage is present.
    await page.evaluate(() => window.renderRuntimeControlsHarness({ contextUsage: { used: 123000, total: 258400 } }));
    assert.ok(
      (await page.locator(".opengrove-context-ring").count()) > 0,
      "context ring must render when usage is present",
    );
    await page.evaluate(() => window.renderRuntimeControlsHarness({ contextUsage: undefined }));
    assert.equal(
      await page.locator(".opengrove-context-ring").count(),
      0,
      "context ring must be hidden when no usage is present",
    );

    await page.evaluate(() =>
      window.renderComposerHarness({
        unavailableReason: "Claude Agent 未配置可用凭据，请登录 WW。",
      }),
    );
    assert.equal(
      await page.getByRole("button", { name: /Send|发送/ }).isDisabled(),
      true,
      "an unavailable Kernel must disable the send action",
    );
    assert.equal(await page.getByRole("textbox").isDisabled(), true, "an unavailable Kernel must disable prompt entry");
    await page.evaluate(() =>
      window.renderComposerHarness({
        unavailableReason: "Claude Agent 未配置可用凭据，请登录 WW。",
        queuedInstructions: [{ id: "queued-1", prompt: "queued prompt", status: "queued" }],
      }),
    );
    await page.getByRole("button", { name: /More follow-up instruction actions|更多后续指令操作/ }).click();
    assert.equal(
      await page.getByRole("menuitem", { name: /Send now|立即发送/ }).isDisabled(),
      true,
      "an unavailable Kernel must disable queued immediate submission",
    );
    await assertVisibleText(page, "Claude Agent 未配置可用凭据，请登录 WW。");

    await page.evaluate(() => window.renderChoiceFormHarness({ canSubmit: false }));
    const unavailableChoice = page.getByRole("button", { name: "Continue now" });
    assert.equal(
      await unavailableChoice.isDisabled(),
      true,
      "an unavailable Kernel must disable message-level direct submission",
    );
    await unavailableChoice.evaluate((button) => button.click());
    assert.deepEqual(
      await page.evaluate(() => window.__choiceFormCalls),
      { insert: [], submit: [] },
      "an unavailable message-level choice must not invoke any submission callback",
    );
    await page.evaluate(() => window.renderChoiceFormHarness({ canSubmit: true }));
    await page.getByRole("button", { name: "Continue now" }).click();
    assert.deepEqual(
      await page.evaluate(() => window.__choiceFormCalls),
      { insert: [], submit: ["Continue now"] },
      "an available message-level choice must keep direct submission working",
    );
  } finally {
    await browser.close();
  }
}

async function launchChromiumForHarness() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist") && !message.includes("Looks like Playwright")) {
      throw error;
    }
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

async function assertVisibleText(page, text) {
  const count = await page.getByText(text, { exact: false }).count();
  assert.ok(count > 0, `Expected visible text: ${text}`);
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
  const activityPath = resolve(projectRoot, "web/src/components/chat/message-activity.tsx");
  const roomComposerPath = resolve(projectRoot, "web/src/components/rooms/room-composer.tsx");
  const uiModelPath = resolve(projectRoot, "web/src/runtime/ui-model.ts");
  return `
    import React from "react";
    import { flushSync } from "react-dom";
    import { createRoot } from "react-dom/client";
    import { ChatComposer } from ${JSON.stringify(composerPath)};
    import { AssistantProcessBlock } from ${JSON.stringify(activityPath)};
    import { RoomComposer } from ${JSON.stringify(roomComposerPath)};
    import { mergeComposerAttachments } from ${JSON.stringify(uiModelPath)};

    const root = createRoot(document.getElementById("root"));
    const noop = () => {};
    const baseComposerProps = {
      sending: false,
      contextText: "",
      attachments: [],
      contextArtifacts: [],
      composerSkillInvocation: null,
      composerQuestionValue: "",
      composerHeight: 144,
      model: "gpt-5.4",
      activeKernel: "codex",
      runtimeControls: undefined,
      effort: "xhigh",
      responseSpeed: "standard",
      budgetLimitUsd: null,
      accessMode: "default",
      modelMenuKind: null,
      modelMenuPlacement: "up",
      planMode: false,
      goalMode: false,
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
      onSetModel: noop,
      onSetEffort: noop,
      onSetResponseSpeed: noop,
      onSetBudgetLimitUsd: noop,
      onSetAccessMode: noop,
      onSubmitOrStop: noop,
      onRemoveSkillInvocation: noop,
    };

    window.__composerCalls = {};
    window.__questionCalls = {};
    window.__choiceFormCalls = {};
    window.__roomComposerPasteCalls = 0;
    window.__roomComposerCancelCalls = 0;

    window.testMergeComposerAttachments = () => {
      const existingImage = {
        id: "existing-image",
        name: "image.png",
        kind: "image" as const,
        mimeType: "image/png",
        size: 3,
        dataUrl: "data:image/png;base64,AAA=",
        thumbnailUrl: "data:image/webp;base64,thumb",
      };
      const duplicateImage = { ...existingImage, id: "duplicate-image" };
      const differentImage = {
        ...existingImage,
        id: "different-image",
        dataUrl: "data:image/png;base64,BBB=",
      };
      return mergeComposerAttachments([existingImage], [duplicateImage, differentImage], 2).map((attachment) => attachment.id);
    };

    window.renderComposerHarness = (overrides = {}) => {
      window.__composerCalls = { guide: [], remove: [], update: [], move: [], submitNow: [] };
      flushSync(() => root.render(React.createElement(ChatComposer, {
        ...baseComposerProps,
        ...overrides,
        onGuideQueuedInstruction: (id) => window.__composerCalls.guide.push(id),
        onRemoveQueuedInstruction: (id) => window.__composerCalls.remove.push(id),
        onUpdateQueuedInstruction: (id, prompt) => window.__composerCalls.update.push([id, prompt]),
        onMoveQueuedInstruction: (id, direction) => window.__composerCalls.move.push([id, direction]),
        onSubmitQueuedInstructionNow: (id) => window.__composerCalls.submitNow.push(id),
      })));
    };

    const codexRuntimeControls = {
      kernel: "codex",
      source: "harness",
      models: [{ id: "gpt-5.4", label: "GPT-5.4" }],
      reasoningEfforts: [
        { id: "low", label: "低" },
        { id: "medium", label: "中" },
        { id: "high", label: "高" },
        { id: "xhigh", label: "超高" },
      ],
      defaultReasoningEffort: "medium",
      speedTiers: [{ id: "standard", label: "标准" }, { id: "fast", label: "快速" }],
      defaultSpeedTier: "standard",
    };

    window.renderRuntimeControlsHarness = (overrides = {}) => {
      flushSync(() => root.render(React.createElement(ChatComposer, {
        ...baseComposerProps,
        runtimeControls: codexRuntimeControls,
        modelMenuKind: "add",
        ...overrides,
      })));
    };

    const baseRoomComposerProps = {
      inputRef: { current: null },
      fileInputRef: { current: null },
      roomTitle: "测试房间",
      draft: "",
      attachments: [],
      canSend: false,
      mentionOpen: false,
      mentionOptions: [],
      activeMentionIndex: 0,
      onDraftChange: noop,
      onAttachmentInputChange: noop,
      onOpenAttachmentPicker: noop,
      onRemoveAttachment: noop,
      onCancelReply: noop,
      onPaste: noop,
      onKeyDown: noop,
      onCompositionStart: noop,
      onCompositionEnd: noop,
      onOpenMention: noop,
      onMentionOpenChange: noop,
      onSelectMention: noop,
      onHoverMention: noop,
      onSend: noop,
    };

    window.renderRoomComposerHarness = (overrides = {}) => {
      window.__roomComposerPasteCalls = 0;
      flushSync(() => root.render(React.createElement(RoomComposer, {
        ...baseRoomComposerProps,
        onPaste: () => {
          window.__roomComposerPasteCalls += 1;
        },
        ...overrides,
      })));
    };

    function RoomReplyComposerHarness() {
      const [replyPreview, setReplyPreview] = React.useState<{ senderName: string; text: string } | undefined>({
        senderName: "故事架构师",
        text: "需要保留的回复上下文",
      });
      return React.createElement(RoomComposer, {
        ...baseRoomComposerProps,
        canSend: true,
        replyPreview,
        onCancelReply: () => {
          window.__roomComposerCancelCalls += 1;
          setReplyPreview(undefined);
        },
      });
    }

    let roomReplyHarnessKey = 0;
    window.renderRoomReplyComposerHarness = () => {
      roomReplyHarnessKey += 1;
      flushSync(() => root.render(React.createElement(RoomReplyComposerHarness, {
        key: roomReplyHarnessKey,
      })));
    };

    let roomMentionHarnessKey = 0;
    function RoomMentionHarness() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(RoomComposer, {
        ...baseRoomComposerProps,
        draft: "@故事",
        canSend: true,
        mentionOpen: open,
        mentionOptions: [{
          id: "story-architect",
          kind: "member",
          label: "故事架构师",
          detail: "在线",
          member: {
            id: "story-architect",
            name: "故事架构师",
            role: "架构",
            status: "idle",
            color: "#7c3aed",
          },
        }],
        onMentionOpenChange: setOpen,
      });
    }
    window.renderRoomMentionHarness = () => {
      roomMentionHarnessKey += 1;
      flushSync(() => root.render(React.createElement(RoomMentionHarness, {
        key: roomMentionHarnessKey,
      })));
    };

    let skillMenuHarnessKey = 0;
    function SkillMenuHarness() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(ChatComposer, {
        ...baseComposerProps,
        composerQuestionValue: "/test",
        skillMenu: open
          ? React.createElement("button", { type: "button", role: "option" }, "测试命令")
          : null,
        onSkillMenuOpenChange: setOpen,
      });
    }
    window.renderSkillMenuHarness = () => {
      skillMenuHarnessKey += 1;
      flushSync(() => root.render(React.createElement(SkillMenuHarness, {
        key: skillMenuHarnessKey,
      })));
    };

    window.renderChoiceFormHarness = ({ canSubmit }) => {
      window.__choiceFormCalls = { insert: [], submit: [] };
      const choiceResult = {
        id: "part_choice_form_result",
        type: "tool",
        phase: "result",
        toolId: "choice.form",
        title: "Choose next action",
        input: {},
        status: "complete",
        result: {
          kind: "choice_form",
          title: "Choose next action",
          questions: [{
            id: "next",
            prompt: "What should happen next?",
            options: [{
              value: "continue",
              label: "Continue now",
              description: "Submit the choice immediately",
              action: "submit",
            }],
          }],
        },
        error: "",
        approvalId: "",
        approvalStatus: "",
        approvalReason: "",
        questionId: "",
        questionStatus: "",
        questionPrompt: "",
      };
      flushSync(() => root.render(React.createElement(AssistantProcessBlock, {
        key: "choice-form",
        entries: [{
          groupKey: "choice-form",
          item: { type: "tool", key: "choice-form", result: choiceResult },
        }],
        activeChoiceFormKey: "choice-form",
        onResolveApproval: noop,
        onResolveQuestion: noop,
        onInsertPrompt: (prompt) => window.__choiceFormCalls.insert.push(prompt),
        onSubmitPrompt: canSubmit
          ? (prompt) => window.__choiceFormCalls.submit.push(prompt)
          : undefined,
      })));
    };

    window.renderQuestionHarness = () => {
      window.__questionCalls = { answer: [], decline: [] };
      const questionPart = {
        id: "part_question_1",
        type: "tool",
        phase: "question",
        toolId: "question",
        title: "引导问题",
        input: {},
        status: "requires-action",
        result: undefined,
        error: "",
        approvalId: "",
        approvalStatus: "",
        approvalReason: "",
        approvalInput: undefined,
        questionId: "question_1",
        questionStatus: "pending",
        questionPrompt: "你想让我接下来围绕哪类事情继续?",
        questionInput: {
          questions: [
            {
              id: "next",
              title: "你想让我接下来围绕哪类事情继续?",
              options: [
                { value: "code_task", label: "代码任务 (Recommended)", description: "继续推进实现和验证" },
                { value: "product_idea", label: "产品想法", description: "先讨论方向" },
              ],
            },
            {
              id: "style",
              title: "你希望我的回答风格更偏哪一种?",
              options: [
                { value: "concise", label: "简洁直接 (Recommended)", description: "只说结论和动作" },
                { value: "detailed", label: "详细推理", description: "保留更多解释" },
              ],
            },
          ],
        },
      };
      flushSync(() => root.render(React.createElement(AssistantProcessBlock, {
        key: "question-choice",
        entries: [{ groupKey: "question", item: { type: "question", key: "question_1", part: questionPart } }],
        onResolveApproval: noop,
        onResolveQuestion: (id, action, response) => window.__questionCalls.answer.push([id, action, response]),
      })));
    };

    window.renderTextQuestionHarness = () => {
      window.__questionCalls = { answer: [], decline: [] };
      const questionPart = {
        id: "part_question_text",
        type: "tool",
        phase: "question",
        toolId: "question",
        title: "引导问题",
        input: {},
        status: "requires-action",
        result: undefined,
        error: "",
        approvalId: "",
        approvalStatus: "",
        approvalReason: "",
        approvalInput: undefined,
        questionId: "question_text",
        questionStatus: "pending",
        questionPrompt: "补充一个验收说明",
        questionInput: {
          questions: [
            {
              id: "acceptance",
              title: "补充一个验收说明",
            },
          ],
        },
      };
      flushSync(() => root.render(React.createElement(AssistantProcessBlock, {
        key: "question-text",
        entries: [{ groupKey: "question", item: { type: "question", key: "question_text", part: questionPart } }],
        onResolveApproval: noop,
        onResolveQuestion: (id, action, response) => window.__questionCalls.answer.push([id, action, response]),
      })));
    };

    window.renderMultiTextQuestionHarness = () => {
      window.__questionCalls = { answer: [], decline: [] };
      const questionPart = {
        id: "part_question_text_multi",
        type: "tool",
        phase: "question",
        toolId: "question",
        title: "引导问题",
        input: {},
        status: "requires-action",
        result: undefined,
        error: "",
        approvalId: "",
        approvalStatus: "",
        approvalReason: "",
        approvalInput: undefined,
        questionId: "question_text_multi",
        questionStatus: "pending",
        questionPrompt: "多题自由文本",
        questionInput: {
          questions: [
            {
              id: "first",
              title: "第一题自由文本",
            },
            {
              id: "second",
              title: "第二题自由文本",
            },
          ],
        },
      };
      flushSync(() => root.render(React.createElement(AssistantProcessBlock, {
        key: "question-text-multi",
        entries: [{ groupKey: "question", item: { type: "question", key: "question_text_multi", part: questionPart } }],
        onResolveApproval: noop,
        onResolveQuestion: (id, action, response) => window.__questionCalls.answer.push([id, action, response]),
      })));
    };

    window.renderArtifactHarness = () => {
      const artifactPart = {
        id: "part_artifact_result",
        type: "tool",
        phase: "result",
        toolId: "codex.output.artifact",
        title: "生成产物",
        input: {},
        status: "complete",
        result: {
          artifacts: [
            {
              id: "artifact_report_png",
              title: "report.png",
              type: "image",
              summary: "生成的检查截图",
              imageUri: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
            },
          ],
        },
        error: "",
        approvalId: "",
        approvalStatus: "",
        approvalReason: "",
        approvalInput: undefined,
        questionId: "",
        questionStatus: "",
        questionPrompt: "",
        questionInput: undefined,
      };
      flushSync(() => root.render(React.createElement(AssistantProcessBlock, {
        key: "artifact",
        entries: [{ groupKey: "artifact", item: { type: "tool", key: "artifact_result", result: artifactPart } }],
        onResolveApproval: noop,
        onResolveQuestion: noop,
      })));
    };

    window.renderSkillInvokeHarness = (status = "complete") => {
      const callPart = {
        id: "part_skill_invoke_call",
        type: "tool",
        phase: "call",
        toolId: "skill.invoke",
        title: "Invoke skill",
        input: { skill: "story-outline", args: "" },
        status,
        error: "",
        approvalId: "",
        approvalStatus: "",
        approvalReason: "",
        questionId: "",
        questionStatus: "",
        questionPrompt: "",
      };
      const resultPart = {
        ...callPart,
        id: "part_skill_invoke_result",
        phase: "result",
        status,
        error: status === "failed" ? "skill load failed" : "",
        result: {
          status: "loaded",
          skillId: "skill.story-outline",
          skillName: "story-outline",
          content: "SKILL_INVOKE_FULL_BODY_MARKER",
          contentPreview: "SKILL_INVOKE_FULL_BODY_MARKER",
          sourcePath: "/private/story-outline/SKILL.md",
        },
      };
      flushSync(() => root.render(React.createElement(AssistantProcessBlock, {
        key: "skill-invoke-" + status,
        entries: [{
          groupKey: "skill-invoke",
          item: { type: "tool", key: "skill-invoke", call: callPart, result: resultPart },
        }],
        renderMode: "embedded",
        detailMode: "full",
        unwrapEmbeddedList: true,
        unwrapSingleExploration: true,
        onResolveApproval: noop,
        onResolveQuestion: noop,
      })));
    };

    window.renderComposerHarness();
    document.body.dataset.harnessReady = "true";
  `;
}
