import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import {
  replyLanguagePreferenceInstruction,
  type AgentEvent,
  type AgentRuntime,
  type AgentTurnRequest,
} from "../core.js";
import { hostMessage } from "../localization/host-messages.js";
import { newProjectArtifactLocale, type ReplyLanguagePreference } from "../localization/language-contracts.js";
import {
  canonicalizeLocaleTag,
  normalizeUiLanguagePreference,
  resolveSupportedLocale,
} from "../localization/locale-registry.js";
import { buildCodexDeveloperInstructions, buildCodexTurnInput } from "../runtime/codex/input.js";
import { defaultBridgeSettings, normalizeBridgeSettingsPatch } from "../server/bridge-settings-store.js";
import { createBridgeState } from "../server/bridge-state.js";
import { resolveHostLanguagePreference, resolveHostLanguageSettings } from "../server/language-preference.js";
import { handleSettingsRoute } from "../server/routes/settings.js";
import { applyProviderSetupMigration } from "../server/system-provider-discovery.js";

const languageInstruction = (defaultLanguage: string) =>
  `Default response language: ${defaultLanguage}. Follow the primary natural language of the current input unless it explicitly requests another language.`;
const zhLanguageInstruction = languageInstruction("Simplified Chinese");
const enLanguageInstruction = languageInstruction("English");

assert.equal(replyLanguagePreferenceInstruction("zh-CN"), zhLanguageInstruction);
assert.equal(replyLanguagePreferenceInstruction("en"), enLanguageInstruction);
assert.equal(replyLanguagePreferenceInstruction(undefined), "");
assert.doesNotMatch(replyLanguagePreferenceInstruction("en"), /entirely|even if|switch only/i);
assert.doesNotMatch(replyLanguagePreferenceInstruction("en"), /Ignore surrounding Host context/i);
assert.doesNotMatch(replyLanguagePreferenceInstruction("en"), /current-message/);
assert.deepEqual(normalizeUiLanguagePreference("system"), "system");
assert.equal(resolveSupportedLocale("zh-Hant-HK"), "zh-CN");
assert.equal(resolveSupportedLocale("fr-FR"), "en");
assert.equal(canonicalizeLocaleTag("de_DE@euro"), "de-DE");
assert.equal(canonicalizeLocaleTag("sr_RS.UTF-8@latin"), "sr-RS");
assert.equal(hostMessage("en", "room.new_group_title", { sequence: 3 }), "New group 3");
assert.equal(hostMessage("zh-CN", "room.new_group_title", { sequence: 3 }), "新群聊 3");
assert.equal(
  hostMessage("en", "room.app_group_title_sequence", { appTitle: "Story Seed", sequence: 3 }),
  "Story Seed group 3",
);
assert.equal(
  hostMessage("zh-CN", "room.app_group_title_sequence", { appTitle: "故事种子", sequence: 3 }),
  "故事种子 群组 3",
);
assert.equal(
  hostMessage("en", "app.readiness.item"),
  "{label}: {detail}",
  "missing descriptor params must preserve placeholders instead of throwing",
);
assert.deepEqual(newProjectArtifactLocale("en"), {
  source: "ui-at-creation",
  locale: "en",
});

assert.equal(resolveHostLanguagePreference("zh-CN", ["en-US"]), "zh-CN");
assert.equal(resolveHostLanguagePreference("en", ["zh-CN"]), "en");
assert.equal(resolveHostLanguagePreference("system", ["zh-Hant-TW"]), "zh-CN");
assert.equal(resolveHostLanguagePreference(undefined, ["zh_CN.UTF-8"]), "zh-CN");
assert.equal(resolveHostLanguagePreference("system", ["fr-FR", "en-GB"]), "en");
assert.equal(resolveHostLanguagePreference("system", ["fr-FR"]), "en");
assert.equal(
  resolveHostLanguageSettings({ languagePreference: "system", systemLanguage: "zh-CN" }, ["en-US"]),
  "zh-CN",
);
assert.equal(resolveHostLanguageSettings({ languagePreference: "en", systemLanguage: "zh-CN" }, ["zh-CN"]), "en");
const synchronizedSystemSettings = normalizeBridgeSettingsPatch(
  {
    languagePreference: "system",
    systemLanguage: "zh-CN",
  },
  defaultBridgeSettings(),
);
assert.equal(synchronizedSystemSettings.languagePreference, "system");
assert.equal(synchronizedSystemSettings.systemLanguage, "zh-CN");
assert.equal(
  normalizeBridgeSettingsPatch({ systemLanguage: "unsupported" }, synchronizedSystemSettings).systemLanguage,
  "zh-CN",
);
const knowledgeRouteSource = readFileSync(new URL("../../src/server/routes/knowledge.ts", import.meta.url), "utf8");
assert.match(knowledgeRouteSource, /chooseImportFolder\(resolveHostLanguageSettings\(state\.settings\)\)/);
assert.match(knowledgeRouteSource, /hostMessage\(language, "dialog\.import_folder"\)/);
assert.doesNotMatch(knowledgeRouteSource, /language === "en"/);

