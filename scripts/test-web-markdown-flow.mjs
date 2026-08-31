import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-markdown-flow-"));
const entryPath = join(tempDir, "markdown-flow-entry.tsx");
const bundlePath = join(tempDir, "markdown-flow-entry.cjs");
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
  mod.runMarkdownFlowHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function cssStubPlugin() {
  return {
    name: "css-stub",
    setup(buildApi) {
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
  const markdownPreviewPath = resolve(projectRoot, "web/src/components/knowledge/markdown-preview.tsx");
  const flowPreviewPath = resolve(projectRoot, "web/src/components/shared/flow-preview.tsx");
  const standardFileCapabilitiesPath = resolve(projectRoot, "web/src/components/shared/standard-file-capabilities.ts");
  const chatMarkdownPath = resolve(projectRoot, "web/src/components/chat/message-markdown.tsx");
  return `
    import assert from "node:assert/strict";
    import React from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
    import { MarkdownPreview } from ${JSON.stringify(markdownPreviewPath)};
    import { FlowPreview } from ${JSON.stringify(flowPreviewPath)};
    import { resolveStandardFileCapability } from ${JSON.stringify(standardFileCapabilitiesPath)};
    import { ThreadTextBlock } from ${JSON.stringify(chatMarkdownPath)};

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function render(element) {
      return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: queryClient }, element));
    }

	    function contains(html, text, label) {
	      assert.ok(html.includes(text), label + " should include " + text + "\\n" + html);
	    }

	    function notContains(html, text, label) {
	      assert.equal(html.includes(text), false, label + " should not include " + text + "\\n" + html);
	    }

    export function runMarkdownFlowHarness() {
      const markdown = [
        "| 名称 | 状态 |",
        "| :--- | ---: |",
        "| [链接](https://example.com) | **好** |",
        "",
        "- [x] 完成 **粗体**",
        "- [ ] 待办",
        "  - 子项 \`code\`",
        "",
        "> 一级",
        "> > 二级",
        "",
        "---",
	        "",
	        "这里有 *斜体*、***粗斜体***、~~删除~~ 和 https://example.com/path。",
	        "普通标识 snake_case_name 和表达式 a*b*c 不应该触发斜体。",
	        "转义 \\\\*星号\\\\* 保持字面。",
	      ].join("\\n");
      const markdownHtml = render(React.createElement(MarkdownPreview, { text: markdown, format: "markdown" }));
      contains(markdownHtml, "markdown-table", "table");
      contains(markdownHtml, "markdown-task-item", "task item");
      contains(markdownHtml, "type=\\"checkbox\\"", "checkbox");
      contains(markdownHtml, "<strong>好</strong>", "table inline strong");
      contains(markdownHtml, "<code>code</code>", "nested list inline code");
      contains(markdownHtml, "<blockquote>", "blockquote");
      contains(markdownHtml, "markdown-hr", "horizontal rule");
      contains(markdownHtml, "<em>斜体</em>", "italic");
      contains(markdownHtml, "<strong><em>粗斜体</em></strong>", "strong italic");
	      contains(markdownHtml, "<del>删除</del>", "strikethrough");
	      contains(markdownHtml, "href=\\"https://example.com/path\\"", "auto link");
	      contains(markdownHtml, "snake_case_name", "snake case literal");
	      contains(markdownHtml, "a*b*c", "asterisk literal");
	      notContains(markdownHtml, "<em>case</em>", "snake case should not become emphasis");
	      notContains(markdownHtml, "a<em>b</em>c", "inline math-like expression should not become emphasis");
	      contains(markdownHtml, "*星号*", "escaped star");

      const flowText = [
        "---",
        "flow: v1",
        "title: SHZC-A01 异常处置",
        "status: waiting_user",
        "initiator: attribution-analyst",
        "updated: 2026-06-10T07:08+08:00",
        "steps:",
        "  - id: s1",
        "    title: 异常确认",
        "    owner: attribution-analyst",
        "    status: done",
        "    activityRunId: room_run_internal_1",
        "    messageId: msg_internal_1",
        "    roomId: app-room--demo-app--group--default",
        "    output: '{\\"memberId\\":\\"trader\\",\\"roomId\\":\\"app-room--demo-app--group--default\\",\\"text\\":\\"reports/day.md\\"}'",
        "  - id: s2",
        "    title: 用户确认",
        "    owner: user",
        "    status: waiting",
        "    blocking: true",
        "---",
        "",
        "| 决策 | 状态 |",
        "| --- | --- |",
        "| 降价缩量 | 待确认 |",
      ].join("\\n");
      const flowHtml = render(React.createElement(FlowPreview, { text: flowText }));
      contains(flowHtml, "flow-preview", "flow preview");
      contains(flowHtml, "SHZC-A01 异常处置", "flow title");
      contains(flowHtml, "Waiting for user", "blocking banner");
      contains(flowHtml, "Loading activity checklist...", "flow SSR activity placeholder");
      notContains(flowHtml, "reports/day.md", "flow output text hidden");
      notContains(flowHtml, "memberId", "flow raw JSON hidden");
      notContains(flowHtml, "room_run_", "flow internal run id hidden");
      notContains(flowHtml, "msg_", "flow internal message id hidden");
      notContains(flowHtml, "app-room--", "flow internal room id hidden");
      contains(flowHtml, "markdown-table", "flow body markdown table");

      const capability = resolveStandardFileCapability({ name: "case.flow.md", path: "runs/case.flow.md", mimeType: "text/markdown" }, "runs/case.flow.md");
      assert.equal(capability.preview.kind, "flow");
      assert.equal(capability.editor?.language, "markdown");

      // ===== chat renderer (ThreadTextBlock) — Phase 1 验收用例 #1-7,9 =====
      // 用例 #1: GFM table 渲染为真实 <table>,无裸 |---|
      const chatTableText = [
        "| 编号 | 文件 |",
        "| --- | --- |",
        "| 1 | report.md |",
      ].join("\\n");
      const chatTableHtml = render(React.createElement(ThreadTextBlock, { text: chatTableText, onOpenResource() {} }));
      contains(chatTableHtml, "thread-md-table", "chat table");
      contains(chatTableHtml, "<thead>", "chat table head");
      contains(chatTableHtml, "<td>", "chat table body cell");
      notContains(chatTableHtml, "| --- |", "chat table no bare separator");

      // 用例 #2-5,7: inline code 永不资源化(含路径/URL/命令/表格单元格)
      const chatInlineText = [
        "段落里有 \`foo.py\`、\`workspace/runs/report.md\`、\`https://example.com\` 和 \`npm run check\`。",
      ].join("\\n");
      const chatInlineHtml = render(React.createElement(ThreadTextBlock, { text: chatInlineText, onOpenResource() {} }));
      contains(chatInlineHtml, ">foo.py</code>", "chat inline code foo.py plain");
      contains(chatInlineHtml, ">workspace/runs/report.md</code>", "chat inline code path plain");
      contains(chatInlineHtml, ">https://example.com</code>", "chat inline code url plain");
      contains(chatInlineHtml, ">npm run check</code>", "chat inline code command plain");
      notContains(chatInlineHtml, "data-resource-reference", "chat inline code never resourceized");

      // 用例 #6: Markdown link 文件引用仍为资源链接
      const chatLinkText = "[计划](docs/plan.md#L8) 应当仍是资源链接。";
      const chatLinkHtml = render(React.createElement(ThreadTextBlock, { text: chatLinkText, onOpenResource() {} }));
      contains(chatLinkHtml, "data-resource-reference", "chat markdown link still resource");

      // 用例 #9: citation block 剥离
      const chatCitationHtml = render(React.createElement(ThreadTextBlock, {
        text: "前面<oai-mem-citation>x</oai-mem-citation>后面",
        onOpenResource() {},
      }));
      notContains(chatCitationHtml, "oai-mem-citation", "chat citation stripped");

      // ===== Phase 2: react-markdown GFM parity(blockquote/hr/emphasis/delete/fenced code)=====
      const chatParityText = [
        "> 这是一段引用",
        "",
        "这里有 *斜体* 和 ~~删除线~~ 以及 **粗体**。",
        "",
        "---",
        "",
        "\`\`\`ts",
        "const x: number = 1;",
        "\`\`\`",
      ].join("\\n");
      const chatParityHtml = render(React.createElement(ThreadTextBlock, { text: chatParityText, onOpenResource() {} }));
      contains(chatParityHtml, "<blockquote>", "chat blockquote");
      contains(chatParityHtml, "<em>斜体</em>", "chat emphasis");
      contains(chatParityHtml, "<del>删除线</del>", "chat strikethrough");
      contains(chatParityHtml, "<strong>粗体</strong>", "chat strong");
      contains(chatParityHtml, "<hr", "chat horizontal rule");
      contains(chatParityHtml, "thread-code-block", "chat fenced code block");
      contains(chatParityHtml, "thread-code-lang", "chat fenced code language label");
      notContains(chatParityHtml, "<pre><div", "chat fenced code no pre-wrapped div");
      notContains(chatParityHtml, "<pre><pre", "chat fenced code no nested pre");
      notContains(chatParityHtml, "<oai-mem-citation>", "chat parity no raw html leak");

      const chatImageBlockHtml = render(React.createElement(ThreadTextBlock, {
        text: "![图](/generated/a.png)",
        onPreviewImage() {},
        onSaveImageArtifact() {},
        onOpenResource() {},
      }));
      contains(chatImageBlockHtml, "thread-image-figure", "chat image keeps figure chrome");
      contains(chatImageBlockHtml, "thread-image-action-buttons", "chat image keeps actions");
      contains(chatImageBlockHtml, "Save to artifacts", "chat image shows save action when handler exists");
      notContains(chatImageBlockHtml, " download=", "chat image download is handled by button action");
      notContains(chatImageBlockHtml, "<p><figure", "chat image-only paragraph unwraps figure");
      notContains(chatImageBlockHtml, "</figure></p>", "chat image-only paragraph no figure in paragraph");

      const chatImageNoSaveHtml = render(React.createElement(ThreadTextBlock, {
        text: "![图](/generated/a.png)",
        onPreviewImage() {},
        onOpenResource() {},
      }));
      contains(chatImageNoSaveHtml, "thread-image-figure", "chat image renders without save handler");
      notContains(chatImageNoSaveHtml, "Save to artifacts", "chat image hides save action without handler");

      const chatMixedImageHtml = render(React.createElement(ThreadTextBlock, {
        text: "前面 ![图](/generated/a.png) 后面",
        onPreviewImage() {},
        onSaveImageArtifact() {},
        onOpenResource() {},
      }));
      contains(chatMixedImageHtml, "thread-image-figure", "chat mixed image keeps figure chrome");
      notContains(chatMixedImageHtml, "<p>前面 <figure", "chat mixed image splits paragraph before figure");

      globalThis.openGroveDesktop = { apiBase: "http://127.0.0.1:57314/api" };
      const chatDesktopImageHtml = render(React.createElement(ThreadTextBlock, {
        text: "![图](/generated/a.png)",
        onPreviewImage() {},
        onSaveImageArtifact() {},
        onOpenResource() {},
      }));
      contains(chatDesktopImageHtml, 'src="http://127.0.0.1:57314/generated/a.png"', "chat desktop image uses bridge static URL");
      delete globalThis.openGroveDesktop;

      // ===== Phase 3: resolver 路径边界校验(§14 问题 3 决策)=====
      // 合法相对路径 → 升级 resource
      const resolverValidHtml = render(React.createElement(ThreadTextBlock, {
        text: "[计划](docs/plan.md#L8) 是合法资源。",
        onOpenResource() {},
      }));
      contains(resolverValidHtml, "data-resource-reference", "resolver valid path upgrades");
      assert.ok(resolverValidHtml.includes("data-resource-line="), "resolver preserves line");

      // 工作区外绝对路径 → 只允许交给本机文件管理器定位
      const resolverAbsHtml = render(React.createElement(ThreadTextBlock, {
        text: "[系统](/etc/passwd) 只定位不读取。",
        onOpenResource() {},
      }));
      contains(resolverAbsHtml, "data-resource-reference", "resolver absolute path becomes resource");
      contains(resolverAbsHtml, 'data-resource-origin="local"', "resolver absolute path uses local origin");
      contains(resolverAbsHtml, 'data-resource-path="/etc/passwd"', "resolver absolute path preserved for reveal");

      const resolverWebRoutesHtml = render(React.createElement(ThreadTextBlock, {
        text: "[设置](/settings) [指南](/docs/getting-started) [首页](/)",
        onOpenResource() {},
      }));
      notContains(resolverWebRoutesHtml, "data-resource-reference", "root-relative web routes stay non-actionable");

      // 父级穿越 → 降级普通 link
      const resolverEscapeHtml = render(React.createElement(ThreadTextBlock, {
        text: "[逃逸](../../escape.md) 不应升级。",
        onOpenResource() {},
      }));
      notContains(resolverEscapeHtml, "data-resource-reference", "resolver parent traversal degrades");

      // 可信来源(generated) → 升级
      const resolverGenHtml = render(React.createElement(ThreadTextBlock, {
        text: "[图片](/generated/chart.png) 应升级。",
        onOpenResource() {},
      }));
      contains(resolverGenHtml, "data-resource-reference", "resolver generated origin upgrades");
      assert.ok(resolverGenHtml.includes("data-resource-origin="), "resolver generated origin label");

      const resolverSameDirHtml = render(React.createElement(ThreadTextBlock, {
        text: "[同级](./same.md) 应升级。",
        onOpenResource() {},
      }));
      contains(resolverSameDirHtml, "data-resource-reference", "resolver same-dir file upgrades");
      contains(resolverSameDirHtml, 'data-resource-path="./same.md"', "resolver same-dir path preserved");

      const resolverNonFileHtml = render(React.createElement(ThreadTextBlock, {
        text: [
          "[锚点](#section)",
          "[邮件](mailto:x@y.com)",
          "[裸词](abc)",
          "[危险](javascript:alert(1))",
          "[裸文件](report)",
        ].join(" "),
        onOpenResource() {},
      }));
      notContains(resolverNonFileHtml, "data-resource-reference", "resolver non-file links degrade");
      notContains(resolverNonFileHtml, 'data-resource-path="#section"', "resolver fragment not resource");
      notContains(resolverNonFileHtml, 'data-resource-path="mailto:x@y.com"', "resolver mailto not resource");
      notContains(resolverNonFileHtml, 'data-resource-path="abc"', "resolver bare word not resource");
      notContains(resolverNonFileHtml, 'data-resource-path="javascript:alert(1)"', "resolver javascript not resource");
      notContains(resolverNonFileHtml, 'data-resource-path="report"', "resolver bare file-ish word not resource");

      // actions 字段:升级的 resource 声明了可用动作(通过 ResourceLink 渲染即证明)
      // ResourceLink 渲染本身依赖 resource 有合法结构;此处验证降级路径不产生 resource。
    }
  `;
}
