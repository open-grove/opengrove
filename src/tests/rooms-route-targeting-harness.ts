import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenGroveClient } from "#client";
import type { AgentEvent } from "../core.js";
import { hostContractById } from "#protocol/compiled";
import { appEnvName } from "../identity.js";
import { startLocalBridgeServer } from "../server/local-bridge.js";
import { createBridgeState } from "../server/bridge-state.js";
import { pmAgentMemberId } from "../server/bridge-mounted-app-employees.js";
import { defaultAppGroupRoomId } from "../server/app-room-ids.js";
import { dispatchBridgeRoutes, type BridgeRouteContext } from "../server/router.js";
import { operationRoute } from "../server/routes/registry-utils.js";
import { handleCreateRoomMessageOperation } from "../server/routes/rooms/message-routes.js";
import type { RoomChannelMember } from "../rooms/channel-store.js";
import { roomExecutionState } from "../server/room-runs/execution-state.js";

const dir = mkdtempSync(join(tmpdir(), "opengrove-rooms-route-targeting-"));
const rosterAppRoot = join(dir, "roster-app");
mkdirSync(rosterAppRoot, { recursive: true });
writeFileSync(
  join(rosterAppRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "roster-app",
    title: "Roster App",
    workspace: { path: "workspace" },
    employees: [{ id: "writer", name: "Roster Writer", role: "writer" }],
  }),
  "utf8",
);
const emptyAppRoot = join(dir, "empty-no-pm-app");
mkdirSync(emptyAppRoot, { recursive: true });
writeFileSync(
  join(emptyAppRoot, "opengrove.app.json"),
  JSON.stringify({
    id: "empty-no-pm-app",
    title: "Empty No PM App",
    workspace: { path: "workspace" },
    disablePmAgent: true,
    employees: [],
  }),
  "utf8",
);
const token = "rooms-route-targeting-token";
const claudeRuntimeEnvName = appEnvName("CLAUDE_CODE_RUNTIME");
const claudeCliPathEnvName = appEnvName("CLAUDE_CLI_PATH");
const anthropicApiKeyEnvName = "ANTHROPIC_API_KEY";
const previousClaudeRuntime = process.env[claudeRuntimeEnvName];
const previousClaudeCliPath = process.env[claudeCliPathEnvName];
const previousAnthropicApiKey = process.env[anthropicApiKeyEnvName];
process.env[claudeRuntimeEnvName] = "sdk";
process.env[claudeCliPathEnvName] = process.execPath;
process.env[anthropicApiKeyEnvName] = "rooms-route-targeting-test-key";
const server = startLocalBridgeServer({
  host: "127.0.0.1",
  port: 0,
  statePath: join(dir, "state.json"),
  bridgeToken: token,
});