const presentationTempRoot = mkdtempSync(join(tmpdir(), "opengrove-language-presentation-"));
const presentationAppRoot = join(presentationTempRoot, "demo-app");
const presentationStatePath = join(presentationTempRoot, "state.json");
mkdirSync(join(presentationAppRoot, "workspace"), { recursive: true });
writeFileSync(
  join(presentationAppRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "demo-app",
    title: "故事种子",
    defaultLocale: "zh-CN",
    workspace: { path: "workspace" },
    employees: [
      {
        id: "writer",
        name: "故事架构师",
        kernel: "claude-code",
        role: "负责故事设计",
        publicDescription: "与作者共创故事。",
      },
    ],
    locales: {
      en: {
        title: "Story Seed",
        employees: {
          writer: {
            name: "Story Architect",
            role: "Co-creates a story outline with the author.",
            publicDescription: "Co-creates stories with the author.",
            publicSkills: ["Story design", "Outlining"],
            inputSpec: "A story premise.",
            outputSpec: "A reviewed outline.",
          },
        },
      },
    },
  }),
);
writeFileSync(
  join(presentationTempRoot, "bridge-settings.json"),
  JSON.stringify({
    languagePreference: "zh-CN",
    mountedApps: [
      {
        id: "demo-app",
        path: presentationAppRoot,
        enabled: true,
      },
    ],
  }),
);
const presentationState = createBridgeState({ statePath: presentationStatePath });
try {
  for (let index = 0; index < 3; index += 1) {
    presentationState.settings = applyProviderSetupMigration(
      normalizeBridgeSettingsPatch({}, presentationState.settings),
    );
  }
  const writerId = "member-app-demo-app-writer";
  const pmId = "member-app-demo-app-pm";
  const defaultGroupId = "app-room--demo-app--group--default";
  const originalApp = presentationState.app;
  const initialWriter = presentationState.app.rooms.listMembers().find((member) => member.id === writerId);
  assert.equal(initialWriter?.displayName, undefined);
  presentationState.app.rooms.upsertMember({
    ...initialWriter!,
    name: "My Custom Writer",
    userOverrides: ["name"],
  });
  presentationState.app.rooms.createRoom({
    id: "app-room--demo-app--group--legacy-generated",
    scope: { kind: "app", appId: "demo-app", role: "group" },
    title: "故事种子 群组 2",
    badge: "故事种子",
    generatedTitle: { kind: "app-group", appId: "demo-app", sequence: 2 },
    memberIds: [writerId, pmId],
  });
  presentationState.app.rooms.createRoom({
    id: "app-room--demo-app--group--ambiguous-legacy-title",
    scope: { kind: "app", appId: "demo-app", role: "group" },
    title: "故事种子 群组 3",
    badge: "A custom badge",
    memberIds: [writerId, pmId],
  });
  presentationState.app.rooms.createRoom({
    id: "app-room--demo-app--group--untagged-generated-title",
    scope: { kind: "app", appId: "demo-app", role: "group" },
    title: "Story Seed 群组 5",
    badge: "Story Seed",
    memberIds: [writerId, pmId],
  });
  presentationState.app.rooms.createRoom({
    id: "room-numbered-generated",
    title: "新群聊 6",
    badge: "本地",
    generatedTitle: { kind: "numbered-group", sequence: 6 },
    memberIds: [writerId, pmId],
  });
  presentationState.app.rooms.createRoom({
    id: "room-numbered-legacy-generated",
    title: "新群聊 7",
    badge: "Matrix",
    memberIds: [writerId, pmId],
  });
  presentationState.app.rooms.createRoom({
    id: "room-numbered-ambiguous-custom",
    title: "新群聊 8",
    badge: "My custom badge",
    memberIds: [writerId, pmId],
  });
  presentationState.app.rooms.upsertMember({
    id: "member-app-legacy-vfs-editing",
    name: "VFS 素材剪辑",
    kernel: "claude-code",
    model: "claude-code-default",
    role: "旧版 App 员工",
    status: "offline",
    color: "#64748b",
    lastActive: "manifest removed",
    appId: "legacy-vfs",
    source: "local",
    sourceLabel: "VFS App",
    disabled: true,
  });

  const responses: Array<{ status: number; data: Record<string, unknown> }> = [];
  const handled = await handleSettingsRoute({
    request: { method: "PATCH" } as never,
    response: {} as never,
    url: new URL("http://opengrove.test/settings"),
    state: presentationState,
    sendJson: (_response, status, data) =>
      responses.push({
        status,
        data: data as Record<string, unknown>,
      }),
    readJsonBody: async () => ({ languagePreference: "en" }),
  });
  assert.equal(handled, true);
  assert.equal(responses[0]?.status, 200);
  assert.equal(responses[0]?.data.restarted, false, "language switch must not recreate native Agent threads");
  assert.equal(presentationState.app, originalApp, "language switch keeps the current OpenGrove runtime");
  const englishWriter = presentationState.app.rooms.listMembers().find((member) => member.id === writerId);
  const englishPm = presentationState.app.rooms.listMembers().find((member) => member.id === pmId);
  assert.equal(
    englishWriter?.name,
    "My Custom Writer",
    "localized presentation must not overwrite a custom canonical name",
  );
  assert.deepEqual(englishWriter?.userOverrides, ["name"]);
  assert.equal(englishWriter?.displayName, "Story Architect");
  assert.equal(englishWriter?.displayRole, "Co-creates a story outline with the author.");
  assert.equal(englishWriter?.displayPublicDescription, "Co-creates stories with the author.");
  assert.deepEqual(englishWriter?.displayPublicSkills, ["Story design", "Outlining"]);
  assert.equal(englishWriter?.displayInputSpec, "A story premise.");
  assert.equal(englishWriter?.displayOutputSpec, "A reviewed outline.");
  assert.equal(englishWriter?.sourceLabel, "Story Seed App");
  assert.equal(englishPm?.displayName, "Story Seed PM");
  const englishDefaultGroup = presentationState.app.rooms.listRooms().find((room) => room.id === defaultGroupId);
  const englishLegacyGroup = presentationState.app.rooms
    .listRooms()
    .find((room) => room.id === "app-room--demo-app--group--legacy-generated");
  const ambiguousLegacyGroup = presentationState.app.rooms
    .listRooms()
    .find((room) => room.id.endsWith("ambiguous-legacy-title"));
  const untaggedGeneratedGroup = presentationState.app.rooms
    .listRooms()
    .find((room) => room.id.endsWith("untagged-generated-title"));
  assert.equal(englishDefaultGroup?.title, "Story Seed group");
  assert.deepEqual(englishDefaultGroup?.generatedTitle, { kind: "app-group", appId: "demo-app", sequence: 1 });
  assert.equal(englishLegacyGroup?.title, "Story Seed group 2");
  assert.deepEqual(englishLegacyGroup?.generatedTitle, { kind: "app-group", appId: "demo-app", sequence: 2 });
  assert.equal(untaggedGeneratedGroup?.title, "Story Seed 群组 5");
  assert.equal(
    untaggedGeneratedGroup?.generatedTitle,
    undefined,
    "language switching must not infer ownership of an untagged generated-looking title",
  );
  assert.equal(
    ambiguousLegacyGroup?.title,
    "故事种子 群组 3",
    "an untagged legacy title is ambiguous and must not be rewritten as generated content",
  );
  assert.equal(
    presentationState.app.rooms.listRooms().find((room) => room.id === "room-numbered-generated")?.title,
    "New group 6",
  );
  assert.equal(
    presentationState.app.rooms.listRooms().find((room) => room.id === "room-numbered-legacy-generated")?.title,
    "新群聊 7",
    "language switching must not infer ownership of an untagged numbered title",
  );
  assert.equal(
    presentationState.app.rooms.listRooms().find((room) => room.id === "room-numbered-ambiguous-custom")?.title,
    "新群聊 8",
    "a matching title with a custom badge remains user-owned",
  );
  assert.equal(
    presentationState.app.rooms.listMembers().find((member) => member.id === "member-app-legacy-vfs-editing")
      ?.displayName,
    undefined,
    "a stale App employee without locales keeps its persisted canonical name",
  );
  presentationState.app.rooms.patchRoom(defaultGroupId, {
    title: "My custom default room",
    badge: "Custom",
    generatedTitle: null,
  });
  presentationState.app.rooms.patchRoom("app-room--demo-app--group--untagged-generated-title", {
    title: "Story Seed group 9",
    badge: "Story Seed",
    generatedTitle: null,
  });
  presentationState.app.rooms.patchRoom("room-numbered-legacy-generated", {
    title: "New group 10",
    badge: "Local",
    generatedTitle: null,
  });

  await handleSettingsRoute({
    request: { method: "PATCH" } as never,
    response: {} as never,
    url: new URL("http://opengrove.test/settings"),
    state: presentationState,
    sendJson: () => {},
    readJsonBody: async () => ({ languagePreference: "zh-CN" }),
  });
  const chineseWriter = presentationState.app.rooms.listMembers().find((member) => member.id === writerId);
  const chinesePm = presentationState.app.rooms.listMembers().find((member) => member.id === pmId);
  assert.equal(chineseWriter?.displayName, undefined, "switching back removes the English presentation overlay");
  assert.equal(chineseWriter?.displayRole, undefined);
  assert.equal(chineseWriter?.displayPublicDescription, undefined);
  assert.equal(chineseWriter?.displayPublicSkills, undefined);
  assert.equal(chineseWriter?.displayInputSpec, undefined);
  assert.equal(chineseWriter?.displayOutputSpec, undefined);
  assert.equal(chineseWriter?.sourceLabel, "故事种子 App");
  assert.equal(chinesePm?.displayName, undefined);
  assert.equal(
    presentationState.app.rooms.listMembers().find((member) => member.id === "member-app-legacy-vfs-editing")
      ?.displayName,
    undefined,
  );
  assert.equal(
    presentationState.app.rooms.listRooms().find((room) => room.id === defaultGroupId)?.title,
    "My custom default room",
    "a custom default-group title must survive later language switches",
  );
  assert.equal(
    presentationState.app.rooms
      .listRooms()
      .find((room) => room.id === "app-room--demo-app--group--untagged-generated-title")?.title,
    "Story Seed group 9",
    "an untagged generated-looking App title is user-owned after startup migration",
  );
  assert.equal(
    presentationState.app.rooms.listRooms().find((room) => room.id === "room-numbered-legacy-generated")?.title,
    "New group 10",
    "an untagged generated-looking numbered title is user-owned after startup migration",
  );
} finally {
  await presentationState.store.close?.();
  rmSync(presentationTempRoot, { recursive: true, force: true });
}

