import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";

const result = await build({
  entryPoints: [resolve("web/src/components/apps/mounted-app-shell-model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const source = result.outputFiles[0].text;
const model = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const mountedAppModelResult = await build({
  entryPoints: [resolve("web/src/components/apps/mounted-app-model.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const mountedAppModel = await import(
  `data:text/javascript;base64,${Buffer.from(mountedAppModelResult.outputFiles[0].text).toString("base64")}`
);

assert.equal(model.defaultMountedAppCrewOpen("setup"), true);
assert.equal(model.defaultMountedAppCrewOpen("file-workbench"), true);
assert.equal(model.defaultMountedAppCrewOpen("view"), false);
assert.equal(model.defaultMountedAppCrewOpen("none"), false);
assert.notEqual(
  model.mountedAppCrewStorageKey("app-a"),
  model.mountedAppCrewStorageKey("app-b"),
  "crew panel memory must be App-scoped",
);

const viewTabs = mountedAppModel.resolveMountedAppTabs(
  {
    id: "app:workbench-view-tab",
    kind: "app",
    name: "workbench-view-tab",
    title: "Workbench View Tab",
    enabled: true,
    metadata: {
      ui: {
        tabs: [
          { component: "file-tree", label: "创作空间" },
          {
            id: "work-management",
            component: "view",
            label: "作品管理",
            view: {
              protocol: "mcp-app",
              entry: "ui/work-management.html",
              tools: ["opengrove.app.workspace.list"],
            },
          },
        ],
      },
    },
    deployments: [],
  },
  (key) => key,
);
assert.deepEqual(
  viewTabs.map(({ id, component, label }) => ({ id, component, label })),
  [
    { id: undefined, component: "file-tree", label: "创作空间" },
    { id: "work-management", component: "view", label: "作品管理" },
  ],
);
const legacyCanonicalTabs = mountedAppModel.resolveMountedAppTabs(
  {
    id: "app:legacy-chinese-tabs",
    kind: "app",
    name: "legacy-chinese-tabs",
    title: "Legacy Chinese Tabs",
    enabled: true,
    metadata: {
      ui: {
        tabs: [
          { component: "file-tree", label: "作品" },
          { component: "dashboard", label: "数据看板" },
        ],
      },
    },
    deployments: [],
  },
  (key) => key,
);
assert.deepEqual(
  legacyCanonicalTabs.map(({ component, label }) => ({ component, label })),
  [
    { component: "file-tree", label: "作品" },
    { component: "dashboard", label: "数据看板" },
  ],
);
assert.deepEqual(
  mountedAppModel.resolveMountedAppWorkbenchLayoutDefaults({
    metadata: { ui: { workbenchLayout: { filesWidth: 180, chatWidth: 800 } } },
  }),
  { filesWidth: 180, chatWidth: 800 },
  "any App may declare its initial workbench layout through metadata.ui",
);
assert.deepEqual(
  mountedAppModel.resolveMountedAppWorkbenchLayoutDefaults({ metadata: { ui: {} } }),
  {},
  "Apps without a layout declaration must fall back to Host defaults",
);
assert.deepEqual(
  mountedAppModel.resolveMountedAppWorkbenchLayoutDefaults({
    metadata: { ui: { workbenchLayout: { filesWidth: Number.NaN, chatWidth: "800" } } },
  }),
  {},
  "invalid manifest values must not reach CSS width calculations",
);

const currentRoom = room("current", [
  toolPart("question", { questionId: "question-current", questionStatus: "pending" }),
  toolPart("question", { questionId: "question-zombie", questionStatus: "pending" }),
  toolPart("approval", { approvalId: "approval-current", approvalStatus: "pending" }),
  toolPart("question", { questionId: "question-resolved", questionStatus: "answered" }),
]);
const otherAppRoom = room("other", [
  toolPart("question", { questionId: "question-other", questionStatus: "pending" }),
  toolPart("approval", { approvalId: "approval-other", approvalStatus: "pending" }),
]);
assert.equal(
  model.countMountedAppPendingActionParts(
    [currentRoom, otherAppRoom],
    (candidate) => candidate.id === "current",
    new Set(["question-current", "question-other"]),
    new Set(["approval-current", "approval-other"]),
  ),
  2,
  "the badge must trust the live inbox and ignore stale pending parts from an interrupted run",
);

console.log("web-app-setup-shell model contract passed");

function room(id, parts) {
  return {
    id,
    kind: "group",
    title: id,
    badge: "",
    memberIds: [],
    messages: [
      {
        id: `message-${id}`,
        senderId: "employee",
        senderName: "Employee",
        senderType: "agent",
        text: "",
        targetIds: [],
        status: "waiting_user",
        createdAt: new Date(0).toISOString(),
        parts,
      },
    ],
    updatedAt: new Date(0).toISOString(),
    unread: 0,
  };
}

function toolPart(phase, overrides) {
  return {
    id: `${phase}-${overrides.questionId || overrides.approvalId}`,
    type: "tool",
    phase,
    toolId: phase,
    title: phase,
    status: "requires-action",
    error: "",
    approvalId: "",
    approvalStatus: "",
    approvalReason: "",
    questionId: "",
    questionStatus: "",
    questionPrompt: "",
    ...overrides,
  };
}