try {
  if (!server.listening) {
    await once(server, "listening");
  }

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  const client = createOpenGroveClient({
    baseUrl,
    headers: { "x-opengrove-token": token },
  });
  await patchJson(`${baseUrl}/settings`, { languagePreference: "en" });
  const mountRosterApp = await patchJson(`${baseUrl}/settings`, {
    mountedApps: [
      { id: "roster-app", title: "Roster App", path: rosterAppRoot, enabled: true },
      { id: "empty-no-pm-app", title: "Empty No PM App", path: emptyAppRoot, enabled: true },
    ],
  });
  assert.equal(mountRosterApp.response.ok, true, JSON.stringify(mountRosterApp.json));
  const unrelatedWorkspaceRoot = join(dir, "unrelated-workspace");
  mkdirSync(unrelatedWorkspaceRoot, { recursive: true });
  const rejectedWorkspaceInjection = await patchJson(`${baseUrl}/settings`, {
    mountedApps: [
      {
        id: "roster-app",
        title: "Roster App",
        path: rosterAppRoot,
        workspacePath: unrelatedWorkspaceRoot,
        enabled: true,
      },
      { id: "empty-no-pm-app", title: "Empty No PM App", path: emptyAppRoot, enabled: true },
    ],
  });
  assert.equal(rejectedWorkspaceInjection.response.status, 422);
  assert.equal(
    (rejectedWorkspaceInjection.json as { error?: string }).error,
    "app_workspace_binding_invalid",
    "settings PATCH must not redirect an App Agent to an arbitrary directory without a verified filesystem binding",
  );
  const boundedSettings = await getJson<{
    settings: {
      mountedApps: Array<{ id: string; workspacePath?: string }>;
      providers: Array<{ id: string; modelCount: number; models: unknown[] }>;
    };
  }>(`${baseUrl}/settings`);
  assert.equal(
    boundedSettings.settings.mountedApps.find((app) => app.id === "roster-app")?.workspacePath,
    undefined,
    "a rejected Workspace injection must leave persisted mount settings unchanged",
  );
  assert.ok(
    boundedSettings.settings.providers.every((provider) => provider.models.length === 0),
    "/settings must return bounded Provider summaries without complete model catalogs",
  );
  const providerModels = await getJson<{
    providers: Array<{ id: string; models: unknown[] }>;
  }>(`${baseUrl}/settings/provider-models`);
  const modelsByProvider = new Map(providerModels.providers.map((provider) => [provider.id, provider.models]));
  for (const provider of boundedSettings.settings.providers) {
    assert.equal(
      modelsByProvider.get(provider.id)?.length,
      provider.modelCount,
      `the independent model catalog must match the ${provider.id} settings summary`,
    );
  }
  await postJson(`${baseUrl}/rooms/members`, {
    id: "member-app-route-app-builder",
    employeeDefinitionId: "app-builder",
    name: "App 构建师",
    kernel: "claude-code",
    model: "claude-opus-default",
    role: "scoped App Builder",
    status: "idle",
    color: "#7c3aed",
    lastActive: "now",
    appId: "route-app",
    workspaceRoot: "/tmp/route-app",
    source: "local",
  });
  const appBuilderPatch = await patchJson(`${baseUrl}/rooms/members/app-builder`, {
    avatarMode: "upload",
    avatarSeed: "app-builder-notionists-choice",
    avatarDataUrl: "data:image/gif;base64,R0lGODlh",
    kernel: "codex",
    model: "gpt-5.6",
  });
  assert.equal(appBuilderPatch.response.ok, true, "the product App Builder should use the normal member PATCH route");
  const patchedAppBuilder = appBuilderPatch.json as {
    member?: {
      avatarMode?: string;
      avatarSeed?: string;
      avatarDataUrl?: string;
      kernel?: string;
      model?: string;
      userOverrides?: string[];
    };
  };
  assert.equal(patchedAppBuilder.member?.avatarMode, "upload");
  assert.equal(patchedAppBuilder.member?.avatarSeed, "app-builder-notionists-choice");
  assert.equal(patchedAppBuilder.member?.avatarDataUrl, "data:image/gif;base64,R0lGODlh");
  assert.equal(patchedAppBuilder.member?.kernel, "codex");
  assert.equal(patchedAppBuilder.member?.model, "gpt-5.6");
  assert.deepEqual(
    patchedAppBuilder.member?.userOverrides,
    ["avatarMode", "avatarSeed", "avatarDataUrl", "kernel", "model"],
    "product-default runtime edits must be persisted across seed refreshes",
  );
  const roomsAfterAppBuilderPatch = await getJson<{
    members: Array<{
      id: string;
      avatarMode?: string;
      avatarSeed?: string;
      avatarDataUrl?: string;
      kernel: string;
      model: string;
    }>;
  }>(`${baseUrl}/rooms`);
  const scopedAppBuilder = roomsAfterAppBuilderPatch.members.find(
    (candidate) => candidate.id === "member-app-route-app-builder",
  );
  assert.equal(scopedAppBuilder?.avatarMode, "upload", "logical Employee avatar mode propagates to scoped bindings");
  assert.equal(
    scopedAppBuilder?.avatarSeed,
    "app-builder-notionists-choice",
    "logical Employee avatar seed propagates to scoped bindings",
  );
  assert.equal(
    scopedAppBuilder?.avatarDataUrl,
    undefined,
    "scoped bindings do not duplicate logical Employee upload data",
  );
  assert.equal(scopedAppBuilder?.kernel, "codex", "logical Employee runtime changes propagate to scoped bindings");
  assert.equal(scopedAppBuilder?.model, "gpt-5.6", "scoped bindings receive the selected model immediately");

  const rosterAppId = "roster-app";
  const rosterPmId = "member-app-roster-app-pm";
  const rosterWriterId = "member-app-roster-app-writer";
  await postJson(`${baseUrl}/rooms/members`, {
    id: rosterPmId,
    employeeDefinitionId: "pm",
    name: "Roster App PM",
    kernel: "claude-code",
    model: "claude-code-default",
    role: "project manager",
    status: "idle",
    color: "#f59e0b",
    lastActive: "now",
    appId: rosterAppId,
    source: "local",
  });
  await postJson(`${baseUrl}/rooms/members`, {
    id: rosterWriterId,
    name: "Roster Writer",
    kernel: "codex",
    model: "gpt-5.6",
    role: "writer",
    status: "idle",
    color: "#2563eb",
    lastActive: "now",
    appId: rosterAppId,
    source: "local",
  });
  const authoritativeDefaultGroup = await postJson<{
    room: { memberIds: string[]; adminMemberIds: string[]; scope?: { kind: string; appId: string } };
  }>(`${baseUrl}/rooms`, {
    id: defaultAppGroupRoomId(rosterAppId),
    scope: { kind: "app", appId: rosterAppId, role: "default" },
    title: "Roster App Group",
    memberIds: [rosterPmId],
    badge: "Roster App",
  });
  assert.deepEqual(
    authoritativeDefaultGroup.room.memberIds.sort(),
    [rosterPmId, rosterWriterId].sort(),
    "App-group creation must use the backend's active App roster instead of a stale browser list",
  );
  assert.deepEqual(authoritativeDefaultGroup.room.adminMemberIds, [rosterPmId]);
  assert.deepEqual(authoritativeDefaultGroup.room.scope, { kind: "app", appId: rosterAppId, role: "default" });
  const authoritativeCustomGroup = await postJson<{
    room: { memberIds: string[]; adminMemberIds: string[] };
  }>(`${baseUrl}/rooms`, {
    id: "app-room--roster-app--group--custom-title",
    scope: { kind: "app", appId: rosterAppId },
    title: "My custom project",
    memberIds: [rosterPmId, "pm"],
    badge: "Roster App",
  });
  assert.deepEqual(
    authoritativeCustomGroup.room.memberIds.sort(),
    [rosterPmId, rosterWriterId].sort(),
    "custom-titled App groups still clone the authoritative App roster and exclude global PM",
  );
  assert.deepEqual(authoritativeCustomGroup.room.adminMemberIds, [rosterPmId]);

  const optionalPmDelete = await requestJson(
    `${baseUrl}/rooms/${encodeURIComponent(defaultAppGroupRoomId(rosterAppId))}/members/${encodeURIComponent(rosterPmId)}`,
    { method: "DELETE" },
  );
  const optionalPmDeleteBody = optionalPmDelete.json as {
    room: { memberIds: string[]; adminMemberIds: string[] };
  };
  assert.equal(optionalPmDelete.response.status, 200);
  assert.deepEqual(optionalPmDeleteBody.room.memberIds, [rosterWriterId]);
  assert.deepEqual(optionalPmDeleteBody.room.adminMemberIds, []);
  const optionalPmAdminRemoval = await patchJson(
    `${baseUrl}/rooms/${encodeURIComponent(defaultAppGroupRoomId(rosterAppId))}`,
    { adminMemberIds: [] },
  );
  assert.equal(optionalPmAdminRemoval.response.status, 200);
  const groupAfterPmRemoval = await postJson<{
    room: { memberIds: string[]; adminMemberIds: string[] };
  }>(`${baseUrl}/rooms`, {
    id: "app-room--roster-app--group--without-pm",
    scope: { kind: "app", appId: rosterAppId },
    title: "No PM required",
    memberIds: [rosterWriterId],
    badge: "Roster App",
  });
  assert.deepEqual(groupAfterPmRemoval.room.memberIds, [rosterWriterId]);
  assert.deepEqual(groupAfterPmRemoval.room.adminMemberIds, []);

  const unmountedAppGroup = await requestJson(`${baseUrl}/rooms`, {
    method: "POST",
    body: {
      id: defaultAppGroupRoomId("gone-app"),
      scope: { kind: "app", appId: "gone-app" },
      generatedTitle: { kind: "app-group", appId: "gone-app", sequence: 1 },
      title: "Gone App",
      memberIds: [rosterPmId],
      badge: "Gone App",
    },
  });
  assert.equal(unmountedAppGroup.response.status, 409);
  assert.deepEqual(unmountedAppGroup.json, { ok: false, error: "app_not_mounted" });

  const emptyAppGroup = await requestJson(`${baseUrl}/rooms`, {
    method: "POST",
    body: {
      id: defaultAppGroupRoomId("empty-no-pm-app"),
      scope: { kind: "app", appId: "empty-no-pm-app" },
      title: "Empty No PM App",
      memberIds: [],
      badge: "Empty No PM App",
    },
  });
  assert.equal(emptyAppGroup.response.status, 409);
  assert.deepEqual(emptyAppGroup.json, { ok: false, error: "app_roster_empty" });

  const settingsBeforeProviderDelete = await getJson<{
    settings: {
      customProviders: Array<Record<string, unknown>>;
      modelProviderBindings: Array<{ modelId: string; providerId: string }>;
    };
  }>(`${baseUrl}/settings`);
  const providerToDelete = {
    id: "employee-cleanup-provider",
    name: "Employee cleanup Provider",
    custom: true,
    enabled: true,
    origin: "user",
    protocol: "openai-compatible",
    openaiBaseUrl: "https://cleanup-provider.example.test/v1",
    apiKey: "cleanup-provider-test-key",
    credentialKind: "api-key",
    models: [{ id: "cleanup-provider-model", label: "Cleanup Provider Model" }],
  };
  const addProvider = await patchJson(`${baseUrl}/settings`, {
    customProviders: [...settingsBeforeProviderDelete.settings.customProviders, providerToDelete],
    modelProviderBindings: [
      ...settingsBeforeProviderDelete.settings.modelProviderBindings,
      { modelId: "cleanup-provider-model", providerId: providerToDelete.id },
    ],
  });
  assert.equal(addProvider.response.ok, true, JSON.stringify(addProvider.json));
  const pinEmployeeProvider = await patchJson(`${baseUrl}/rooms/members/app-builder`, {
    providerId: providerToDelete.id,
  });
  assert.equal(pinEmployeeProvider.response.ok, true, JSON.stringify(pinEmployeeProvider.json));

  const removeProvider = await patchJson(`${baseUrl}/settings`, {
    customProviders: settingsBeforeProviderDelete.settings.customProviders,
  });
  assert.equal(removeProvider.response.ok, true, JSON.stringify(removeProvider.json));
  const settingsAfterProviderDelete = await getJson<{
    settings: { modelProviderBindings: Array<{ providerId: string }> };
  }>(`${baseUrl}/settings`);
  assert.equal(
    settingsAfterProviderDelete.settings.modelProviderBindings.some(
      (binding) => binding.providerId === providerToDelete.id,
    ),
    false,
    "deleting a Provider must clear model defaults that reference it",
  );
  const roomsAfterProviderDelete = await getJson<{
    members: Array<{ id: string; providerId?: string; userOverrides?: string[] }>;
  }>(`${baseUrl}/rooms`);
  const cleanedDefinition = roomsAfterProviderDelete.members.find((candidate) => candidate.id === "app-builder");
  const cleanedScopedBinding = roomsAfterProviderDelete.members.find(
    (candidate) => candidate.id === "member-app-route-app-builder",
  );
  assert.equal(
    cleanedDefinition?.providerId,
    undefined,
    "deleting a Provider must clear Employee overrides that reference it",
  );
  assert.equal(
    cleanedScopedBinding?.providerId,
    undefined,
    "deleting a Provider must clear scoped Employee bindings too",
  );
  assert.equal(cleanedDefinition?.userOverrides?.includes("providerId") ?? false, false);
  assert.equal(cleanedScopedBinding?.userOverrides?.includes("providerId") ?? false, false);

  const member: RoomChannelMember = {
    id: "employee-human-target",
    name: "Human Target",
    kernel: "user",
    model: "manual",
    role: "human collaborator",
    status: "idle",
    color: "#64748b",
    lastActive: "now",
    source: "human",
  };

  await postJson(`${baseUrl}/rooms/members`, member);
  await postJson(`${baseUrl}/rooms`, {
    id: "room-route-targeting",
    title: "Route targeting",
    memberIds: [member.id],
    badge: "本地",
  });

  const routed = (await client.rooms.messages.create({
    roomId: "room-route-targeting",
    text: "Run this without an explicit mention.",
    targetIds: [member.id],
    attachments: [],
    userMessageId: "message-user-explicit-target",
    assistantMessageIds: ["message-assistant-explicit-target"],
    selectedFile: { path: "项目/长安客/章节大纲.md" },
  })) as {
    ok: true;
    userMessage: {
      targetIds: string[];
      deliveryKind?: string;
      selectedFile?: { path: string };
      rootMessageId?: string;
    };
    assistantMessages: Array<{ senderId: string; text: string; status: string }>;
  };

  assert.equal(routed.ok, true);
  assert.deepEqual(routed.userMessage.targetIds, [member.id]);
  assert.equal(routed.userMessage.deliveryKind, "user_direct");
  assert.deepEqual(routed.userMessage.selectedFile, { path: "项目/长安客/章节大纲.md" });
  assert.equal(routed.userMessage.rootMessageId, undefined);
  assert.equal(routed.assistantMessages.length, 1);
  assert.equal(routed.assistantMessages[0]?.senderId, member.id);
  assert.equal(routed.assistantMessages[0]?.status, "done");
  assert.equal(
    routed.assistantMessages[0]?.text,
    "Human Target is a human member and will not generate an automatic agent reply.",
  );

  await patchJson(`${baseUrl}/settings`, { languagePreference: "zh-CN" });
  const nonRunnableMember: RoomChannelMember = {
    ...member,
    id: "employee-non-runnable-target",
    name: "故事架构师",
    kernel: "browser",
    source: "local",
  };
  await postJson(`${baseUrl}/rooms/members`, nonRunnableMember);
  await postJson(`${baseUrl}/rooms`, {
    id: "room-non-runnable-target",
    title: "不可执行员工",
    memberIds: [nonRunnableMember.id],
    badge: "本地",
  });
  const nonRunnable = await postJson<{
    ok: true;
    assistantMessages: Array<{ senderId: string; text: string; status: string }>;
  }>(`${baseUrl}/rooms/room-non-runnable-target/messages`, {
    text: "请继续完善大纲。",
    targetIds: [nonRunnableMember.id],
    userMessageId: "message-user-non-runnable-target",
    assistantMessageIds: ["message-assistant-non-runnable-target"],
  });
  assert.equal(nonRunnable.ok, true);
  assert.equal(nonRunnable.assistantMessages.length, 1);
  assert.equal(nonRunnable.assistantMessages[0]?.senderId, nonRunnableMember.id);
  assert.equal(nonRunnable.assistantMessages[0]?.status, "done");
  assert.equal(nonRunnable.assistantMessages[0]?.text, "故事架构师 当前不是可执行的本机 agent。");
  await patchJson(`${baseUrl}/settings`, { languagePreference: "en" });

  const agentPosted = await postJson<{
    ok: true;
    message: {
      targetIds: string[];
      deliveryKind?: string;
      inReplyToMessageId?: string;
      rootMessageId?: string;
      selectedFile?: { path: string };
    };
  }>(`${baseUrl}/rooms/room-route-targeting/agent-messages`, {
    senderId: member.id,
    senderName: member.name,
    text: "Agent API provenance",
    targetIds: [member.id],
    deliveryKind: "agent_delegation",
    inReplyToMessageId: "message-user-explicit-target",
    rootMessageId: "message-user-explicit-target",
    selectedFile: { path: "项目/API/来源.md" },
  });
  assert.deepEqual(agentPosted.message.targetIds, [member.id]);
  assert.equal(agentPosted.message.deliveryKind, "agent_delegation");
  assert.equal(agentPosted.message.inReplyToMessageId, "message-user-explicit-target");
  assert.equal(agentPosted.message.rootMessageId, "message-user-explicit-target");
  assert.deepEqual(agentPosted.message.selectedFile, { path: "项目/API/来源.md" });
  const roomsBeforeRead = await getJson<{
    rooms: Array<{ id: string; unread: number }>;
    currentEventSeq: number;
  }>(`${baseUrl}/rooms`);
  assert.ok(
    (roomsBeforeRead.rooms.find((room) => room.id === "room-route-targeting")?.unread ?? 0) > 0,
    "server snapshots must expose real unread replies",
  );
  const markedRead = await postJson<{ room: { id: string; unread: number }; currentEventSeq: number }>(
    `${baseUrl}/rooms/room-route-targeting/read`,
    { observedEventSeq: roomsBeforeRead.currentEventSeq },
  );
  assert.equal(markedRead.room.unread, 0, "the public read-receipt route must clear the Room count");
  const roomsAfterRead = await getJson<{ rooms: Array<{ id: string; unread: number }> }>(`${baseUrl}/rooms`);
  assert.equal(
    roomsAfterRead.rooms.find((room) => room.id === "room-route-targeting")?.unread,
    0,
    "the cleared read receipt must survive into the next server snapshot",
  );

  const pmRouted = await postJson<{
    ok: true;
    userMessage: { targetIds: string[]; deliveryKind?: string };
    assistantMessages: Array<{ senderId: string; text: string; status: string }>;
  }>(`${baseUrl}/rooms/room-route-targeting/messages`, {
    text: "This group message has no mention and no explicit target.",
    targetIds: [],
    userMessageId: "message-user-no-target",
  });

  assert.equal(pmRouted.ok, true);
  assert.deepEqual(pmRouted.userMessage.targetIds, ["pm"]);
  assert.equal(pmRouted.userMessage.deliveryKind, "pm_auto_route");
  assert.equal(pmRouted.assistantMessages.length, 1);
  assert.equal(pmRouted.assistantMessages[0]?.senderId, "pm", JSON.stringify(pmRouted));

  const codex: RoomChannelMember = {
    id: "employee-visible-codex",
    name: "Codex",
    kernel: "codex",
    model: "manual",
    role: "codex collaborator",
    status: "idle",
    color: "#2563eb",
    lastActive: "now",
    source: "human",
  };
  const grove: RoomChannelMember = {
    id: "employee-route-grove",
    name: "Grove",
    kernel: "codex",
    model: "manual",
    role: "grove guide",
    status: "idle",
    color: "#168A53",
    lastActive: "now",
    source: "human",
  };
  const appCreator: RoomChannelMember = {
    id: "employee-route-app-creator",
    name: "App Creator",
    kernel: "codex",
    model: "manual",
    role: "app creator",
    status: "idle",
    color: "#7c3aed",
    lastActive: "now",
    source: "human",
  };

  await postJson(`${baseUrl}/rooms/members`, codex);
  await postJson(`${baseUrl}/rooms/members`, grove);
  await postJson(`${baseUrl}/rooms/members`, appCreator);
  await postJson(`${baseUrl}/rooms`, {
    id: "room-route-shared-kernel",
    title: "Shared kernel routing",
    memberIds: [codex.id, grove.id, appCreator.id],
    badge: "本地",
  });

  const codexMention = await postJson<{
    ok: true;
    userMessage: { targetIds: string[] };
    assistantMessages: Array<{ senderId: string; text: string; status: string }>;
  }>(`${baseUrl}/rooms/room-route-shared-kernel/messages`, {
    text: "@Codex 在吗",
    targetIds: [],
    userMessageId: "message-user-codex-mention",
    assistantMessageIds: ["message-assistant-codex-mention"],
  });

  assert.equal(codexMention.ok, true);
  assert.deepEqual(codexMention.userMessage.targetIds, [codex.id]);
  assert.equal(codexMention.assistantMessages.length, 1);
  assert.equal(codexMention.assistantMessages[0]?.senderId, codex.id);

  const explicitOverridesAll = await postJson<{
    ok: true;
    userMessage: { targetIds: string[] };
    assistantMessages: Array<{ senderId: string; text: string; status: string }>;
  }>(`${baseUrl}/rooms/room-route-shared-kernel/messages`, {
    text: "@所有人 但是只让 Codex 回复",
    targetIds: [codex.id],
    userMessageId: "message-user-explicit-overrides-all",
    assistantMessageIds: ["message-assistant-explicit-overrides-all"],
  });

  assert.equal(explicitOverridesAll.ok, true);
  assert.deepEqual(explicitOverridesAll.userMessage.targetIds, [codex.id]);
  assert.equal(explicitOverridesAll.assistantMessages.length, 1);
  assert.equal(explicitOverridesAll.assistantMessages[0]?.senderId, codex.id);

  const codexLongName: RoomChannelMember = {
    id: "employee-visible-codex-long",
    name: "CodexPlus",
    kernel: "codex",
    model: "manual",
    role: "long codex collaborator",
    status: "idle",
    color: "#0f766e",
    lastActive: "now",
    source: "human",
  };
  await postJson(`${baseUrl}/rooms/members`, codexLongName);
  await postJson(`${baseUrl}/rooms`, {
    id: "room-route-mention-boundary",
    title: "Mention boundary",
    memberIds: [codexLongName.id],
    badge: "本地",
  });

  const partialMention = await postJson<{
    ok: true;
    userMessage: { targetIds: string[]; deliveryKind?: string };
    assistantMessages: Array<{ senderId: string; text: string; status: string }>;
  }>(`${baseUrl}/rooms/room-route-mention-boundary/messages`, {
    text: "@Codex 在吗",
    targetIds: [],
    userMessageId: "message-user-partial-mention",
  });

  assert.equal(partialMention.ok, true);
  assert.deepEqual(partialMention.userMessage.targetIds, ["pm"]);
  assert.equal(partialMention.userMessage.deliveryKind, "pm_auto_route");
  assert.equal(partialMention.assistantMessages.length, 1);
  assert.equal(partialMention.assistantMessages[0]?.senderId, "pm");

  await postJson(`${baseUrl}/rooms`, {
    id: "room-route-shared-kernel-without-codex",
    title: "Shared kernel without Codex",
    memberIds: [grove.id, appCreator.id],
    badge: "本地",
  });

  const missingCodexMention = await postJson<{
    ok: true;
    userMessage: { targetIds: string[]; deliveryKind?: string };
    assistantMessages: Array<{ senderId: string; text: string; status: string }>;
  }>(`${baseUrl}/rooms/room-route-shared-kernel-without-codex/messages`, {
    text: "@Codex 在吗",
    targetIds: [],
    userMessageId: "message-user-missing-codex-mention",
  });

  assert.equal(missingCodexMention.ok, true);
  assert.deepEqual(missingCodexMention.userMessage.targetIds, ["pm"]);
  assert.equal(missingCodexMention.userMessage.deliveryKind, "pm_auto_route");
  assert.equal(missingCodexMention.assistantMessages.length, 1);
  assert.equal(missingCodexMention.assistantMessages[0]?.senderId, "pm");

  const activeRunRoomId = "room-active-run-archive-guard";
  await postJson(`${baseUrl}/rooms`, {
    id: activeRunRoomId,
    title: "Active run archive guard",
    memberIds: [codex.id],
    badge: "本地",
  });
  const activeRunMessage = await postJson<{ ok: true; message: { id: string }; currentEventSeq: number }>(
    `${baseUrl}/rooms/${activeRunRoomId}/agent-messages`,
    {
      senderId: codex.id,
      senderName: codex.name,
      text: "still running",
    },
  );
  await patchJson(`${baseUrl}/rooms/${activeRunRoomId}/messages/${activeRunMessage.message.id}`, {
    status: "running",
    runId: "room_run_archive_guard",
  });
  const patchEvents = await getJson<{
    events: Array<{ type: string; messageId?: string; schemaVersion?: number; payload: Record<string, unknown> }>;
  }>(`${baseUrl}/rooms/events?afterEventSeq=${activeRunMessage.currentEventSeq}&eventVersion=2`);
  const compactUpdate = patchEvents.events.find(
    (event) => event.type === "room.message.updated" && event.messageId === activeRunMessage.message.id,
  );
  assert.equal(compactUpdate?.schemaVersion, 2);
  assert.ok(compactUpdate?.payload.messagePatch);
  assert.equal(compactUpdate?.payload.message, undefined);
  const legacyEvents = await getJson<{
    events: Array<{ type: string; messageId?: string; payload: Record<string, unknown> }>;
  }>(`${baseUrl}/rooms/events?afterEventSeq=${activeRunMessage.currentEventSeq}`);
  const legacyUpdate = legacyEvents.events.find(
    (event) => event.type === "room.message.updated" && event.messageId === activeRunMessage.message.id,
  );
  assert.ok(
    legacyUpdate?.payload.message,
    "legacy clients must receive a materialized full message during compatibility",
  );

  const compatibilityMessage = await postJson<{ ok: true; message: { id: string }; currentEventSeq: number }>(
    `${baseUrl}/rooms/${activeRunRoomId}/agent-messages`,
    { senderId: codex.id, senderName: codex.name, text: "legacy delete compatibility" },
  );
  await patchJson(`${baseUrl}/rooms/${activeRunRoomId}/messages/${compatibilityMessage.message.id}`, {
    text: "updated before delete",
  });
  await deleteJson(`${baseUrl}/rooms/${activeRunRoomId}/messages/${compatibilityMessage.message.id}`);
  const legacyEventsAfterDelete = await getJson<{
    events: Array<{ type: string; messageId?: string; schemaVersion?: number; payload: Record<string, unknown> }>;
  }>(`${baseUrl}/rooms/events?afterEventSeq=${compatibilityMessage.currentEventSeq}`);
  assert.equal(
    legacyEventsAfterDelete.events.some(
      (event) => event.type === "room.message.updated" && event.messageId === compatibilityMessage.message.id,
    ),
    false,
    "legacy clients must not receive a v2 patch after its message has already been deleted",
  );
  assert.equal(
    legacyEventsAfterDelete.events.some(
      (event) => event.type === "room.message.deleted" && event.messageId === compatibilityMessage.message.id,
    ),
    true,
    "the superseding delete event must still reach legacy clients",
  );
  const blockedArchive = await patchJson(`${baseUrl}/rooms/${activeRunRoomId}`, { archived: true });
  assert.equal(blockedArchive.response.status, 409);
  assert.equal((blockedArchive.json as { error?: string }).error, "room_has_active_runs");
  const roomsAfterBlockedArchive = await getJson<{ rooms: Array<{ id: string; archived?: boolean }> }>(
    `${baseUrl}/rooms`,
  );
  assert.equal(roomsAfterBlockedArchive.rooms.find((room) => room.id === activeRunRoomId)?.archived, false);

  const firstEvents = await getJson<{
    ok: true;
    currentEventSeq: number;
    hasMore: boolean;
    events: Array<{ eventSeq: number }>;
    longPollSupported: boolean;
  }>(`${baseUrl}/rooms/events?afterEventSeq=0&limit=1`);
  assert.equal(firstEvents.ok, true);
  assert.equal(firstEvents.longPollSupported, true);
  assert.equal(firstEvents.events.length, 1);
  assert.equal(firstEvents.currentEventSeq, firstEvents.events[0]?.eventSeq);
  assert.equal(firstEvents.hasMore, true);

  const beforeLongPoll = await getJson<{ currentEventSeq: number }>(`${baseUrl}/rooms`);
  const longPollStartedAt = Date.now();
  const longPollPromise = getJson<{
    ok: true;
    events: Array<{ type: string; roomId: string }>;
    currentEventSeq: number;
    longPollSupported: boolean;
  }>(`${baseUrl}/rooms/events?afterEventSeq=${beforeLongPoll.currentEventSeq}&limit=200&eventVersion=2&waitMs=2000`);
  await delay(75);
  await postJson(`${baseUrl}/rooms`, {
    id: "room-long-poll-notification",
    title: "Long poll notification",
    memberIds: [codex.id],
    badge: "本地",
  });
  const longPollEvents = await longPollPromise;
  const longPollElapsedMs = Date.now() - longPollStartedAt;
  assert.equal(longPollEvents.longPollSupported, true);
  assert.ok(longPollElapsedMs >= 50, `long poll returned before an event was available (${longPollElapsedMs} ms)`);
  assert.ok(longPollElapsedMs < 1_000, `long poll did not wake promptly after an event (${longPollElapsedMs} ms)`);
  assert.ok(
    longPollEvents.events.some((event) => event.roomId === "room-long-poll-notification"),
    "long poll must return the event that woke it",
  );

  const idleLongPollStartedAt = Date.now();
  const idleLongPoll = await getJson<{ events: unknown[] }>(
    `${baseUrl}/rooms/events?afterEventSeq=${longPollEvents.currentEventSeq}&limit=200&eventVersion=2&waitMs=100`,
  );
  const idleLongPollElapsedMs = Date.now() - idleLongPollStartedAt;
  assert.deepEqual(idleLongPoll.events, []);
  assert.ok(idleLongPollElapsedMs >= 75, `idle long poll did not honor its timeout (${idleLongPollElapsedMs} ms)`);
  assert.ok(idleLongPollElapsedMs < 1_000, `idle long poll exceeded its timeout budget (${idleLongPollElapsedMs} ms)`);

  const storageStats = await getJson<{
    ok: true;
    stats: { kind: string; databaseBytes: number; categories: Array<{ collection: string }> };
    overview: {
      totalBytes: number;
      categories: Array<{ id: string; bytes: number }>;
      locations: Array<{ id: string; path: string; movable: boolean }>;
    };
  }>(`${baseUrl}/settings/storage`);
  assert.equal(storageStats.stats.kind, "sqlite");
  assert.ok(storageStats.stats.databaseBytes > 0);
  assert.ok(storageStats.stats.categories.some((category) => category.collection === "room_events"));
  assert.ok(storageStats.overview.totalBytes >= storageStats.stats.databaseBytes);
  assert.deepEqual(
    storageStats.overview.categories.map((category) => category.id),
    ["apps-and-workspaces", "conversations-and-system", "rebuildable", "backups", "other"],
  );
  assert.equal(storageStats.overview.locations.find((location) => location.id === "apps")?.movable, true);
  const cacheCleanup = await postJson<{ ok: true; scope: string }>(`${baseUrl}/settings/storage/clear-history`, {
    scope: "rebuildable-caches",
  });
  assert.equal(cacheCleanup.scope, "rebuildable-caches");
  const roomArchiveCleanup = await postJson<{ ok: true; scope: string; removed: number }>(
    `${baseUrl}/settings/storage/clear-history`,
    { scope: "room-event-archive" },
  );
  assert.equal(roomArchiveCleanup.scope, "room-event-archive");
  assert.ok(roomArchiveCleanup.removed >= 0);

  await runForgotMentionPmDispatchHarness();

  console.log("rooms-route-targeting-harness ok");
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousClaudeRuntime === undefined) {
    delete process.env[claudeRuntimeEnvName];
  } else {
    process.env[claudeRuntimeEnvName] = previousClaudeRuntime;
  }
  if (previousClaudeCliPath === undefined) {
    delete process.env[claudeCliPathEnvName];
  } else {
    process.env[claudeCliPathEnvName] = previousClaudeCliPath;
  }
  if (previousAnthropicApiKey === undefined) {
    delete process.env[anthropicApiKeyEnvName];
  } else {
    process.env[anthropicApiKeyEnvName] = previousAnthropicApiKey;
  }
  rmSync(dir, { recursive: true, force: true });
}