let language: ReplyLanguagePreference = "zh-CN";
const capturedRequests: AgentTurnRequest[] = [];
const runtime: AgentRuntime = {
  async *runTurn(request): AsyncIterable<AgentEvent> {
    capturedRequests.push(request);
    yield {
      type: "turn.finished",
      runId: request.runId ?? "language-preference-test",
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  },
};
const app = createOpenGrove({
  readPage: async () => ({}),
  readReplyLanguagePreference: () => language,
  runtime,
});

for await (const _event of app.runTurn("第一轮")) {
  // Consume the run so the runtime request is captured.
}
language = "en";
for await (const _event of app.runTurn("Second turn")) {
  // Consume the run so the runtime request is captured.
}
for await (const _event of app.runTurn("Please answer in Japanese.")) {
  // Explicit user language requests remain untouched for the model to interpret.
}

assert.equal(capturedRequests.length, 3);
assert.equal(capturedRequests[0]?.replyLanguagePreference, "zh-CN");
assert.equal(capturedRequests[1]?.replyLanguagePreference, "en");
assert.equal(capturedRequests[2]?.replyLanguagePreference, "en");
assert.equal(capturedRequests[2]?.input, "Please answer in Japanese.");
assert.ok(
  buildCodexTurnInput(capturedRequests[0]!).endsWith(`User request:\n第一轮\n\n${zhLanguageInstruction}`),
  "per-Turn language preferences must remain the final turn-input instruction",
);
assert.doesNotMatch(
  buildCodexDeveloperInstructions(),
  new RegExp(`${zhLanguageInstruction}|${enLanguageInstruction}`),
  "per-Turn language preferences must not enter Codex thread-start instructions",
);
assert.deepEqual(
  new Set(app.sessions.listRuns().map((run) => run.input)),
  new Set(["第一轮", "Second turn", "Please answer in Japanese."]),
  "the language preference must not be stored as part of the user's chat message",
);

console.log("language preference harness passed");
