import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-resource-references-"));
const entryPath = join(tempDir, "entry.mjs");
const bundlePath = join(tempDir, "bundle.mjs");
const markdownImport = join(projectRoot, "web", "src", "components", "chat", "message-markdown.tsx");
const activityImport = join(projectRoot, "web", "src", "components", "chat", "message-activity.tsx");
const resourceCardImport = join(projectRoot, "web", "src", "components", "chat", "resource-card.tsx");
const resourceMenuImport = join(projectRoot, "web", "src", "components", "chat", "resource-context-menu.tsx");
const resourceModelImport = join(projectRoot, "web", "src", "components", "chat", "resource-model.ts");
const resourceLocalActionsImport = join(projectRoot, "web", "src", "components", "chat", "resource-local-actions.ts");
const fileCapabilitiesImport = join(projectRoot, "web", "src", "components", "shared", "standard-file-capabilities.ts");

await writeFile(
  entryPath,
  `
  import assert from "node:assert/strict";
  import React from "react";
  import { renderToStaticMarkup } from "react-dom/server";
  import { ThreadTextBlock } from ${JSON.stringify(markdownImport)};
  import { AssistantProcessBlock, buildActivityItems } from ${JSON.stringify(activityImport)};
  import { ResourceCardFrame } from ${JSON.stringify(resourceCardImport)};
  import { clampMenuPosition, ResourceContextMenu } from ${JSON.stringify(resourceMenuImport)};
  import { artifactCardToResource, resolveMarkdownFileResource, resolveRoomMessageResourceContext } from ${JSON.stringify(resourceModelImport)};
  import { openLocalChatResource } from ${JSON.stringify(resourceLocalActionsImport)};
  import { resolveStandardFileCapability } from ${JSON.stringify(fileCapabilitiesImport)};

  const text = [
    "看这里 \`web/src/app.tsx:12\` 和 [web/src/app.tsx](web/src/app.tsx#L12)。",
    "也参考 [计划](docs/plan.md#L8),但不要把 [检查](npm run check) 当文件。",
    "<oai-mem-citation><citation_entries>MEMORY.md:1-2|note=[x]</citation_entries></oai-mem-citation>",
  ].join("\\n\\n");
  const html = renderToStaticMarkup(React.createElement(ThreadTextBlock, {
    text,
    onOpenResource() {},
  }));
  assert.equal((html.match(/data-resource-reference="true"/g) || []).length, 2);
  assert.match(html, /data-resource-origin="workspace"/);
  assert.match(html, /data-resource-path="web\\/src\\/app.tsx"/);
  assert.match(html, /data-resource-line="12"/);
  assert.doesNotMatch(html, /oai-mem-citation/);
  assert.doesNotMatch(html, /data-resource-reference="true"[^>]*>检查/);
  assert.ok(html.includes(">web/src/app.tsx:12</code>"), "inline code path renders as plain <code> text, not resource");

  const mountedAppMarkdownResource = resolveMarkdownFileResource({
    key: "status-link",
    label: "查看实时状态",
    href: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/sample-pipeline/workspace/novel-writer/batch-runs/production17/status.json",
    context: {
      origin: "mounted-app",
      appId: "sample-pipeline",
      workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/sample-pipeline/workspace/novel-writer",
    },
  });
  assert.ok(mountedAppMarkdownResource, "mounted app Markdown absolute workspace path should become a resource");
  assert.equal(mountedAppMarkdownResource.origin, "mounted-app");
  assert.equal(mountedAppMarkdownResource.appId, "sample-pipeline");
  assert.equal(mountedAppMarkdownResource.path, "novel-writer/batch-runs/production17/status.json");
  const mountedAppMarkdownHtml = renderToStaticMarkup(React.createElement(ThreadTextBlock, {
    text: "[查看实时状态](</tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/sample-pipeline/workspace/novel-writer/batch-runs/production17/status.json>)",
    onOpenResource() {},
    resourceContext: {
      origin: "mounted-app",
      appId: "sample-pipeline",
      workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/sample-pipeline/workspace/novel-writer",
    },
  }));
  assert.match(mountedAppMarkdownHtml, /data-resource-reference="true"/);
  assert.match(mountedAppMarkdownHtml, /data-resource-origin="mounted-app"/);
  assert.match(mountedAppMarkdownHtml, /data-resource-path="novel-writer\\/batch-runs\\/production17\\/status\\.json"/);

  const outsideMountedAppMarkdownResource = resolveMarkdownFileResource({
    key: "outside-link",
    label: "outside.txt",
    href: "/tmp/opengrove-fixture-home/private/outside.txt#L12",
    context: {
      origin: "mounted-app",
      appId: "sample-pipeline",
      workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/sample-pipeline/workspace/novel-writer",
    },
  });
  assert.ok(outsideMountedAppMarkdownResource, "absolute path outside the mounted App workspace should become a local reveal resource");
  assert.equal(outsideMountedAppMarkdownResource.origin, "local");
  assert.equal(outsideMountedAppMarkdownResource.path, "/tmp/opengrove-fixture-home/private/outside.txt");
  assert.equal(outsideMountedAppMarkdownResource.line, 12);
  assert.equal(outsideMountedAppMarkdownResource.subtitle, "line 12");
  assert.deepEqual(outsideMountedAppMarkdownResource.actions, ["reveal", "copy-path"]);
  const outsideMountedAppMarkdownHtml = renderToStaticMarkup(React.createElement(ThreadTextBlock, {
    text: "[outside.txt](</tmp/opengrove-fixture-home/private/outside.txt>)",
    onOpenResource() {},
    resourceContext: {
      origin: "mounted-app",
      appId: "sample-pipeline",
      workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/sample-pipeline/workspace/novel-writer",
    },
  }));
  assert.match(outsideMountedAppMarkdownHtml, /data-resource-reference="true"/);
  assert.match(outsideMountedAppMarkdownHtml, /data-resource-origin="local"/);
  assert.ok(outsideMountedAppMarkdownHtml.includes('data-resource-path="/tmp/opengrove-fixture-home/private/outside.txt"'));

  const systemAbsoluteResource = resolveMarkdownFileResource({
    key: "system-path",
    label: "passwd",
    href: "/etc/passwd",
  });
  assert.ok(systemAbsoluteResource, "absolute system paths remain reveal-only local resources");
  assert.equal(systemAbsoluteResource.origin, "local");
  assert.deepEqual(systemAbsoluteResource.actions, ["reveal", "copy-path"]);

  for (const href of ["/", "/settings", "/docs/getting-started"]) {
    assert.equal(resolveMarkdownFileResource({ key: href, label: href, href }), null, href + " stays a web route");
  }
  assert.equal(
    resolveMarkdownFileResource({ key: "/docs/guide.md", label: "guide.md", href: "/docs/guide.md" })?.origin,
    "local",
    "file-shaped absolute paths remain revealable even under a reserved web route prefix",
  );

  const workspaceResourceContext = resolveRoomMessageResourceContext({
    workspaceRoot: "/tmp/opengrove-fixture-home/projects/current",
  }, "/tmp/opengrove-fixture-home/projects/fallback");
  assert.deepEqual(workspaceResourceContext, {
    origin: "workspace",
    workspaceRoot: "/tmp/opengrove-fixture-home/projects/current",
  });
  const mountedAppFallbackContext = resolveRoomMessageResourceContext({
    appId: "story-seed",
  }, "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace");
  assert.deepEqual(mountedAppFallbackContext, {
    origin: "mounted-app",
    appId: "story-seed",
    workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace",
  });

  const cardHtml = renderToStaticMarkup(React.createElement(ResourceCardFrame, {
    resource: {
      id: "artifact-1",
      kind: "artifact",
      origin: "workspace",
      title: "CHAT_PARITY_CHECKLIST.md",
      path: "web/src/components/chat/CHAT_PARITY_CHECKLIST.md",
      source: "artifact",
    },
    onOpenResource() {},
  }, React.createElement("span", null, "CHAT_PARITY_CHECKLIST.md")));
  assert.match(cardHtml, /thread-resource-card/);
  assert.match(cardHtml, /data-resource-origin="workspace"/);
  assert.match(cardHtml, /data-resource-path="web\\/src\\/components\\/chat\\/CHAT_PARITY_CHECKLIST.md"/);
  assert.match(cardHtml, /aria-label="More"/);
  assert.doesNotMatch(cardHtml, /aria-label="Open"/);

  const mountedAppArtifact = artifactCardToResource({
    id: "story-seed-output-1",
    title: "01-灵感.md",
    kind: "产物",
    summary: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/三日之后/01-灵感.md",
    path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/三日之后/01-灵感.md",
    uri: "",
    imageUri: "",
  }, {
    origin: "mounted-app",
    appId: "story-seed",
    workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace",
  });
  assert.ok(mountedAppArtifact, "mounted app artifact should become a resource");
  assert.equal(mountedAppArtifact.origin, "mounted-app");
  assert.equal(mountedAppArtifact.appId, "story-seed");
  assert.equal(mountedAppArtifact.path, "projects/三日之后/01-灵感.md");
  assert.equal(mountedAppArtifact.subtitle, "projects/三日之后/01-灵感.md");
  const mountedAppCardHtml = renderToStaticMarkup(React.createElement(ResourceCardFrame, {
    resource: mountedAppArtifact,
    onOpenResource() {},
  }, React.createElement("span", null, mountedAppArtifact.title)));
  assert.match(mountedAppCardHtml, /data-resource-origin="mounted-app"/);
  assert.match(mountedAppCardHtml, /data-resource-path="projects\\/三日之后\\/01-灵感.md"/);
  assert.doesNotMatch(mountedAppCardHtml, /Application Support\\/OpenGrove\\/apps\\/story-seed\\/workspace/);
  const mountedAppArtifactMenuHtml = renderToStaticMarkup(React.createElement(ResourceContextMenu, {
    resource: mountedAppArtifact,
    position: { x: 0, y: 0 },
    onAction() {},
    onClose() {},
  }));
  assert.equal(
    (mountedAppArtifactMenuHtml.match(/role="menuitem"/g) || []).length,
    5,
    "mounted app artifact cards expose the Finder action through the default resource menu",
  );

  const employeeScopedMountedAppArtifact = artifactCardToResource({
    id: "short-drama-output-1",
    title: "成片复盘-101272-20260618.md",
    kind: "产物",
    summary: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/short-drama-studio/workspace/analyst/成片复盘-101272-20260618.md",
    path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/short-drama-studio/workspace/analyst/成片复盘-101272-20260618.md",
    uri: "",
    imageUri: "",
  }, {
    origin: "mounted-app",
    appId: "short-drama-studio",
    workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/short-drama-studio/workspace/analyst",
  });
  assert.ok(employeeScopedMountedAppArtifact, "employee-scoped mounted app artifact should become a resource");
  assert.equal(employeeScopedMountedAppArtifact.origin, "mounted-app");
  assert.equal(employeeScopedMountedAppArtifact.appId, "short-drama-studio");
  assert.equal(employeeScopedMountedAppArtifact.path, "analyst/成片复盘-101272-20260618.md");
  assert.equal(employeeScopedMountedAppArtifact.subtitle, "analyst/成片复盘-101272-20260618.md");

  const workflowCreateArtifact = artifactCardToResource({
    id: "workflow:know_8",
    title: "月食失物招领处四步创作流水线",
    kind: "工作流",
    summary: "4 个步骤 · 验收 workflow.create 知识库卡片",
    path: "",
    uri: "",
    imageUri: "",
    knowledgeId: "know_8",
  }, {
    origin: "mounted-app",
    appId: "story-seed",
    workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace",
  });
  assert.ok(workflowCreateArtifact, "workflow.create artifact should become a knowledge resource");
  assert.equal(workflowCreateArtifact.origin, "knowledge");
  assert.equal(workflowCreateArtifact.appId, undefined);
  assert.equal(workflowCreateArtifact.path, "know_8");
  assert.deepEqual(workflowCreateArtifact.actions, ["preview", "copy-contents"]);

  const editParts = [
    {
      id: "edit-call",
      type: "tool",
      phase: "call",
      toolId: "codex.fileChange",
      title: "codex.fileChange",
      status: "complete",
      input: {
        type: "fileChange",
        id: "call_edit",
        changes: [{
          path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/月食失物招领处/06-分集表.md",
          kind: { type: "add" },
          diff: "+新增\\n-旧行\\n",
        }],
      },
    },
    {
      id: "edit-result",
      type: "tool",
      phase: "result",
      toolId: "codex.fileChange",
      title: "codex.fileChange",
      status: "complete",
      result: {
        type: "fileChange",
        id: "call_edit",
        changes: [{
          path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/月食失物招领处/06-分集表.md",
          kind: { type: "add" },
          diff: "+新增\\n-旧行\\n",
        }],
      },
    },
  ];
  const editEntries = buildActivityItems(editParts).map((item) => ({ groupKey: "edit", item }));
  const editHtml = renderToStaticMarkup(React.createElement(AssistantProcessBlock, {
    entries: editEntries,
    renderMode: "embedded",
    onResolveApproval() {},
    onResolveQuestion() {},
    onOpenResource() {},
    resourceContext: {
      origin: "mounted-app",
      appId: "story-seed",
      workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace",
    },
  }));
  assert.match(editHtml, /data-resource-origin="mounted-app"/);
  assert.match(editHtml, /data-resource-path="projects\\/月食失物招领处\\/06-分集表\\.md"/);
  assert.match(editHtml, />06-分集表\\.md<\\/span>/);

  const multiEditParts = [
    {
      id: "multi-edit-call",
      type: "tool",
      phase: "call",
      toolId: "codex.fileChange",
      title: "codex.fileChange",
      status: "complete",
      input: {
        type: "fileChange",
        id: "call_multi_edit",
        changes: [
          {
            path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/月食失物招领处/03-评审.md",
            kind: { type: "add" },
            diff: "+评审\\n",
          },
          {
            path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/月食失物招领处/04-大纲终稿.md",
            kind: { type: "add" },
            diff: "+终稿\\n",
          },
        ],
      },
    },
    {
      id: "multi-edit-result",
      type: "tool",
      phase: "result",
      toolId: "codex.fileChange",
      title: "codex.fileChange",
      status: "complete",
      result: {
        type: "fileChange",
        id: "call_multi_edit",
        changes: [
          {
            path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/月食失物招领处/03-评审.md",
            kind: { type: "add" },
            diff: "+评审\\n",
          },
          {
            path: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace/projects/月食失物招领处/04-大纲终稿.md",
            kind: { type: "add" },
            diff: "+终稿\\n",
          },
        ],
      },
    },
  ];
  const multiEditEntries = buildActivityItems(multiEditParts).map((item) => ({ groupKey: "multi-edit", item }));
  const multiEditHtml = renderToStaticMarkup(React.createElement(AssistantProcessBlock, {
    entries: multiEditEntries,
    renderMode: "embedded",
    onResolveApproval() {},
    onResolveQuestion() {},
    onOpenResource() {},
    resourceContext: {
      origin: "mounted-app",
      appId: "story-seed",
      workspaceRoot: "/tmp/opengrove-fixture-home/Library/Application Support/OpenGrove/apps/story-seed/workspace",
    },
  }));
  assert.equal((multiEditHtml.match(/data-resource-origin="mounted-app"/g) || []).length, 2);
  assert.match(multiEditHtml, /data-resource-path="projects\\/月食失物招领处\\/03-评审\\.md"/);
  assert.match(multiEditHtml, /data-resource-path="projects\\/月食失物招领处\\/04-大纲终稿\\.md"/);
  assert.match(multiEditHtml, />03-评审\\.md<\\/span>/);
  assert.match(multiEditHtml, />04-大纲终稿\\.md<\\/span>/);

  const routineCapability = resolveStandardFileCapability({
    name: "月食失物招领处四步创作流水线.routine.md",
    path: "OpenGrove/routines/月食失物招领处四步创作流水线.routine.md",
    mimeType: "text/markdown; charset=utf-8",
    content: "---\\n{}\\n---\\n",
  }, "OpenGrove/routines/月食失物招领处四步创作流水线.routine.md");
  assert.equal(routineCapability.canPreview, true);
  assert.equal(routineCapability.preview.kind, "markdown");

  const fileBehaviorCases = [
    { name: "notes.md", mimeType: "text/markdown", kind: "markdown", preview: "markdown", canPreview: true },
    { name: "config.json", mimeType: "application/json", kind: "text", preview: "source", canPreview: true },
    { name: "page.html", mimeType: "text/html", kind: "text", preview: "source", canPreview: true },
    { name: "tool.js", mimeType: "text/javascript", kind: "text", preview: "source", canPreview: true },
    { name: "poster.png", mimeType: "image/png", kind: "image", preview: "image", canPreview: true },
    { name: "poster.svg", mimeType: "image/svg+xml", kind: "image", preview: "image", canPreview: true },
    { name: "clip.mp4", mimeType: "video/mp4", kind: "video", preview: "video", canPreview: true },
    { name: "voice.mp3", mimeType: "audio/mpeg", kind: "audio", preview: "audio", canPreview: true },
    { name: "report.pdf", mimeType: "application/pdf", kind: "pdf", preview: "pdf", canPreview: true },
    { name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document", preview: "unsupported", canPreview: false },
    { name: "budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "spreadsheet", preview: "unsupported", canPreview: false },
    { name: "slides.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "presentation", preview: "unsupported", canPreview: false },
    { name: "office-payload", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "binary", preview: "unsupported", canPreview: false },
    { name: "bundle.zip", mimeType: "application/zip", kind: "archive", preview: "unsupported", canPreview: false },
  ];
  for (const expected of fileBehaviorCases) {
    const capability = resolveStandardFileCapability({
      name: expected.name,
      path: expected.name,
      mimeType: expected.mimeType,
    }, expected.name);
    assert.equal(capability.kind, expected.kind, expected.name + " kind");
    assert.equal(capability.preview.kind, expected.preview, expected.name + " preview");
    assert.equal(capability.canPreview, expected.canPreview, expected.name + " canPreview");
  }

  globalThis.window = { innerWidth: 320, innerHeight: 240 };
  assert.deepEqual(clampMenuPosition({ x: 310, y: 230 }, 178, 132), { x: 134, y: 100 });
  assert.deepEqual(clampMenuPosition({ x: -40, y: -20 }, 178, 132), { x: 8, y: 8 });
  delete globalThis.window;

  const calls = [];
  const dependencies = {
    postJson: async (url, body) => calls.push({ kind: "post", url, body }),
    openMountedAppLocalFile: async (appId, body) => calls.push({ kind: "mounted-app", appId, body }),
  };
  assert.equal(await openLocalChatResource(mountedAppMarkdownResource, "system", dependencies), true);
  assert.equal(await openLocalChatResource(mountedAppMarkdownResource, "finder", dependencies), true);

  const workspaceResource = {
    id: "workspace:test.md",
    kind: "file",
    origin: "workspace",
    title: "test.md",
    path: "docs/test.md",
    source: "artifact",
  };
  assert.equal(await openLocalChatResource(workspaceResource, "system", dependencies), true);
  assert.equal(await openLocalChatResource(workspaceResource, "finder", dependencies), true);

  const localResource = {
    id: "local:/tmp/test.md",
    kind: "file",
    origin: "local",
    title: "test.md",
    path: "/tmp/test.md",
    source: "artifact",
  };
  assert.equal(await openLocalChatResource(localResource, "finder", dependencies), true);
  assert.equal(await openLocalChatResource(localResource, "system", dependencies), false);
  assert.equal(await openLocalChatResource({ ...mountedAppMarkdownResource, appId: undefined }, "finder", dependencies), false);
  assert.equal(await openLocalChatResource({ ...workspaceResource, origin: "http" }, "system", dependencies), false);
  assert.equal(await openLocalChatResource({ ...workspaceResource, path: undefined }, "system", dependencies), false);

  assert.deepEqual(calls, [
    {
      kind: "mounted-app",
      appId: "sample-pipeline",
      body: {
        path: "novel-writer/batch-runs/production17/status.json",
        target: "system",
      },
    },
    {
      kind: "mounted-app",
      appId: "sample-pipeline",
      body: {
        path: "novel-writer/batch-runs/production17/status.json",
        target: "finder",
      },
    },
    {
      kind: "post",
      url: "/workspace/resource/open",
      body: { path: "docs/test.md", target: "system" },
    },
    {
      kind: "post",
      url: "/workspace/resource/open",
      body: { path: "docs/test.md", target: "finder" },
    },
    {
      kind: "post",
      url: "/local-resource/reveal",
      body: { path: "/tmp/test.md" },
    },
  ]);
`,
  "utf8",
);

try {
  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    absWorkingDir: projectRoot,
    nodePaths: [join(projectRoot, "node_modules")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    jsx: "automatic",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  await import(pathToFileURL(bundlePath).href);
  console.log("web-resource-references-harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