async function postJson<T = { ok?: boolean }>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opengrove-token": token,
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as T;
  assert.equal(response.ok, true, `${url} failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function requestJson(
  url: string,
  input: { method: "POST" | "DELETE"; body?: unknown },
): Promise<{ response: Response; json: unknown }> {
  const response = await fetch(url, {
    method: input.method,
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      "x-opengrove-token": token,
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  return { response, json: await response.json() };
}

async function getJson<T = { ok?: boolean }>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "x-opengrove-token": token,
    },
  });
  const json = (await response.json()) as T;
  assert.equal(response.ok, true, `${url} failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function patchJson(url: string, body: unknown): Promise<{ response: Response; json: unknown }> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-opengrove-token": token,
    },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

async function deleteJson<T = { ok?: boolean }>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "x-opengrove-token": token },
  });
  const json = (await response.json()) as T;
  assert.equal(response.ok, true, `${url} failed with HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function runForgotMentionPmDispatchHarness(): Promise<void> {
  const routeDir = mkdtempSync(join(tmpdir(), "opengrove-rooms-route-pm-dispatch-"));
  const appId = "route.pm.app";
  const appRoot = join(routeDir, "mounted-app");
  const workerId = "member-app-route.pm.app-copywriter";
  const doctorMarker = join(routeDir, "doctor-ran");
  mkdirSync(join(appRoot, "bin"), { recursive: true });
  writeFileSync(
    join(appRoot, "bin", "script-source-feishu.js"),
    `#!/usr/bin/env node\nif (process.argv[2] === "doctor") require("node:fs").writeFileSync(${JSON.stringify(doctorMarker)}, "ran");\n`,
    "utf8",
  );
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify({
      id: appId,
      title: "Route PM App",
      capabilities: {
        cli: [
          {
            id: "script-source-feishu",
            command: "node",
            args: ["bin/script-source-feishu.js"],
            doctor: ["doctor"],
            env: ["CREATIVE_FEISHU_APP_ID", "CREATIVE_FEISHU_APP_SECRET"],
            employees: ["copywriter"],
          },
        ],
      },
    }),
    "utf8",
  );
  const stateHolder: { value?: ReturnType<typeof createBridgeState> } = {};
  try {
    const state = createBridgeState({ statePath: join(routeDir, "state.json") });
    stateHolder.value = state;
    state.settings.languagePreference = "en";
    state.settings.mountedApps.push({ id: appId, title: "Route PM App", path: appRoot, enabled: true });
    assert.ok(state.kernelCapabilities);
    state.kernelCapabilities = { ...state.kernelCapabilities, hostTools: true };
    state.settings.kernelPathOverrides[state.kernel] = { binaryPath: process.execPath };
    state.settings.customProviders.push({
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai-compatible",
      openaiBaseUrl: "https://api.deepseek.example/v1",
      apiKey: "test-deepseek-key",
      credentialKind: "api-key",
      models: [{ id: "manual", label: "Manual" }],
    });
    const harnessKernel = state.kernel;
    const worker: RoomChannelMember = {
      id: workerId,
      name: "世界观设定师",
      kernel: harnessKernel,
      model: "manual",
      providerId: "deepseek",
      role: "INTERNAL_WORLD_BUILDER_ROLE\nApp workspace: /private/world-builder",
      publicDescription: "负责世界观设定",
      status: "idle",
      color: "#0f766e",
      lastActive: "now",
      source: "local",
      appId,
      workspaceRoot: routeDir,
    };
    const pm: RoomChannelMember = {
      id: pmAgentMemberId(appId),
      employeeDefinitionId: "pm",
      name: "Route PM",
      kernel: harnessKernel,
      model: "manual",
      providerId: "deepseek",
      role: "PM test employee",
      status: "idle",
      color: "#1d4ed8",
      lastActive: "now",
      source: "local",
      appId,
      workspaceRoot: routeDir,
      defaultSkillIds: ["pm-planner"],
    };
    const scopedAppId = "story-seed";
    const scopedWorker: RoomChannelMember = {
      id: "member-user-test-member-app-story-seed-writer",
      name: "故事架构师",
      kernel: harnessKernel,
      model: "manual",
      providerId: "deepseek",
      role: "INTERNAL_STORY_ARCHITECT_ROLE\nWorkspace scope: /private/story-architect",
      publicDescription: "负责故事架构",
      status: "idle",
      color: "#16a34a",
      lastActive: "now",
      source: "local",
      appId: scopedAppId,
      workspaceRoot: routeDir,
    };
    const scopedPm: RoomChannelMember = {
      id: "member-user-test-member-app-story-seed-pm",
      employeeDefinitionId: "pm",
      name: "故事种子 PM",
      kernel: harnessKernel,
      model: "manual",
      providerId: "deepseek",
      role: "Scoped PM test employee",
      status: "idle",
      color: "#2563eb",
      lastActive: "now",
      source: "local",
      appId: scopedAppId,
      workspaceRoot: routeDir,
      // 旧数据或用户覆盖可能清空默认技能；规范作用域 PM ID 仍必须获得 PM 路由基座。
    };
    state.app.rooms.upsertMember(worker);
    state.app.rooms.upsertMember(pm);
    state.app.rooms.upsertMember(scopedWorker);
    state.app.rooms.upsertMember(scopedPm);
    const roomId = "room-route-forgot-mention-pm";
    state.app.rooms.ensureGroupRoom({
      id: roomId,
      title: "PM dispatch",
      badge: "App",
      memberIds: [worker.id, pm.id],
    });
    const scopedRoomId = "room-route-forgot-mention-scoped-pm";
    state.app.rooms.ensureGroupRoom({
      id: scopedRoomId,
      title: "Scoped PM dispatch",
      badge: "故事种子",
      memberIds: [scopedWorker.id, scopedPm.id],
    });

    const runInputs: Array<{
      input: string;
      hostContext: string;
      sessionInstructions: string;
      requiredSkillNames: string[];
    }> = [];
    const harnessExecutionState = roomExecutionState(state, worker);
    const harnessAdapter = harnessExecutionState.kernelAdapter;
    assert.ok(harnessAdapter, "the route harness needs one reusable Kernel worker seam");
    harnessAdapter.runTurn = async function* runFakeRoomTurn(turn): AsyncIterable<AgentEvent> {
      const input = turn.input;
      const runId = turn.runId ?? `fake-run-${runInputs.length}`;
      const hostContext = turn.assembledContext?.promptBlock ?? "";
      const sessionInstructions = turn.sessionInstructions ?? "";
      runInputs.push({
        input,
        hostContext,
        sessionInstructions,
        requiredSkillNames: [
          ...(turn.requiredSkills ?? []).map((skill) => skill.manifest.name),
          ...(turn.requiredSkillRequirements ?? []).map(
            (requirement) => requirement.manifest?.name ?? requirement.configuredName,
          ),
        ],
      });
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      if (sessionInstructions.includes("PM 自动路由模式") || sessionInstructions.includes("PM auto-routing mode")) {
        const isScopedPrompt = input.includes("故事架构师在吗");
        const delegatedTargetId = isScopedPrompt ? scopedWorker.id : worker.id;
        assert.match(input, isScopedPrompt ? /故事架构师在吗/ : /世界观设定师在吗/);
        const tool = state.app.tools.require("room.delegate.task");
        const delegated = await tool.execute(
          {
            targetMemberId: delegatedTargetId,
          },
          { runId } as never,
        );
        assert.equal(delegated.ok, true, delegated.error);
        yield {
          type: "model.response",
          runId,
          response: { text: `已帮你转给 @${isScopedPrompt ? "故事架构师" : "世界观设定师"}` },
        };
      } else if (input.includes("世界观设定师在吗")) {
        assert.match(input, /\[Current message #\d+\][\s\S]*<current-message>\n世界观设定师在吗\n<\/current-message>$/);
        yield { type: "model.response", runId, response: { text: "在，我是世界观设定师。" } };
      } else if (input.includes("故事架构师在吗")) {
        assert.match(input, /\[Current message #\d+\][\s\S]*<current-message>\n故事架构师在吗\n<\/current-message>$/);
        yield { type: "model.response", runId, response: { text: "在，我是故事架构师。" } };
      } else {
        yield { type: "error", runId, message: `unexpected_input:${input}` } as AgentEvent;
      }
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    };

    const dispatched = await postRoomMessageRoute<{
      ok: true;
      userMessage: { text: string; targetIds: string[]; selectedFile?: { path: string } };
      assistantMessages: Array<{ senderId: string; text: string; status: string }>;
    }>(state, roomId, {
      text: "世界观设定师在吗",
      targetIds: [],
      appContextText: "LEGACY_MOUNTED_CONTEXT_ONE",
      selectedFile: { path: "" },
      userMessageId: "message-user-forgot-pm",
      assistantMessageIds: ["message-assistant-forgot-pm"],
    });

    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.userMessage.text, "世界观设定师在吗");
    assert.deepEqual(dispatched.userMessage.targetIds, [pm.id]);
    assert.equal(
      dispatched.userMessage.selectedFile,
      undefined,
      "an empty selectedFile must not be written into message facts",
    );
    assert.equal(dispatched.assistantMessages.length, 1);
    assert.equal(dispatched.assistantMessages[0]?.senderId, pm.id);
    assert.doesNotMatch(dispatched.assistantMessages[0]?.text ?? "", /@员工|@所有人/);

    await waitFor(() => {
      const messages = state.app.rooms.listMessages(roomId, { limit: 20 });
      return messages.some(
        (message) =>
          message.senderId === pm.id && message.status === "done" && message.text === "已帮你转给 @世界观设定师",
      );
    }, "PM forgot-mention final reply");

    await waitFor(() => {
      const messages = state.app.rooms.listMessages(roomId, { limit: 20 });
      return messages.some((message) => message.senderId === worker.id && message.text === "在，我是世界观设定师。");
    }, "PM delegate target reply");

    assert.ok(
      runInputs.some(
        ({ sessionInstructions }) =>
          sessionInstructions.includes("PM 自动路由模式") || sessionInstructions.includes("PM auto-routing mode"),
      ),
      "PM run should receive the minimal auto-routing prompt in stable session instructions",
    );
    assert.ok(
      runInputs.some(
        ({ input, sessionInstructions }) =>
          !sessionInstructions.includes("PM auto-routing mode") &&
          /\[Current message #\d+\][\s\S]*<current-message>\n世界观设定师在吗\n<\/current-message>$/.test(input),
      ),
      "delegated worker should receive the author's numbered original message",
    );
    const delegatedWorkerRun = runInputs.find(
      ({ input, sessionInstructions }) =>
        !sessionInstructions.includes("PM auto-routing mode") &&
        /\[Current message #\d+\][\s\S]*<current-message>\n世界观设定师在吗\n<\/current-message>$/.test(input),
    );
    assert.match(
      delegatedWorkerRun?.hostContext ?? "",
      /script-source-feishu[\s\S]*CREATIVE_FEISHU_APP_ID[\s\S]*CREATIVE_FEISHU_APP_SECRET/,
      "a missing App CLI configuration should be visible to the Employee without blocking its Run",
    );
    assert.match(
      delegatedWorkerRun?.hostContext ?? "",
      /call it and handle the tool result/i,
      "the Host should let the Employee execute the CLI and handle its actual tool result",
    );
    assert.equal(
      existsSync(doctorMarker),
      false,
      "an Employee Run should report missing injections without executing or injecting App doctor output",
    );
    const pmRoutingRun = runInputs.find(
      ({ sessionInstructions }) =>
        sessionInstructions.includes("PM 自动路由模式") || sessionInstructions.includes("PM auto-routing mode"),
    );
    assert.deepEqual(
      pmRoutingRun?.requiredSkillNames,
      [],
      "PM auto-routing must not load pm-planner or App default Skills",
    );
    assert.match(pmRoutingRun?.hostContext ?? "", /负责世界观设定/);
    assert.doesNotMatch(
      `${pmRoutingRun?.hostContext ?? ""}\n${pmRoutingRun?.sessionInstructions ?? ""}`,
      /INTERNAL_WORLD_BUILDER_ROLE|\/private\/world-builder/,
    );
    const messages = state.app.rooms.listMessages(roomId, { limit: 20 });
    assert.equal(
      messages.some(
        (message) =>
          message.senderId === pm.id &&
          message.senderType === "agent" &&
          message.targetIds.includes(worker.id) &&
          message.text.includes("世界观设定师在吗"),
      ),
      true,
      "PM delegation must leave a real visible targeted message",
    );
    assert.equal(
      messages.some(
        (message) =>
          message.senderType === "user" && message.targetIds.includes(worker.id) && message.text === "世界观设定师在吗",
      ),
      false,
      "PM delegation should not masquerade as a user-authored message",
    );
    assert.equal(
      messages.some((message) => message.senderType === "user" && /04-|05-|产物|项目/.test(message.text)),
      false,
      "PM should not expand the user's original text into a task brief",
    );
    assert.equal(
      messages.some((message) => message.text.includes("PM 未提及消息路由规则")),
      false,
      "stable PM routing rules must not be persisted as ordinary message text",
    );

    const scopedDispatched = await postRoomMessageRoute<{
      ok: true;
      userMessage: { targetIds: string[] };
      assistantMessages: Array<{ senderId: string; text: string; status: string }>;
    }>(state, scopedRoomId, {
      text: "故事架构师在吗",
      targetIds: [],
      appContextText: "LEGACY_MOUNTED_CONTEXT_TWO",
      userMessageId: "message-user-forgot-scoped-pm",
      assistantMessageIds: ["message-assistant-forgot-scoped-pm"],
    });

    assert.equal(scopedDispatched.ok, true);
    assert.deepEqual(scopedDispatched.userMessage.targetIds, [scopedPm.id]);
    assert.equal(scopedDispatched.assistantMessages.length, 1);
    assert.equal(scopedDispatched.assistantMessages[0]?.senderId, scopedPm.id);
    assert.doesNotMatch(scopedDispatched.assistantMessages[0]?.text ?? "", /@员工|@所有人/);

    await waitFor(() => {
      const scopedMessages = state.app.rooms.listMessages(scopedRoomId, { limit: 20 });
      return scopedMessages.some(
        (message) =>
          message.senderId === scopedPm.id && message.status === "done" && message.text === "已帮你转给 @故事架构师",
      );
    }, "scoped PM forgot-mention final reply");

    await waitFor(() => {
      const scopedMessages = state.app.rooms.listMessages(scopedRoomId, { limit: 20 });
      return scopedMessages.some(
        (message) => message.senderId === scopedWorker.id && message.text === "在，我是故事架构师。",
      );
    }, "scoped PM delegate target reply");

    assert.equal(
      runInputs.some(
        ({ input, hostContext }) =>
          /LEGACY_MOUNTED_CONTEXT_(ONE|TWO)/.test(input) || /LEGACY_MOUNTED_CONTEXT_(ONE|TWO)/.test(hostContext),
      ),
      false,
      "legacy-client appContextText must be ignored by the server across consecutive turns and must not enter the A/B/C Envelope",
    );

    const nonAdminRoomId = "room-route-pm-not-admin";
    state.app.rooms.ensureGroupRoom({
      id: nonAdminRoomId,
      title: "PM not admin",
      badge: "App",
      memberIds: [worker.id, pm.id],
      adminMemberIds: [worker.id],
    });
    const runsBeforeNonAdminRoute = runInputs.length;
    const nonAdminRoute = await postRoomMessageRoute<{
      ok: true;
      assistantMessages: Array<{ senderId: string; text: string; status: string }>;
    }>(state, nonAdminRoomId, {
      text: "请自动分配这条消息",
      targetIds: [],
      userMessageId: "message-user-pm-not-admin",
    });
    assert.equal(nonAdminRoute.assistantMessages[0]?.senderId, "system");
    assert.equal(nonAdminRoute.assistantMessages[0]?.status, "done");
    assert.match(nonAdminRoute.assistantMessages[0]?.text ?? "", /无法自动转交|cannot auto-route/i);
    assert.equal(
      runInputs.length,
      runsBeforeNonAdminRoute,
      "a non-admin PM must not start an auto-routing turn it cannot complete",
    );

    const noToolsPm: RoomChannelMember = {
      ...pm,
      id: "member-app-route.no-tools-pm",
      kernel: "hermes",
      appId: "route.no-tools",
    };
    const noToolsWorker: RoomChannelMember = {
      ...worker,
      id: "member-app-route.no-tools-worker",
      appId: "route.no-tools",
    };
    state.app.rooms.upsertMember(noToolsPm);
    state.app.rooms.upsertMember(noToolsWorker);
    const noToolsRoomId = "room-route-pm-without-host-tools";
    state.app.rooms.ensureGroupRoom({
      id: noToolsRoomId,
      title: "PM without Host Tools",
      badge: "App",
      memberIds: [noToolsWorker.id, noToolsPm.id],
      adminMemberIds: [noToolsPm.id],
    });
    const originalLoadInto = state.store.loadInto.bind(state.store);
    let routeGateStateReloads = 0;
    state.store.loadInto = (app) => {
      routeGateStateReloads += 1;
      return originalLoadInto(app);
    };
    let noToolsRoute: {
      ok: true;
      assistantMessages: Array<{ senderId: string; text: string; status: string }>;
    };
    try {
      noToolsRoute = await postRoomMessageRoute(state, noToolsRoomId, {
        text: "请把这条消息自动分配出去",
        targetIds: [],
        userMessageId: "message-user-pm-without-host-tools",
      });
    } finally {
      state.store.loadInto = originalLoadInto;
    }
    assert.equal(routeGateStateReloads, 0, "the PM routing gate must not reload the full Bridge/App state");
    assert.equal(noToolsRoute.assistantMessages[0]?.senderId, "system");
    assert.equal(noToolsRoute.assistantMessages[0]?.status, "done");
    assert.match(noToolsRoute.assistantMessages[0]?.text ?? "", /无法自动转交|cannot auto-route/i);

    const noPmWorker: RoomChannelMember = {
      id: "member-app-route.no-pm.worker",
      name: "No PM Worker",
      kernel: harnessKernel,
      model: "manual",
      role: "worker without PM",
      status: "idle",
      color: "#7c3aed",
      lastActive: "now",
      source: "local",
      appId: "route.no.pm",
    };
    state.app.rooms.upsertMember(noPmWorker);
    const noPmRoomId = "room-route-forgot-mention-no-pm";
    state.app.rooms.ensureGroupRoom({
      id: noPmRoomId,
      title: "No PM",
      badge: "App",
      memberIds: [noPmWorker.id],
    });
    const noPm = await postRoomMessageRoute<{
      ok: true;
      userMessage: { targetIds: string[] };
      assistantMessages: Array<{ senderId: string; text: string; status: string }>;
    }>(state, noPmRoomId, {
      text: "这条消息没有 PM 可接。",
      targetIds: [],
      userMessageId: "message-user-forgot-no-pm",
    });

    assert.equal(noPm.ok, true);
    assert.deepEqual(noPm.userMessage.targetIds, ["pm"]);
    assert.equal(noPm.assistantMessages.length, 1);
    assert.equal(noPm.assistantMessages[0]?.senderId, "pm");
  } finally {
    await stateHolder.value?.store.close?.();
    rmSync(routeDir, { recursive: true, force: true });
  }
}

async function postRoomMessageRoute<T>(
  state: ReturnType<typeof createBridgeState>,
  roomId: string,
  body: unknown,
): Promise<T> {
  let status = 0;
  let payload: unknown;
  const handled = await dispatchBridgeRoutes(
    [operationRoute(hostContractById["room.message.create"], handleCreateRoomMessageOperation)],
    {
      request: {
        method: "POST",
        headers: { host: "127.0.0.1" },
      } as IncomingMessage,
      response: {} as ServerResponse,
      url: new URL(`http://127.0.0.1/rooms/${encodeURIComponent(roomId)}/messages`),
      traceId: "rooms-route-targeting",
      state,
      security: {} as BridgeRouteContext["security"],
      sendJson: (_response, nextStatus, data) => {
        status = nextStatus;
        payload = data;
      },
      readJsonBody: async () => body,
    },
  );
  assert.equal(handled, true);
  assert.equal(status, 200, JSON.stringify(payload));
  return payload as T;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let index = 0; index < 250; index += 1) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
