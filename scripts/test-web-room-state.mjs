import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-room-state-"));
const entryPath = join(tempDir, "entry.mjs");
const bundlePath = join(tempDir, "bundle.cjs");
const roomMessageContractPath = join(tempDir, "room-message-contract.ts");
const roomsApiImport = join(projectRoot, "web", "src", "components", "rooms", "rooms-api.ts");
const roomsServerSyncImport = join(projectRoot, "web", "src", "components", "rooms", "rooms-server-sync.ts");
const roomReadReceiptsImport = join(projectRoot, "web", "src", "components", "rooms", "room-read-receipts.ts");
const roomsModelImport = join(projectRoot, "web", "src", "components", "rooms", "rooms-model.ts");
const roomChatUtilsImport = join(projectRoot, "web", "src", "components", "rooms", "room-chat-utils.ts");
const messagesImport = join(projectRoot, "web", "src", "messages.ts");
const activityModelImport = join(projectRoot, "web", "src", "components", "chat", "message-activity-model.ts");
const agentStatePresentationImport = join(
  projectRoot,
  "web",
  "src",
  "components",
  "chat",
  "agent-state-presentation.ts",
);
const assistantRunViewModelImport = join(
  projectRoot,
  "web",
  "src",
  "components",
  "chat",
  "assistant-run-view-model.ts",
);
const messageActivityImport = join(projectRoot, "web", "src", "components", "chat", "message-activity.tsx");
const messageListImport = join(projectRoot, "web", "src", "components", "chat", "message-list.tsx");
const roomStreamImport = join(projectRoot, "web", "src", "components", "rooms", "room-message-stream.tsx");
const confirmDialogImport = join(projectRoot, "web", "src", "components", "ui", "confirm-dialog.tsx");
const roomComposerImport = join(projectRoot, "web", "src", "components", "rooms", "room-composer.tsx");
const roomMessageModelImport = join(projectRoot, "web", "src", "components", "rooms", "room-message-model.ts");
const roomSidebarImport = join(projectRoot, "web", "src", "components", "rooms", "room-sidebar.tsx");
const unreadCountImport = join(projectRoot, "web", "src", "components", "ui", "unread-count.tsx");
const roomMessageActionsImport = join(projectRoot, "web", "src", "components", "rooms", "rooms-message-actions.ts");
const roomMessageHydrationImport = join(projectRoot, "web", "src", "components", "rooms", "room-message-hydration.ts");
const contactsModelImport = join(projectRoot, "web", "src", "components", "rooms", "contacts-model.ts");
const employeeDialogImport = join(projectRoot, "web", "src", "components", "rooms", "employee-dialog.tsx");
const avatarDataUrlImport = join(projectRoot, "src", "rooms", "avatar-data-url.ts");
const mountedAppChatPanelImport = join(projectRoot, "web", "src", "components", "apps", "mounted-app-chat-panel.tsx");
const uiModelImport = join(projectRoot, "web", "src", "runtime", "ui-model.ts");
const agentEventSyncImport = join(projectRoot, "web", "src", "runtime", "agent-event-sync.ts");
const storeImport = join(projectRoot, "web", "src", "store.ts");
const appSourcePath = join(projectRoot, "web", "src", "app.tsx");
const appMainViewsSourcePath = join(projectRoot, "web", "src", "components", "app-shell", "app-main-views.tsx");
const mountedAppChatPanelSourcePath = join(
  projectRoot,
  "web",
  "src",
  "components",
  "apps",
  "mounted-app-chat-panel.tsx",
);
const roomsViewSourcePath = join(projectRoot, "web", "src", "components", "rooms", "rooms-view.tsx");

await writeFile(
  roomMessageContractPath,
  `
  import type { RoomMessage } from ${JSON.stringify(roomsModelImport)};

  const message: RoomMessage = {
    id: "message-contract",
    senderId: "employee-writer",
    senderName: "故事架构师",
    senderType: "agent",
    text: "@金牌编辑 请审核章节大纲",
    targetIds: ["employee-editor"],
    status: "sent",
    createdAt: "2026-07-11T00:00:00.000Z",
    deliveryKind: "agent_delegation",
    inReplyToMessageId: "message-user-root",
    rootMessageId: "message-user-root",
    selectedFile: { path: "项目/长安客/章节大纲.md" },
  };

  void message;
`,
  "utf8",
);

await writeFile(
  entryPath,
  `
  import assert from "node:assert/strict";
  import React from "react";
  import { renderToStaticMarkup } from "react-dom/server";
  import { applyRoomEvents, markServerRoomRead, mergeRoomsFromServerSnapshot, postServerRoomMessage, postServerRoomMessageWithReplyFallback, replaceRoomsFromServerSnapshot } from ${JSON.stringify(roomsApiImport)};
  import { reconcileDeletedRoomMemberIds } from ${JSON.stringify(roomsServerSyncImport)};
  import { createRoomReadReceiptQueue } from ${JSON.stringify(roomReadReceiptsImport)};
  import { appScopedGroupUnreadCount, dedupeRoomMembers, directRoomMember, harmonizeRoomMemberAvatars, projectRoomMemberIdentity, resolveVisibleRoomFocus, selectableKernelOptions, visibleRoomUnreadCount } from ${JSON.stringify(roomsModelImport)};
  import { agentAuthorMention, draftWithAuthorMention, resolveAutomaticPmTarget, resolveRoomTargets, roomMentionToken } from ${JSON.stringify(roomChatUtilsImport)};
  import { applyApprovalResultToMessages, applyQuestionResultToMessages, applyStreamEventToMessage, finalizeAssistantMessage, normalizeMessagePartsForDisplay } from ${JSON.stringify(messagesImport)};
  import { activityItemDetailDisplay, activityItemKind, activityItemTitle, activityItemTitleTooltip, artifactCardsFromItem, buildActivityItems, buildActivityRenderNodes, editDiffFromItem, summarizeActivityItems } from ${JSON.stringify(activityModelImport)};
  import { agentOrbStateFromRun } from ${JSON.stringify(agentStatePresentationImport)};
  import { isNativeAgentCommentaryNote, processGroupsToActivityEntries, splitAssistantPartsForSurface } from ${JSON.stringify(assistantRunViewModelImport)};
  import { AssistantProcessBlock, choiceFormFromItem } from ${JSON.stringify(messageActivityImport)};
  import { MessageList } from ${JSON.stringify(messageListImport)};
  import { findActiveRoomChoiceForm, roomDisplayParts, RoomMessageStream as RawRoomMessageStream } from ${JSON.stringify(roomStreamImport)};
  import { ConfirmProvider } from ${JSON.stringify(confirmDialogImport)};
  import { RoomComposer } from ${JSON.stringify(roomComposerImport)};
  import { roomReplyPreview } from ${JSON.stringify(roomMessageModelImport)};
  import { resolveRoomSendTargets, sendRoomText } from ${JSON.stringify(roomMessageActionsImport)};
  import { RoomSidebar } from ${JSON.stringify(roomSidebarImport)};
  import { UnreadCount, UnreadCountAnchor, formatUnreadCount } from ${JSON.stringify(unreadCountImport)};
  import { mergeHydratedRoomMessages } from ${JSON.stringify(roomMessageHydrationImport)};
  import { APP_EMPLOYEE_OVERRIDE_FIELD_ITEMS, appEmployeeOverrideFields, appEmployeeOverrideItems, buildContactSkillOptions, canEditEmployeeRuntime, contactKernelSubline, effectiveMemberAvailableSkillIds, effectiveMemberSkillIds, visibleEmployeeDefinitions } from ${JSON.stringify(contactsModelImport)};
  import { canSubmitDraft, createDefaultDraft, createMemberFromDraft } from ${JSON.stringify(employeeDialogImport)};
  import { ROOM_MEMBER_AVATAR_MAX_BYTES } from ${JSON.stringify(avatarDataUrlImport)};
  import { applyMountedAppEmployeeDefaults, canArchiveMountedAppGroup, filterMountedAppSharedMembers, restorableMountedAppMembers, restoreMountedAppMember, shouldEnsureMountedAppDefaultGroup } from ${JSON.stringify(mountedAppChatPanelImport)};
  import { latestContextUsage } from ${JSON.stringify(uiModelImport)};
  import { mergeAgentEventPage } from ${JSON.stringify(agentEventSyncImport)};
  import { useUiStore } from ${JSON.stringify(storeImport)};

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      _goober: { firstChild: { data: "" }, parentNode: {} },
      addEventListener: () => {},
      localStorage: { getItem: () => "en" },
      location: { search: "" },
      navigator: { language: "en", languages: ["en"] },
      removeEventListener: () => {},
    },
  });

  const RoomMessageStream = (props) => React.createElement(
    ConfirmProvider,
    null,
    React.createElement(RawRoomMessageStream, props),
  );

  assert.equal(formatUnreadCount(0), null, "zero unread items must not render a badge");
  assert.equal(formatUnreadCount(1), "1", "single-digit unread counts must remain exact");
  assert.equal(formatUnreadCount(99), "99", "two-digit unread counts must remain exact");
  assert.equal(formatUnreadCount(100), "99+", "three-digit unread counts must use the compact cap");
  assert.equal(renderToStaticMarkup(React.createElement(UnreadCount, { count: 0 })), "");
  assert.match(renderToStaticMarkup(React.createElement(UnreadCount, { count: 100 })), />99\\+<\\/span>/);
  assert.match(
    renderToStaticMarkup(
      React.createElement(
        UnreadCountAnchor,
        { count: 7 },
        React.createElement("svg", { "aria-hidden": "true" }),
      ),
    ),
    /<svg aria-hidden="true"><\\/svg>.*>7<\\/span>/,
    "icon badges must keep the icon and numeric badge in one positioning anchor",
  );
  assert.equal(
    visibleRoomUnreadCount([
      { unread: 4 },
      { unread: 3, scope: { kind: "app", appId: "writer" } },
      { unread: 8 },
    ]),
    12,
    "the AppRail aggregate must include only the rooms shown by the native Rooms view",
  );
  assert.equal(
    appScopedGroupUnreadCount(
      [
        { kind: "group", unread: 6, scope: { kind: "app", appId: "writer" } },
        { kind: "group", unread: 3, scope: { kind: "app", appId: "other" } },
        { kind: "direct", unread: 2, scope: { kind: "app", appId: "writer" } },
        { kind: "group", unread: 9 },
      ],
      "writer",
    ),
    6,
    "a mounted App icon must aggregate only its visible App-scoped group rooms",
  );

  const createdAt = "2026-06-02T00:00:00.000Z";
  assert.deepEqual(
    reconcileDeletedRoomMemberIds(
      ["member-app-demo-writer", "missing-member"],
      [{ id: "member-app-demo-writer", disabled: false }],
    ),
    ["missing-member"],
    "reactivating an App employee must clear its stale frontend deletion tombstone",
  );
  assert.deepEqual(
    reconcileDeletedRoomMemberIds([], [{ id: "member-app-demo-editor", disabled: true }]),
    ["member-app-demo-editor"],
    "disabled App employees remain hidden",
  );
  const hydratedMessages = mergeHydratedRoomMessages({
    serverMessages: [{
      id: "server-existing",
      senderId: "user",
      senderName: "User",
      senderType: "user",
      text: "saved",
      targetIds: [],
      status: "sent",
      createdAt,
    }],
    currentMessages: [{
      id: "local-after-request",
      senderId: "user",
      senderName: "User",
      senderType: "user",
      text: "optimistic",
      targetIds: [],
      status: "sent",
      createdAt: "1970-01-01T00:00:00.000Z",
    }, {
      id: "stale-before-request",
      senderId: "user",
      senderName: "User",
      senderType: "user",
      text: "stale",
      targetIds: [],
      status: "sent",
      createdAt,
    }],
    messageIdsAtRequest: new Set(["stale-before-request"]),
  });
  assert.deepEqual(
    hydratedMessages.map((message) => message.id).sort(),
    ["local-after-request", "server-existing"],
    "hydration preserves messages added after the request without comparing wall clocks",
  );
  const sharedEventSnapshot = mergeAgentEventPage(undefined, {
    ok: true,
    events: [{ type: "turn.started", runId: "run-1" }],
    cursor: "cursor-1",
    oldestCursor: "cursor-1",
    hasMore: false,
    hasOlder: false,
    historyTruncated: false,
    resetRequired: false,
    snapshot: true,
  });
  const sharedEventDelta = mergeAgentEventPage(sharedEventSnapshot, {
    ok: true,
    events: [{ type: "turn.finished", runId: "run-1" }],
    cursor: "cursor-2",
    oldestCursor: "cursor-2",
    hasMore: false,
    hasOlder: false,
    historyTruncated: false,
    resetRequired: false,
    snapshot: false,
  });
  assert.deepEqual(
    sharedEventDelta.events.map((event) => event.type),
    ["turn.started", "turn.finished"],
    "a second observer must extend the shared cached event page instead of replacing it",
  );
  const interruptedRuntimeParts = roomDisplayParts({
    id: "message-interrupted-runtime",
    senderId: "employee-runtime",
    senderName: "Runtime",
    senderType: "agent",
    text: "Run interrupted",
    targetIds: [],
    status: "interrupted",
    createdAt,
    runId: "run-interrupted-runtime",
    parts: [],
  }, [{
    type: "tool.started",
    runId: "run-interrupted-runtime",
    toolId: "shell",
    callId: "call-interrupted-runtime",
    input: {},
  }]);
  assert.equal(
    interruptedRuntimeParts.find((part) => part.type === "tool")?.status,
    "failed",
    "historical runtime events must not make an interrupted message look live",
  );
  const harmonizedAvatarMembers = harmonizeRoomMemberAvatars([
    {
      id: "employee-avatar-definition",
      employeeDefinitionId: "employee-avatar-definition",
      name: "Avatar Definition",
      avatarMode: "upload",
      avatarDataUrl: "data:image/png;base64,c2FmZQ==",
      role: "",
      kernel: "codex",
      model: "gpt",
      status: "idle",
      color: "#64748b",
      lastActive: "",
      source: "local",
    },
    {
      id: "member-app-avatar-binding",
      employeeDefinitionId: "employee-avatar-definition",
      appId: "avatar-app",
      name: "Avatar Binding",
      role: "",
      kernel: "codex",
      model: "gpt",
      status: "idle",
      color: "#64748b",
      lastActive: "",
      source: "local",
    },
  ]);
  assert.equal(
    harmonizedAvatarMembers[1]?.avatarDataUrl,
    "data:image/png;base64,c2FmZQ==",
    "App-scoped bindings render the logical Employee upload without persisting a duplicate",
  );
  assert.equal(roomMentionToken({ kind: "all" }), "@all");
  assert.equal(roomMentionToken({ kind: "member", member: { name: "金牌编辑" } }), "@金牌编辑");
  const localizedEditor = {
    id: "employee-editor",
    name: "金牌编辑",
    displayName: "Lead Editor",
    kernel: "codex",
    model: "gpt-5.6",
    role: "Review drafts",
    status: "idle",
    color: "#c2410c",
    lastActive: "now",
  };
  assert.equal(
    roomMentionToken({ kind: "member", member: localizedEditor }),
    "@Lead Editor",
    "mentions use the localized display name shown in the UI",
  );
  assert.deepEqual(
    resolveRoomTargets("@Lead Editor review this", [localizedEditor]).map((member) => member.id),
    ["employee-editor"],
    "display-name mentions resolve to the stored employee identity",
  );
  assert.deepEqual(
    resolveRoomTargets("@金牌编辑 review this", [localizedEditor]).map((member) => member.id),
    ["employee-editor"],
    "stored names remain valid mention aliases for compatibility",
  );
  assert.equal(
    directRoomMember({
      kind: "direct",
      directMemberId: "employee-editor",
      memberIds: [],
      get messages() {
        throw new Error("messages must not be read after resolving directMemberId");
      },
      title: "",
    }, [localizedEditor]),
    localizedEditor,
    "direct-room lookup must stop before scanning messages once the explicit member resolves",
  );
  const identityProjectedRooms = projectRoomMemberIdentity([{
    id: "direct-editor",
    kind: "direct",
    title: "Old editor name",
    memberIds: ["employee-editor"],
    adminMemberIds: [],
    directMemberId: "employee-editor",
    pinned: false,
    unread: 0,
    updatedAt: createdAt,
    messages: [{
      id: "message-editor",
      senderId: "employee-editor",
      senderName: "Old editor name",
      senderType: "agent",
      text: "Ready",
      targetIds: [],
      status: "sent",
      createdAt,
    }, {
      id: "message-owner",
      senderId: "owner",
      senderName: "Owner",
      senderType: "human",
      text: "Thanks",
      targetIds: [],
      status: "sent",
      createdAt,
    }],
  }, {
    id: "group-editor",
    kind: "group",
    title: "Editorial group",
    memberIds: ["employee-editor"],
    adminMemberIds: [],
    pinned: false,
    unread: 0,
    updatedAt: createdAt,
    messages: [],
  }], "employee-editor", { id: "employee-editor", name: "App default editor" });
  assert.equal(identityProjectedRooms[0]?.title, "App default editor", "restoring an employee name must update its direct-room title immediately");
  assert.equal(identityProjectedRooms[0]?.messages[0]?.senderName, "App default editor", "restoring an employee name must update stored historical sender names immediately");
  assert.equal(identityProjectedRooms[0]?.messages[1]?.senderName, "Owner", "identity projection must leave unrelated message authors unchanged");
  assert.equal(identityProjectedRooms[1]?.title, "Editorial group", "identity projection must not rename group rooms");
  const mountedDefaultsState = applyMountedAppEmployeeDefaults({
    members: [{ ...localizedEditor, name: "Old editor name" }],
    rooms: identityProjectedRooms.map((room) => projectRoomMemberIdentity([room], "employee-editor", { id: "employee-editor", name: "Old editor name" })[0]),
    activeRoomId: "direct-editor",
  }, "employee-editor", { ...localizedEditor, name: "App default editor", userOverrides: [] });
  assert.equal(mountedDefaultsState.members[0]?.name, "App default editor", "mounted App restoration must merge the returned employee defaults into panel state");
  assert.equal(mountedDefaultsState.rooms[0]?.title, "App default editor", "mounted App restoration must project the returned name into the open direct room");
  assert.equal(mountedDefaultsState.rooms[0]?.messages[0]?.senderName, "App default editor", "mounted App restoration must project the returned name into message history");
  const brokenKernel = {
    id: "hermes",
    label: "Hermes",
    installed: true,
    available: false,
    reason: "The selected provider is missing valid credentials.",
    unavailableCode: "provider_key_missing",
    executableProbe: {
      role: "runtime-required",
      status: "failed",
      path: "/opt/homebrew/bin/hermes",
      requestedCommand: "/opt/homebrew/bin/hermes",
      source: "environment",
      sourceName: "OPENGROVE_HERMES_BIN",
      exitCode: 2,
    },
    notes: ["Hermes integration metadata"],
  };
  assert.deepEqual(
    selectableKernelOptions([
      { id: "codex", label: "Codex", installed: true, available: true },
      brokenKernel,
    ], "codex").map((kernel) => kernel.id),
    ["codex", "hermes"],
    "an installed Kernel with a repairable Provider error must remain selectable for a new employee",
  );
  assert.deepEqual(
    selectableKernelOptions([brokenKernel], "codex", "hermes").map((kernel) => kernel.id),
    ["hermes"],
    "an existing employee must retain its unavailable Kernel as a disabled repair target",
  );
  assert.equal(
    contactKernelSubline(brokenKernel, (key, replacements) => (
      key === "settings.kernelExecutableOverrideExitFailed"
        ? "本地化：" + replacements.path + "，退出码 " + replacements.exitCode
        : key
    )),
    "settings.installedButUnavailable · 本地化：/opt/homebrew/bin/hermes，退出码 2",
    "contacts must localize the structured executable failure while preserving the Provider reason in data",
  );
  assert.equal(
    contactKernelSubline({
      id: "pi",
      label: "Pi",
      installed: true,
      available: false,
      reason: "No usable API key is configured for Pi.",
      executableProbe: {
        role: "optional-diagnostic",
        status: "missing",
      },
    }, (key) => key),
    "settings.installedButUnavailable · No usable API key is configured for Pi.",
    "Pi's bundled SDK must remain visibly installed when only its Provider route is unavailable",
  );
  assert.equal(
    contactKernelSubline({
      id: "openclaw",
      label: "OpenClaw",
      installed: false,
      available: false,
      reason: "OpenClaw Gateway is not configured.",
      unavailableCode: "kernel_runtime_unavailable",
      executableProbe: {
        role: "optional-diagnostic",
        status: "failed",
        path: "/custom/openclaw",
        requestedCommand: "/custom/openclaw",
        source: "environment",
        sourceName: "OPENGROVE_OPENCLAW_BIN",
        exitCode: 2,
      },
    }, (key, replacements) => key === "settings.kernelUnavailableRuntime"
      ? replacements.kernel + " 运行环境未配置"
      : key),
    "common.unavailable · OpenClaw 运行环境未配置",
    "contacts must localize the Gateway runtime failure without exposing the server diagnostic",
  );
  assert.equal(
    directRoomMember({
      kind: "direct",
      memberIds: ["employee-editor"],
      get messages() {
        throw new Error("messages must not be read after resolving memberIds");
      },
      title: "",
    }, [localizedEditor]),
    localizedEditor,
    "direct-room lookup must stop before scanning messages once a room member resolves",
  );
  const appSkillOptions = buildContactSkillOptions([{
    id: "skill.app.story-seed.story-outline",
    name: "story-outline",
    aliases: ["app:story-seed/story-outline"],
    title: "Story Outline",
    description: "Build a chapter outline.",
    source: "pack",
  }], undefined);
  const appSkillEmployee = {
    defaultSkillIds: ["app:story-seed/story-outline"],
    availableSkillIds: ["app:story-seed/story-outline"],
  };
  assert.deepEqual(effectiveMemberSkillIds(appSkillEmployee, appSkillOptions), ["story-outline"]);
  assert.deepEqual(effectiveMemberAvailableSkillIds(appSkillEmployee, appSkillOptions), ["story-outline"]);
  const appBuilderDefinition = {
    id: "app-builder",
    employeeDefinitionId: "app-builder",
    name: "App 构建师",
    kernel: "claude-code",
    model: "opus",
    role: "Build OpenGrove Apps",
    status: "idle",
    color: "#7c3aed",
    lastActive: "now",
  };
  const legacyEmployee = {
    id: "legacy-employee",
    name: "Legacy Employee",
    kernel: "codex",
    model: "native",
    role: "Review changes",
    status: "idle",
    color: "#64748b",
    lastActive: "now",
  };
  const legacyDraft = createDefaultDraft(
    { id: "codex", label: "Codex", available: true },
    "codex",
    "native",
    {
      models: [{ id: "native", label: "Native" }],
      reasoningEfforts: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
      ],
    },
    undefined,
    legacyEmployee,
  );
  assert.equal(legacyDraft.avatarSeed, "", "opening a legacy employee must not invent an avatar seed");
  assert.equal(legacyDraft.reasoningEffort, "", "opening a legacy employee must not invent a reasoning override");
  const overriddenPresentationDraft = createDefaultDraft(
    { id: "codex", label: "Codex", available: true },
    "codex",
    "native",
    {
      models: [{ id: "native", label: "Native" }],
      reasoningEfforts: [{ id: "medium", label: "Medium" }],
    },
    undefined,
    {
      ...legacyEmployee,
      name: "Canonical custom name",
      displayName: "Localized seed name",
      role: "Canonical custom role",
      displayRole: "Localized seed role",
      publicDescription: "Canonical custom description",
      displayPublicDescription: "Localized seed description",
      publicSkills: ["Canonical custom skill"],
      displayPublicSkills: ["Localized seed skill"],
      inputSpec: "Canonical custom input",
      displayInputSpec: "Localized seed input",
      outputSpec: "Canonical custom output",
      displayOutputSpec: "Localized seed output",
      userOverrides: ["name", "role", "publicDescription", "publicSkills", "inputSpec", "outputSpec"],
    },
  );
  assert.equal(overriddenPresentationDraft.name, "Canonical custom name");
  assert.equal(overriddenPresentationDraft.role, "Canonical custom role");
  assert.equal(overriddenPresentationDraft.publicDescription, "Canonical custom description");
  assert.equal(overriddenPresentationDraft.publicSkillsText, "Canonical custom skill");
  assert.equal(overriddenPresentationDraft.inputSpec, "Canonical custom input");
  assert.equal(overriddenPresentationDraft.outputSpec, "Canonical custom output");
  const legacyEmployeeAfterEmptySave = createMemberFromDraft(legacyDraft, { initialMember: legacyEmployee });
  assert.equal(legacyEmployeeAfterEmptySave.avatarSeed, undefined, "empty save preserves the effective id-based avatar");
  assert.equal(legacyEmployeeAfterEmptySave.reasoningEffort, undefined, "empty save keeps reasoning on the kernel default");
  assert.equal(
    canSubmitDraft({ ...legacyDraft, avatarMode: "upload", avatarDataUrl: "" }, true),
    false,
    "upload mode cannot be saved without an image",
  );
  const invalidLegacyUploadDraft = createDefaultDraft(
    { id: "codex", label: "Codex", available: true },
    "codex",
    "native",
    {
      models: [{ id: "native", label: "Native" }],
      reasoningEfforts: [{ id: "low", label: "Low" }],
    },
    undefined,
    { ...legacyEmployee, avatarMode: "upload" },
  );
  assert.equal(invalidLegacyUploadDraft.legacyInvalidAvatar, true);
  assert.equal(
    canSubmitDraft(invalidLegacyUploadDraft, true),
    true,
    "a legacy upload whose invalid payload was discarded must not lock unrelated employee settings",
  );
  const maximumAvatarDataUrl = \`data:image/png;base64,\${Buffer.alloc(ROOM_MEMBER_AVATAR_MAX_BYTES).toString("base64")}\`;
  assert.equal(
    canSubmitDraft({
      ...legacyDraft,
      avatarMode: "upload",
      avatarDataUrl: maximumAvatarDataUrl,
      legacyInvalidAvatar: false,
    }, true),
    true,
    "the advertised 1.5 MB raw upload limit must also be accepted when saving its base64 data URL",
  );
  const oversizedAvatarDataUrl = \`data:image/png;base64,\${Buffer.alloc(ROOM_MEMBER_AVATAR_MAX_BYTES + 1).toString("base64")}\`;
  assert.equal(
    canSubmitDraft({
      ...legacyDraft,
      avatarMode: "upload",
      avatarDataUrl: oversizedAvatarDataUrl,
      legacyInvalidAvatar: false,
    }, true),
    false,
    "avatar payloads larger than 1.5 MB must be rejected consistently",
  );
  const unsupportedReasoningDraft = createDefaultDraft(
    { id: "codex", label: "Codex", available: true },
    "codex",
    "native",
    {
      models: [{ id: "native", label: "Native" }],
      reasoningEfforts: [{ id: "low", label: "Low" }],
    },
    undefined,
    { ...legacyEmployee, reasoningEffort: "high" },
  );
  assert.equal(
    unsupportedReasoningDraft.reasoningEffort,
    "high",
    "temporarily unavailable runtime controls must not clear a persisted reasoning level",
  );
  assert.equal(
    createMemberFromDraft(unsupportedReasoningDraft, { initialMember: { ...legacyEmployee, reasoningEffort: "high" } }).reasoningEffort,
    "high",
  );
  assert.equal(
    canEditEmployeeRuntime(appBuilderDefinition),
    true,
    "the global App Builder uses the same editable runtime policy as every local employee",
  );
  assert.equal(
    canEditEmployeeRuntime({ ...appBuilderDefinition, source: "human" }),
    false,
    "human contacts remain read-only runtime entries",
  );
  assert.deepEqual(
    appEmployeeOverrideFields({
      ...appBuilderDefinition,
      appId: "story-seed",
      manifestDefaults: { kernel: "claude-code", model: "opus", contextTokenBudget: 200000 },
      userOverrides: ["contextTokenBudget", "accessMode"],
    }),
    ["contextTokenBudget", "accessMode"],
    "the contacts UI must identify fields currently overridden on this machine",
  );
  assert.deepEqual(
    new Set(Object.keys(APP_EMPLOYEE_OVERRIDE_FIELD_ITEMS)),
    new Set([
      "name", "avatarMode", "avatarSeed", "avatarDataUrl", "role", "kernel", "model", "color",
      "availableSkillIds", "defaultSkillIds", "reasoningEffort", "contextTokenBudget", "accessMode",
      "visibility", "publicDescription", "publicSkills", "inputSpec", "outputSpec",
    ]),
    "every restorable App employee field must have a user-facing settings-item mapping",
  );
  assert.deepEqual(
    appEmployeeOverrideItems({
      ...appBuilderDefinition,
      appId: "story-seed",
      manifestDefaults: { name: "Analyst", avatarMode: "generated", avatarSeed: "seed", color: "#fff", model: "opus" },
      userOverrides: ["name", "avatarMode", "avatarSeed", "color", "model", "providerId"],
    }),
    ["name", "avatar", "model"],
    "the confirmation must merge avatar implementation fields and exclude the retained Provider binding",
  );
  assert.deepEqual(
    appEmployeeOverrideFields({
      ...appBuilderDefinition,
      appId: "story-seed",
      manifestDefaults: { kernel: "claude-code", model: "opus" },
    }),
    [],
    "an App employee without override markers uses App defaults",
  );
  const storySeedBuilderBinding = {
    ...appBuilderDefinition,
    id: "member-app-story-seed-app-builder",
    appId: "story-seed",
    workspaceRoot: "/tmp/story-seed/workspace",
    role: "Build the story-seed App",
  };
  const sampleDashboardBuilderBinding = {
    ...appBuilderDefinition,
    id: "member-app-sample-dashboard-app-builder",
    appId: "sample-dashboard",
    workspaceRoot: "/tmp/sample-dashboard/workspace",
    role: "Build the sample-dashboard App",
  };
  assert.deepEqual(
    visibleEmployeeDefinitions([appBuilderDefinition, storySeedBuilderBinding, sampleDashboardBuilderBinding]).map((member) => member.id),
    ["app-builder"],
  );
  assert.deepEqual(
    visibleEmployeeDefinitions([storySeedBuilderBinding]).map((member) => member.id),
    [storySeedBuilderBinding.id],
    "an orphaned App binding remains visible until its logical definition is available",
  );
  const storySeedSharedMembers = filterMountedAppSharedMembers(
    { id: "app:story-seed", name: "story-seed", title: "Story Seed" },
    [appBuilderDefinition, storySeedBuilderBinding],
    new Set([storySeedBuilderBinding.id]),
    undefined,
  );
  assert.equal(storySeedSharedMembers.some((member) => member.id === appBuilderDefinition.id), false);
  const appWithoutBuilderSharedMembers = filterMountedAppSharedMembers(
    { id: "app:sample-dashboard", name: "sample-dashboard", title: "Sample Dashboard" },
    [appBuilderDefinition, storySeedBuilderBinding],
    new Set(),
    undefined,
  );
  assert.equal(
    appWithoutBuilderSharedMembers.some((member) => member.id === appBuilderDefinition.id),
    true,
    "an App without a scoped builder should offer the global App Builder definition as an add candidate",
  );
  assert.equal(
    appWithoutBuilderSharedMembers.some((member) => member.id === storySeedBuilderBinding.id),
    false,
    "an employee binding owned by another App must not be offered as an add candidate",
  );
  const removedStoryWriter = {
    ...storySeedBuilderBinding,
    id: "member-app-story-seed-writer",
    employeeDefinitionId: "writer",
    name: "故事架构师",
    status: "offline",
    lastActive: "已移除",
    disabled: true,
  };
  const manifestRemovedStoryEditor = {
    ...removedStoryWriter,
    id: "member-app-story-seed-editor",
    employeeDefinitionId: "editor",
    name: "金牌编辑",
    lastActive: "manifest removed",
  };
  const removedSampleDashboardWriter = {
    ...removedStoryWriter,
    id: "member-app-sample-dashboard-writer",
    appId: "sample-dashboard",
  };
  assert.deepEqual(
    restorableMountedAppMembers(
      { id: "app:story-seed", name: "story-seed", title: "Story Seed" },
      [removedStoryWriter, manifestRemovedStoryEditor, removedSampleDashboardWriter],
    ).map((member) => member.id),
    [removedStoryWriter.id],
    "only deliberately removed seed employees from the current App are offered for restoration",
  );
  assert.deepEqual(
    restoreMountedAppMember(removedStoryWriter),
    { ...removedStoryWriter, status: "idle", lastActive: "已配置", disabled: false },
    "restoring an App employee clears the durable removal sentinel before POSTing it",
  );
  assert.equal(
    resolveVisibleRoomFocus("direct-app-builder", "direct-app-builder", ["direct-material-manager"]),
    null,
    "a user-requested room that is briefly absent must not fall back to an old room",
  );
  assert.equal(
    resolveVisibleRoomFocus("direct-material-manager", "direct-app-builder", ["direct-material-manager", "direct-app-builder"]),
    "direct-app-builder",
    "the requested room must retake focus once synchronization makes it visible",
  );
  assert.equal(
    resolveVisibleRoomFocus("app:story-seed:room", undefined, ["direct-material-manager"]),
    "direct-material-manager",
    "an invalid active room without an explicit request may use the visible fallback",
  );
  const availableCodex = { id: "codex", label: "Codex", available: true };
  const appPm = {
    id: "member-app-story-seed-pm",
    name: "故事种子 PM",
    kernel: "claude-code",
    model: "claude-code-default",
    role: "",
    status: "idle",
    color: "#f59e0b",
    lastActive: "刚刚",
    appId: "story-seed",
    defaultSkillIds: ["pm-planner"],
  };
  const appWorker = {
    ...appPm,
    id: "employee-codex",
    name: "金牌编辑",
    kernel: "codex",
    model: "gpt-5.4",
  };
  const appRoom = {
    id: "app:story-seed:room",
    kind: "group",
    title: "故事种子",
    badge: "App",
    memberIds: [appPm.id, appWorker.id],
    messages: [],
    updatedAt: createdAt,
    unread: 0,
  };
  const strictAppPm = {
    ...appPm,
    employeeDefinitionId: "pm",
    kernel: "codex",
    source: "local",
  };
  assert.equal(
    resolveAutomaticPmTarget(
      { ...appRoom, memberIds: [strictAppPm.id, appWorker.id], adminMemberIds: [] },
      [strictAppPm, appWorker],
      [{ ...availableCodex, hostTools: true }],
    ),
    undefined,
    "a PM that is not a Room administrator must not receive an optimistic placeholder",
  );
  const strictPmRoom = {
    ...appRoom,
    memberIds: [strictAppPm.id, appWorker.id],
    adminMemberIds: [strictAppPm.id],
  };
  assert.equal(
    resolveAutomaticPmTarget(
      { ...strictPmRoom, memberIds: [appPm.id, appWorker.id], adminMemberIds: [appPm.id] },
      [appPm, appWorker],
      [{ ...availableCodex, hostTools: true }],
    ),
    undefined,
    "legacy PM heuristics must not be used for optimistic execution prediction",
  );
  assert.equal(
    resolveAutomaticPmTarget(strictPmRoom, [strictAppPm, appWorker], [{ ...availableCodex, hostTools: false }]),
    undefined,
    "a PM whose Kernel lacks Host Tools must not receive an optimistic placeholder",
  );
  const automaticPmTargets = resolveRoomSendTargets({
    text: "继续",
    room: strictPmRoom,
    members: [strictAppPm, appWorker],
    kernelOptions: [{ ...availableCodex, hostTools: true }],
  });
  assert.deepEqual(
    automaticPmTargets.requestTargets,
    [],
    "an automatic PM prediction must not become an explicit Bridge target",
  );
  assert.deepEqual(
    automaticPmTargets.optimisticTargets.map((member) => member.id),
    [strictAppPm.id],
    "both Room send surfaces must receive the same strict optimistic PM target",
  );
  const globalRoutablePm = {
    ...strictAppPm,
    id: "member-global-routable-pm",
    name: "全局 PM",
    appId: undefined,
  };
  const otherAppWorker = { ...appWorker, id: "employee-other-app", appId: "other-app" };
  assert.deepEqual(
    resolveRoomSendTargets({
      text: "继续",
      room: {
        ...strictPmRoom,
        memberIds: [strictAppPm.id, globalRoutablePm.id, otherAppWorker.id],
        adminMemberIds: [strictAppPm.id, globalRoutablePm.id],
      },
      members: [strictAppPm],
      automaticPmMembers: [strictAppPm, globalRoutablePm, otherAppWorker],
      kernelOptions: [{ ...availableCodex, hostTools: true }],
    }).optimisticTargets.map((member) => member.id),
    [globalRoutablePm.id],
    "automatic PM scope selection must inspect every Room member, not only mentionable App employees",
  );
  const finalMember = {
    id: "member-user-final",
    name: "Codex",
    kernel: "codex",
    model: "gpt-5.5",
    role: "你是小赵",
    status: "idle",
    color: "#2563eb",
    lastActive: "刚刚",
    source: "local",
    defaultSkillIds: ["skill-a"],
    toolIds: ["tool-a"],
    workspaceRoot: "/tmp/opengrove-fixture-home",
  };
  const tempMember = { ...finalMember, id: "employee-temp", workspaceRoot: undefined };
  const staleMember = { ...finalMember, id: "member-user-stale", workspaceRoot: undefined };
  const appScopedMember = {
    ...finalMember,
    id: "member-user-final-opengrove-vfs",
    appId: "opengrove-vfs",
    role: finalMember.role + "\\nWhen used from the VFS 文件工作台 OpenGrove App, answer with that App's current context and workspace in mind.",
    status: "running",
  };
  const currentRoom = {
    id: "room-xiaozhao",
    kind: "direct",
    title: "小赵",
    badge: "本机",
    memberIds: [tempMember.id, staleMember.id, appScopedMember.id],
    directMemberId: tempMember.id,
    messages: [{
      id: "message-local-running",
      senderId: appScopedMember.id,
      senderName: tempMember.name,
      senderType: "agent",
      text: "",
      targetIds: [staleMember.id, appScopedMember.id],
      status: "running",
      createdAt,
      runId: "run-xiaozhao",
    }],
    updatedAt: createdAt,
    unread: 0,
  };
  const stableAdminRoom = {
    ...currentRoom,
    kind: "group",
    memberIds: [tempMember.id],
    adminMemberIds: [tempMember.id],
    messages: [],
  };
  const roomMembers = [tempMember];
  const noEventApplied = applyRoomEvents([stableAdminRoom], roomMembers, []);
  assert.equal(
    noEventApplied.rooms[0],
    stableAdminRoom,
    "normalizing an already valid room must preserve its object identity",
  );
  assert.equal(
    noEventApplied.rooms[0].memberIds,
    stableAdminRoom.memberIds,
    "normalizing an already valid room must preserve its member array identity",
  );
  assert.equal(
    noEventApplied.rooms[0].adminMemberIds,
    stableAdminRoom.adminMemberIds,
    "normalizing an already valid room must preserve its administrator array identity",
  );
  const partialRoomUpdateApplied = applyRoomEvents([stableAdminRoom], roomMembers, [{
    eventSeq: 1,
    type: "room.updated",
    roomId: stableAdminRoom.id,
    createdAt,
    payload: {
      room: {
        ...stableAdminRoom,
        title: "局部更新",
        memberIds: [],
        adminMemberIds: [],
        messages: undefined,
      },
    },
  }]);
  assert.deepEqual(
    partialRoomUpdateApplied.rooms[0].memberIds,
    stableAdminRoom.memberIds,
    "a partial room snapshot without members must not erase the current member list",
  );
  assert.deepEqual(
    partialRoomUpdateApplied.rooms[0].adminMemberIds,
    stableAdminRoom.adminMemberIds,
    "a partial room snapshot without members must not erase current administrators",
  );
  const appRoomWithMember = {
    ...stableAdminRoom,
    id: "app-room--story-seed--group--default",
    scope: { kind: "app", appId: "story-seed", role: "default" },
  };
  const emptyAppRoomApplied = applyRoomEvents([appRoomWithMember], roomMembers, [{
    eventSeq: 2,
    type: "room.updated",
    roomId: appRoomWithMember.id,
    createdAt,
    payload: {
      room: {
        ...appRoomWithMember,
        memberIds: [],
        adminMemberIds: [],
        messages: undefined,
      },
    },
  }]);
  assert.deepEqual(
    emptyAppRoomApplied.rooms[0].memberIds,
    [],
    "an App Room update can authoritatively preserve a valid zero-member roster",
  );
  assert.deepEqual(emptyAppRoomApplied.rooms[0].adminMemberIds, []);
  const explicitAdministratorClearApplied = applyRoomEvents([stableAdminRoom], roomMembers, [{
    eventSeq: 3,
    type: "room.updated",
    roomId: stableAdminRoom.id,
    createdAt,
    payload: {
      room: {
        ...stableAdminRoom,
        memberIds: stableAdminRoom.memberIds,
        adminMemberIds: [],
        messages: undefined,
      },
    },
  }]);
  assert.deepEqual(
    explicitAdministratorClearApplied.rooms[0].adminMemberIds,
    [],
    "an explicit administrator clear in a complete member snapshot must remain supported",
  );
  const snapshot = {
    ok: true,
    rooms: [{ ...currentRoom, memberIds: [finalMember.id], directMemberId: finalMember.id }],
    members: [finalMember, appScopedMember],
    messages: [{
      id: "message-server-done",
      roomId: currentRoom.id,
      channelSeq: 2,
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "done",
      targetIds: [],
      status: "done",
      createdAt,
      updatedAt: createdAt,
      runId: "run-xiaozhao",
      deliveryKind: "agent_delegation",
      inReplyToMessageId: "message-user-root",
      rootMessageId: "message-user-root",
      selectedFile: { path: "项目/长安客/章节大纲.md" },
    }],
    currentEventSeq: 1,
    deletedMemberIds: [staleMember.id],
  };

  const merged = mergeRoomsFromServerSnapshot([currentRoom], [tempMember, staleMember, appScopedMember], [], snapshot);
  assert.deepEqual(merged.members.map((member) => member.id), [finalMember.id]);
  assert.equal(merged.members[0].appId, undefined);
  assert.equal(merged.members[0].role.includes("When used from"), false);
  assert.deepEqual(merged.deletedMemberIds, []);
  assert.deepEqual(merged.rooms[0].memberIds, [finalMember.id]);
  assert.equal(merged.rooms[0].directMemberId, finalMember.id);
  assert.equal(merged.rooms[0].messages.length, 1);
  assert.equal(merged.rooms[0].messages[0].id, "message-server-done");
  assert.equal(merged.rooms[0].messages[0].senderId, finalMember.id);
  assert.equal(merged.rooms[0].messages[0].status, "done");
  assert.equal(merged.rooms[0].messages[0].deliveryKind, "agent_delegation");
  assert.equal(merged.rooms[0].messages[0].inReplyToMessageId, "message-user-root");
  assert.equal(merged.rooms[0].messages[0].rootMessageId, "message-user-root");
  assert.deepEqual(merged.rooms[0].messages[0].selectedFile, { path: "项目/长安客/章节大纲.md" });

  const previousAccountRoom = {
    id: "room-previous-account",
    kind: "group",
    title: "旧账号房间",
    badge: "云端",
    memberIds: [tempMember.id],
    messages: [{
      id: "message-previous-account",
      senderId: tempMember.id,
      senderName: tempMember.name,
      senderType: "agent",
      text: "old account message",
      targetIds: [],
      status: "done",
      createdAt,
    }],
    updatedAt: createdAt,
    unread: 0,
  };
  const nextAccountSnapshot = {
    ok: true,
    rooms: [{
      id: "room-next-account",
      kind: "group",
      title: "新账号房间",
      badge: "云端",
      memberIds: [finalMember.id],
      updatedAt: createdAt,
      unread: 0,
    }],
    members: [finalMember],
    messages: [{
      id: "message-next-account",
      roomId: "room-next-account",
      channelSeq: 1,
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "new account message",
      targetIds: [],
      status: "done",
      createdAt,
      updatedAt: createdAt,
    }],
    currentEventSeq: 3,
  };
  const replaced = replaceRoomsFromServerSnapshot(nextAccountSnapshot);
  assert.deepEqual(replaced.rooms.map((room) => room.id), ["room-next-account"]);
  assert.equal(replaced.rooms[0].messages[0].text, "new account message");
  assert.equal(replaced.rooms.some((room) => room.id === previousAccountRoom.id), false);

  const staleRunningSnapshot = {
    ok: true,
    rooms: [{
      id: "room-stale-running",
      kind: "group",
      title: "旧运行",
      badge: "本机",
      memberIds: [appScopedMember.id],
      updatedAt: createdAt,
      unread: 0,
    }],
    members: [{ ...appScopedMember, status: "running" }],
    messages: [{
      id: "message-stale-running",
      roomId: "room-stale-running",
      channelSeq: 1,
      senderId: appScopedMember.id,
      senderName: appScopedMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      createdAt,
      updatedAt: new Date().toISOString(),
      startedAt: createdAt,
      runId: "run-stale-running",
    }],
    currentEventSeq: 2,
  };
  const staleMerged = mergeRoomsFromServerSnapshot([], [], [], staleRunningSnapshot);
  assert.equal(staleMerged.rooms[0].messages[0].status, "running");
  assert.equal(staleMerged.rooms[0].messages[0].finishedAt, undefined);
  assert.equal(staleMerged.members[0].status, "running");

  const localPendingRoom = {
    ...currentRoom,
    id: "room-local-pending",
    memberIds: [appScopedMember.id],
    messages: [{
      id: "message-local-pending-running",
      senderId: appScopedMember.id,
      senderName: appScopedMember.name,
      senderType: "agent",
      text: "",
      targetIds: [appScopedMember.id],
      status: "running",
      createdAt,
      startedAt: createdAt,
    }],
  };
  const localPendingSnapshot = {
    ok: true,
    rooms: [{
      ...localPendingRoom,
      messages: [],
    }],
    members: [{ ...appScopedMember, status: "idle" }],
    messages: [],
    currentEventSeq: 4,
  };
  const localPendingMerged = mergeRoomsFromServerSnapshot([localPendingRoom], [appScopedMember], [], localPendingSnapshot);
  assert.equal(localPendingMerged.rooms[0].messages.some((message) => message.id === "message-local-pending-running"), false);
  assert.equal(localPendingMerged.members[0].status, "idle");

  const eventApplied = applyRoomEvents([currentRoom], [tempMember], [{
    eventSeq: 2,
    type: "room.member.updated",
    roomId: "",
    memberId: finalMember.id,
    createdAt,
    payload: { member: finalMember },
  }]);
  assert.deepEqual(eventApplied.members.map((member) => member.id), [finalMember.id]);
  assert.deepEqual(eventApplied.rooms[0].memberIds, [finalMember.id]);
  assert.equal(eventApplied.rooms[0].directMemberId, finalMember.id);

  const eventMessageApplied = applyRoomEvents([currentRoom], [tempMember], [{
    eventSeq: 3,
    type: "room.message.updated",
    roomId: currentRoom.id,
    messageId: "message-event-done",
    createdAt,
    payload: {
      message: {
        id: "message-event-done",
        roomId: currentRoom.id,
        channelSeq: 3,
        senderId: tempMember.id,
        senderName: tempMember.name,
        senderType: "agent",
        text: "@金牌编辑 请审核章节大纲",
        targetIds: [finalMember.id],
        status: "done",
        createdAt,
        updatedAt: createdAt,
        runId: "run-xiaozhao",
        deliveryKind: "agent_delegation",
        inReplyToMessageId: "message-user-root",
        rootMessageId: "message-user-root",
        selectedFile: { path: "项目/长安客/章节大纲.md" },
      },
    },
  }]);
  const eventMessage = eventMessageApplied.rooms[0].messages[0];
  assert.equal(eventMessage.id, "message-event-done");
  assert.equal(eventMessage.deliveryKind, "agent_delegation");
  assert.equal(eventMessage.inReplyToMessageId, "message-user-root");
  assert.equal(eventMessage.rootMessageId, "message-user-root");
  assert.deepEqual(eventMessage.selectedFile, { path: "项目/长安客/章节大纲.md" });

  const patchBaseMessage = currentRoom.messages[0];
  const patchApplied = applyRoomEvents([currentRoom], [tempMember], [{
    schemaVersion: 2,
    eventSeq: 4,
    type: "room.message.updated",
    roomId: currentRoom.id,
    messageId: patchBaseMessage.id,
    createdAt,
    payload: { messagePatch: { set: { text: "patched", status: "done", updatedAt: createdAt } } },
  }]);
  assert.equal(patchApplied.requiresResync, false);
  assert.equal(patchApplied.rooms[0].messages.find((message) => message.id === patchBaseMessage.id)?.text, "patched");
  const immutablePatchApplied = applyRoomEvents([currentRoom], [tempMember], [{
    schemaVersion: 2,
    eventSeq: 5,
    type: "room.message.updated",
    roomId: currentRoom.id,
    messageId: patchBaseMessage.id,
    createdAt,
    payload: {
      messagePatch: {
        set: { id: "forged", roomId: "forged", channelSeq: 999, createdAt: "forged", text: "safe" },
        unset: ["id", "roomId", "channelSeq", "createdAt", "duration"],
      },
    },
  }]);
  const immutablePatchMessage = immutablePatchApplied.rooms[0].messages.find((message) => message.id === patchBaseMessage.id);
  assert.equal(immutablePatchApplied.requiresResync, false);
  assert.equal(immutablePatchMessage?.id, patchBaseMessage.id);
  assert.equal(immutablePatchMessage?.roomId, currentRoom.id);
  assert.equal(immutablePatchMessage?.channelSeq, patchBaseMessage.channelSeq);
  assert.equal(immutablePatchMessage?.createdAt, patchBaseMessage.createdAt);
  assert.equal(immutablePatchMessage?.text, "safe");
  assert.equal(immutablePatchMessage?.duration, undefined);
  const missingPatchBase = applyRoomEvents([currentRoom], [tempMember], [{
    schemaVersion: 2,
    eventSeq: 6,
    type: "room.message.updated",
    roomId: currentRoom.id,
    messageId: "missing-message",
    createdAt,
    payload: { messagePatch: { set: { text: "cannot apply" } } },
  }]);
  assert.equal(missingPatchBase.requiresResync, true, "a patch without its base message must request snapshot rehydration");
  const malformedPatch = applyRoomEvents([currentRoom], [tempMember], [{
    schemaVersion: 2,
    eventSeq: 7,
    type: "room.message.updated",
    roomId: currentRoom.id,
    messageId: patchBaseMessage.id,
    createdAt,
    payload: { messagePatch: { set: null } },
  }]);
  assert.equal(malformedPatch.requiresResync, true, "a malformed patch must request snapshot rehydration");

  const deletableMessage = {
    id: "message-delete-target",
    senderId: appScopedMember.id,
    senderName: appScopedMember.name,
    senderType: "agent",
    text: "delete me",
    targetIds: [],
    status: "done",
    createdAt,
  };
  const deleteEventApplied = applyRoomEvents([{ ...currentRoom, messages: [...currentRoom.messages, deletableMessage] }], [appScopedMember], [{
    eventSeq: 3,
    type: "room.message.deleted",
    roomId: currentRoom.id,
    messageId: deletableMessage.id,
    createdAt,
    payload: { messageId: deletableMessage.id },
  }]);
  assert.equal(deleteEventApplied.rooms[0].messages.some((message) => message.id === deletableMessage.id), false);

  assert.equal(agentAuthorMention(deletableMessage, [appScopedMember]), "@Codex");
  assert.equal(agentAuthorMention({
    id: "message-user-targeted",
    senderId: "user",
    senderName: "我",
    senderType: "user",
    text: "@Codex hi",
    targetIds: [appScopedMember.id],
    status: "sent",
    createdAt,
  }, [appScopedMember]), "", "a user's own message must not expose a reply mention");
  const mentionDraft = draftWithAuthorMention("继续处理", "@Codex");
  assert.equal(mentionDraft.value, "@Codex 继续处理");
  assert.equal(mentionDraft.cursor, mentionDraft.value.length);
  assert.deepEqual(
    roomReplyPreview(deletableMessage, [{ ...appScopedMember, displayName: "Claude" }]),
    { senderName: "Claude", text: "delete me" },
  );
  const replyDraft = mentionDraft.value;
  const userReplyMessage = {
    id: "message-user-reply",
    senderId: "user",
    senderName: "我",
    senderType: "user",
    text: replyDraft,
    targetIds: [appScopedMember.id],
    status: "sent",
    createdAt,
    inReplyToMessageId: deletableMessage.id,
    rootMessageId: "message-user-root",
  };
  const renderedReplyStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    roomId: "room-reply-preview",
    messages: [deletableMessage, userReplyMessage],
    members: [appScopedMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onReplyMessage() {},
    onMentionMessageAuthor() {},
  }));
  assert.match(renderedReplyStream, /class="room-chat-reply-quote"/);
  assert.match(renderedReplyStream, /delete me/);
  assert.match(renderedReplyStream, /@Codex 继续处理/);
  assert.match(renderedReplyStream, /aria-label="提及 Codex"|aria-label="Mention Codex"/);
  assert.match(renderedReplyStream, /aria-label="回复"|aria-label="Reply"/);
  const renderedAttachmentReplyStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    roomId: "room-attachment-reply-preview",
    messages: [deletableMessage, {
      ...userReplyMessage,
      id: "message-user-attachment-reply",
      text: "",
      attachments: [{
        id: "attachment-reply-image",
        name: "reply.png",
        kind: "image",
        mimeType: "image/png",
        size: 3,
        dataUrl: "data:image/png;base64,AAA=",
      }],
    }],
    members: [appScopedMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
  }));
  assert.match(
    renderedAttachmentReplyStream,
    /class="room-chat-reply-quote"/,
    "an attachment-only reply must keep its reply reference visible",
  );
  const renderedMissingReplyStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    roomId: "room-missing-reply-preview",
    messages: [{
      ...userReplyMessage,
      id: "message-user-missing-reply",
      inReplyToMessageId: "message-already-deleted",
    }],
    members: [appScopedMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
  }));
  assert.match(renderedMissingReplyStream, /class="room-chat-reply-quote"/);
  assert.match(renderedMissingReplyStream, /原消息不可用|Original message unavailable/);
  const renderedReplyComposer = renderToStaticMarkup(React.createElement(RoomComposer, {
    inputRef: { current: null },
    fileInputRef: { current: null },
    roomTitle: "产品群",
    draft: replyDraft,
    attachments: [],
    replyPreview: {
      senderName: "Codex",
      text: "delete me",
    },
    canSend: true,
    mentionOpen: false,
    mentionOptions: [{
      id: appScopedMember.id,
      kind: "member",
      label: "Codex",
      member: appScopedMember,
    }],
    activeMentionIndex: 0,
    onDraftChange() {},
    onAttachmentInputChange() {},
    onOpenAttachmentPicker() {},
    onRemoveAttachment() {},
    onCancelReply() {},
    onPaste() {},
    onKeyDown() {},
    onCompositionStart() {},
    onCompositionEnd() {},
    onOpenMention() {},
    onSelectMention() {},
    onHoverMention() {},
    onSend() {},
  }));
  assert.match(renderedReplyComposer, /class="room-composer-reply"/);
  assert.match(renderedReplyComposer, /Codex/);
  assert.match(renderedReplyComposer, /delete me/);
  assert.match(renderedReplyComposer, /@Codex/);
  assert.match(renderedReplyComposer, /aria-label="取消回复"|aria-label="Cancel reply"/);

  const xiaoZhaoMembers = dedupeRoomMembers([
    {
      ...finalMember,
      id: "member-user-xiaozhao-a",
      name: "Codex",
      role: "你是小赵",
      model: "GPT-5.5",
    },
    {
      ...finalMember,
      id: "member-user-xiaozhao-b",
      name: "Codex",
      role: "你是小赵",
      model: "GPT-5.5",
    },
  ]);
  assert.equal(xiaoZhaoMembers.members.length, 1);
  assert.equal(xiaoZhaoMembers.memberIdAliases.size, 1);

  const codexCommandItems = buildActivityItems([{
    id: "codex-command-call",
    type: "tool",
    phase: "call",
    toolId: "codex.commandExecution",
    title: "codex.commandExecution",
    status: "complete",
    input: { command: "/bin/zsh -lc 'ls -1'", cwd: "/tmp" },
  }]);
  assert.equal(activityItemTitle(codexCommandItems[0]), "Ran ls -1");
  assert.doesNotMatch(activityItemTitle(codexCommandItems[0]), /codex\\.commandExecution/);

  const monitorCommand = 'cd "/private/opengrove/apps/story/workspace" && tail -f run.log';
  const monitorItems = buildActivityItems([{
    id: "claude-monitor",
    type: "tool",
    phase: "call",
    toolId: "claude.Monitor",
    title: "Monitor",
    status: "complete",
    input: {
      command: monitorCommand,
      description: "章节导出完成或报错",
      timeout_ms: 300000,
      persistent: false,
    },
  }]);
  assert.equal(monitorItems.length, 1);
  assert.equal(activityItemKind(monitorItems[0]), "monitor");
  assert.equal(activityItemTitle(monitorItems[0]), "Monitored 章节导出完成或报错");
  assert.equal(activityItemDetailDisplay(monitorItems[0]), null);
  assert.equal(activityItemTitleTooltip(monitorItems[0]), "");
  assert.deepEqual(artifactCardsFromItem(monitorItems[0]), []);
  assert.equal(summarizeActivityItems(monitorItems), "Monitored 章节导出完成或报错");
  const monitorNodes = buildActivityRenderNodes([{ groupKey: "monitor", item: monitorItems[0] }]);
  assert.equal(monitorNodes.length, 1);
  assert.equal(monitorNodes[0]?.type, "command", "Monitor belongs in the collapsible tool aggregate");
  const renderedMonitor = renderToStaticMarkup(React.createElement(AssistantProcessBlock, {
    entries: [{ groupKey: "monitor", item: monitorItems[0] }],
    renderMode: "embedded",
    detailMode: "full",
    unwrapSingleExploration: true,
    onResolveApproval() {},
    onResolveQuestion() {},
  }));
  assert.match(renderedMonitor, /og-disclosure--exploration/);
  assert.match(renderedMonitor, /aria-expanded="false"/);
  assert.match(renderedMonitor, /Monitored 章节导出完成或报错/);
  assert.doesNotMatch(renderedMonitor, /timeout_ms|persistent|private\\/opengrove|tail -f|&quot;command&quot;/);

  const claudeToolCases = [
    [{ id: "claude-bash", type: "tool", phase: "call", toolId: "claude.Bash", title: "claude.Bash", status: "complete", input: { command: "/bin/zsh -lc 'npm run check'" } }, "command", "Ran npm run check"],
    [{ id: "claude-edit", type: "tool", phase: "call", toolId: "claude.Edit", title: "claude.Edit", status: "complete", input: { file_path: "web/src/app.tsx" } }, "edit", "Edited web/src/app.tsx"],
    [{ id: "claude-write", type: "tool", phase: "call", toolId: "claude.Write", title: "claude.Write", status: "complete", input: { path: "docs/check.md" } }, "edit", "Edited docs/check.md"],
    [{ id: "claude-glob", type: "tool", phase: "call", toolId: "claude.Glob", title: "claude.Glob", status: "complete", input: { pattern: "**/*.ts", path: "web/src" } }, "search", "Searched web/src"],
    [{ id: "claude-grep", type: "tool", phase: "call", toolId: "claude.Grep", title: "claude.Grep", status: "complete", input: { pattern: "RoomRunDetailsBlock", path: "web/src" } }, "search", "Searched web/src"],
    [{ id: "claude-webfetch", type: "tool", phase: "call", toolId: "claude.WebFetch", title: "claude.WebFetch", status: "complete", input: { url: "https://example.com" } }, "browser", "Browsed https://example.com"],
    [{ id: "claude-todowrite", type: "tool", phase: "call", toolId: "claude.TodoWrite", title: "claude.TodoWrite", status: "complete", input: { todos: [] } }, "planning", "Planned TodoWrite"],
  ];
  for (const [part, kind, title] of claudeToolCases) {
    const [item] = buildActivityItems([part]);
    assert.equal(activityItemKind(item), kind, part.toolId);
    assert.equal(activityItemTitle(item), title, part.toolId);
    assert.doesNotMatch(activityItemTitle(item), /claude\\./, part.toolId);
  }

  assert.equal(agentOrbStateFromRun([], []), "working");
  assert.equal(agentOrbStateFromRun([
    { type: "tool.started", runId: "orb-read", toolId: "claude.Read", input: { file_path: "README.md" } },
  ], [], "orb-read"), "searching");
  assert.equal(agentOrbStateFromRun([
    { type: "assistant.delta", runId: "orb-compose", text: "正在输出" },
  ], [], "orb-compose"), "composing");
  assert.equal(agentOrbStateFromRun([
    { type: "assistant.delta", runId: "orb-edit", text: "先说明一下" },
    { type: "tool.started", runId: "orb-edit", toolId: "claude.Edit", input: { file_path: "README.md" } },
  ], [], "orb-edit"), "working");
  assert.equal(agentOrbStateFromRun([
    { type: "assistant.delta", runId: "orb-search", text: "先说明一下" },
    { type: "tool.started", runId: "orb-search", toolId: "claude.Grep", input: { pattern: "AgentState", path: "web/src" } },
    { type: "runtime.diagnostic", runId: "orb-search", name: "internal.status", data: {} },
  ], [], "orb-search"), "searching");
  assert.equal(agentOrbStateFromRun([
    { type: "tool.started", runId: "orb-compose-after-read", toolId: "claude.Read", input: { file_path: "README.md" } },
    { type: "tool.finished", runId: "orb-compose-after-read", toolId: "claude.Read", result: { ok: true, value: {} } },
    { type: "assistant.delta", runId: "orb-compose-after-read", text: "读完了" },
  ], [], "orb-compose-after-read"), "composing");
  assert.equal(agentOrbStateFromRun([
    { type: "assistant.delta", runId: "another-run", text: "不能串到当前消息" },
  ], [], "current-run"), "working");
  assert.equal(agentOrbStateFromRun([
    { type: "assistant.delta", runId: "another-run", text: "缺少 runId 时也不能串进当前消息" },
  ]), "working");
  const orbRunningSearchGroups = splitAssistantPartsForSurface([{
    id: "orb-running-search",
    type: "tool",
    phase: "call",
    toolId: "codex.webSearch",
    title: "Web Search",
    status: "running",
    input: { query: "OpenGrove" },
  }], "orb-running-search-message").processGroups;
  assert.equal(agentOrbStateFromRun(undefined, orbRunningSearchGroups), "searching");
  assert.equal(agentOrbStateFromRun([
    { type: "tool.finished", runId: "orb-concurrent", toolId: "claude.Read", result: { ok: true, value: {} } },
  ], orbRunningSearchGroups, "orb-concurrent"), "searching");

  const [unknownClaudeItem] = buildActivityItems([{
    id: "claude-unknown",
    type: "tool",
    phase: "call",
    toolId: "claude.FutureTool",
    title: "claude.FutureTool",
    status: "complete",
    input: {},
  }]);
  assert.equal(activityItemKind(unknownClaudeItem), "tool");
  assert.equal(activityItemTitle(unknownClaudeItem), "Called FutureTool");
  assert.doesNotMatch(activityItemTitle(unknownClaudeItem), /claude\\./);

  const legacyClaudeAgentParts = normalizeMessagePartsForDisplay([
    { id: "legacy-hook-note", type: "note", text: "claude.sdk.hook_started", tone: "status" },
    {
      id: "legacy-agent-call",
      type: "tool",
      phase: "call",
      toolId: "claude.Agent",
      title: "claude.Agent",
      status: "complete",
      input: {
        description: "Check auto-material config",
        subagent_type: "Explore",
        prompt: "I need to check if the auto-material employee has all required configuration. SECRET_PROMPT_SHOULD_NOT_RENDER",
      },
    },
    {
      id: "legacy-agent-result",
      type: "tool",
      phase: "result",
      toolId: "claude.Agent",
      title: "claude.Agent",
      status: "complete",
      result: {
        status: "completed",
        prompt: "I need to check if the auto-material employee has all required configuration. SECRET_PROMPT_SHOULD_NOT_RENDER",
        agentType: "Explore",
        content: [{ type: "text", text: "AGENT_CONTENT_SHOULD_NOT_RENDER" }],
      },
    },
  ]);
  const legacyAgentItems = buildActivityItems(legacyClaudeAgentParts);
  assert.equal(legacyAgentItems.length, 1);
  const legacyAgentItem = legacyAgentItems[0];
  assert.equal(activityItemKind(legacyAgentItem), "agent");
  const agentVisibleText = [
    activityItemTitle(legacyAgentItem),
    activityItemDetailDisplay(legacyAgentItem)?.label || "",
    activityItemDetailDisplay(legacyAgentItem, { full: true })?.label || "",
    activityItemTitleTooltip(legacyAgentItem),
    summarizeActivityItems(legacyAgentItems),
  ].join("\\n");
  assert.match(agentVisibleText, /Agent/);
  assert.match(agentVisibleText, /Explore/);
  assert.match(agentVisibleText, /Check auto-material config/);
  assert.doesNotMatch(agentVisibleText, /subagent_type|prompt|SECRET_PROMPT_SHOULD_NOT_RENDER|AGENT_CONTENT_SHOULD_NOT_RENDER|\{\s*"/);

  const commentarySplitGroups = splitAssistantPartsForSurface([
    {
      id: "room-commentary-note",
      type: "note",
      text: "Codex commentary should stay in process",
      tone: "status",
      data: {
        source: "codex",
        kind: "agent_message",
        phase: "commentary",
        itemId: "assistant-commentary",
      },
    },
    { id: "room-commentary-final", type: "text", text: "QA_ROOM_COMMENTARY_FINAL" },
  ], "message-room-commentary");
  assert.equal(commentarySplitGroups.answerGroups.length, 1);
  assert.equal(commentarySplitGroups.answerGroups[0].part.text, "QA_ROOM_COMMENTARY_FINAL");
  assert.equal(commentarySplitGroups.processGroups.length, 1);
  assert.equal(commentarySplitGroups.processGroups[0].type, "note");
  assert.deepEqual(commentarySplitGroups.segments.map((segment) => segment.type), ["process", "content"]);

  const claudeCommentarySplitGroups = splitAssistantPartsForSurface([
    {
      id: "claude-tool-before-commentary",
      type: "tool",
      phase: "call",
      toolId: "claude.Read",
      title: "claude.Read",
      status: "complete",
      input: { file_path: "README.md" },
    },
    {
      id: "claude-commentary-note",
      type: "note",
      text: "Claude SDK commentary should render like Codex prose",
      tone: "status",
      data: {
        source: "claude-sdk",
        kind: "agent_message",
        phase: "commentary",
        claudeKind: "tool_use_preamble",
      },
    },
    { id: "claude-commentary-final", type: "text", text: "QA_CLAUDE_COMMENTARY_FINAL" },
  ], "message-claude-commentary");
  assert.equal(claudeCommentarySplitGroups.answerGroups.length, 1);
  assert.equal(claudeCommentarySplitGroups.answerGroups[0].part.text, "QA_CLAUDE_COMMENTARY_FINAL");
  assert.equal(claudeCommentarySplitGroups.processGroups.length, 2);
  assert.equal(claudeCommentarySplitGroups.processGroups[0].type, "activity");
  assert.equal(claudeCommentarySplitGroups.processGroups[1].type, "note");
  assert.deepEqual(claudeCommentarySplitGroups.segments.map((segment) => segment.type), ["process", "content"]);

  const bashCorrelationParts = [];
  for (let index = 1; index <= 5; index += 1) {
    bashCorrelationParts.push({
      id: \`bash-call-\${index}\`,
      type: "tool",
      phase: "call",
      toolId: "claude.Bash",
      callId: \`bash-\${index}\`,
      title: "claude.Bash",
      status: "running",
      input: { command: \`echo \${index}\` },
    });
    if (index < 5) {
      bashCorrelationParts.push({
        id: \`bash-commentary-\${index}\`,
        type: "note",
        text: \`Command \${index} completed\`,
        tone: "status",
        data: { source: "claude-sdk", kind: "agent_message", phase: "commentary" },
      });
    }
    bashCorrelationParts.push({
      id: \`bash-result-\${index}\`,
      type: "tool",
      phase: "result",
      toolId: "claude.Bash",
      callId: \`bash-\${index}\`,
      title: "claude.Bash",
      status: "complete",
      result: { stdout: String(index) },
    });
  }
  const bashCorrelationGroups = splitAssistantPartsForSurface(
    bashCorrelationParts,
    "message-bash-correlation",
  ).processGroups;
  const bashCorrelationItems = processGroupsToActivityEntries(bashCorrelationGroups)
    .map(({ item }) => item);
  assert.equal(
    bashCorrelationItems.filter((item) => activityItemKind(item) === "command").length,
    5,
    "commentary boundaries must not double-count a tool call and its result",
  );
  assert.equal(
    bashCorrelationItems.filter((item) => item.type === "tool" && item.call && item.result).length,
    5,
    "tool lifecycle pairing must span process groups",
  );
  assert.match(summarizeActivityItems(bashCorrelationItems), /5 commands/);

  const parallelSameToolItems = buildActivityItems([
    { id: "parallel-call-a", type: "tool", phase: "call", toolId: "claude.Read", callId: "call-a", title: "claude.Read", status: "running", input: { file_path: "a.md" } },
    { id: "parallel-call-b", type: "tool", phase: "call", toolId: "claude.Read", callId: "call-b", title: "claude.Read", status: "running", input: { file_path: "b.md" } },
    { id: "parallel-result-b", type: "tool", phase: "result", toolId: "claude.Read", callId: "call-b", title: "claude.Read", status: "complete", result: { file: "b.md" } },
    { id: "parallel-result-a", type: "tool", phase: "result", toolId: "claude.Read", callId: "call-a", title: "claude.Read", status: "complete", result: { file: "a.md" } },
  ]);
  assert.equal(parallelSameToolItems.length, 2);
  assert.deepEqual(parallelSameToolItems.map((item) => item.type === "tool" ? item.result?.result : undefined), [
    { file: "a.md" },
    { file: "b.md" },
  ]);
  const mixedRolloutItems = buildActivityItems([
    { id: "mixed-legacy-call", type: "tool", phase: "call", toolId: "claude.Read", title: "claude.Read", status: "running", input: { file_path: "legacy.md" } },
    { id: "mixed-native-call", type: "tool", phase: "call", toolId: "claude.Read", callId: "native-b", title: "claude.Read", status: "running", input: { file_path: "native.md" } },
    { id: "mixed-native-result", type: "tool", phase: "result", toolId: "claude.Read", callId: "native-b", title: "claude.Read", status: "complete", result: { file: "native.md" } },
    { id: "mixed-legacy-result", type: "tool", phase: "result", toolId: "claude.Read", title: "claude.Read", status: "complete", result: { file: "legacy.md" } },
  ]);
  assert.deepEqual(
    mixedRolloutItems.map((item) => item.type === "tool" ? item.result?.result : undefined),
    [{ file: "legacy.md" }, { file: "native.md" }],
    "exact native-ID matches must be reserved before mixed-version FIFO fallback",
  );
  assert.equal(
    buildActivityItems([
      { id: "mixed-id-call", type: "tool", phase: "call", toolId: "claude.Read", callId: "call-only-id", title: "claude.Read", status: "running" },
      { id: "mixed-no-id-result", type: "tool", phase: "result", toolId: "claude.Read", title: "claude.Read", status: "complete", result: { file: "mixed.md" } },
    ]).length,
    1,
    "a mid-rollout call/result pair with only one callId must remain one activity item",
  );
  assert.equal(
    buildActivityItems([
      { id: "legacy-call", type: "tool", phase: "call", toolId: "claude.Read", title: "claude.Read", status: "running", input: { file_path: "legacy.md" } },
      { id: "legacy-result", type: "tool", phase: "result", toolId: "claude.Read", title: "claude.Read", status: "complete", result: { file: "legacy.md" } },
    ]).length,
    1,
    "legacy persisted records without callId must retain tool-name FIFO pairing",
  );

  // Phase 4: source-neutral 泛化 —— 未知 source 带 commentary phase 也应识别为评注,
  // 新 kernel 接入无需改 isNativeAgentCommentaryNote。
  const novelCommentarySplitGroups = splitAssistantPartsForSurface([
    {
      id: "novel-commentary-note",
      type: "note",
      text: "Novel kernel commentary should render like existing prose",
      tone: "status",
      data: {
        source: "novel-kernel",
        kind: "agent_message",
        phase: "commentary",
      },
    },
    { id: "novel-commentary-final", type: "text", text: "QA_NOVEL_COMMENTARY_FINAL" },
  ], "message-novel-commentary");
  assert.equal(novelCommentarySplitGroups.answerGroups.length, 1, "novel commentary stays in process");
  assert.equal(novelCommentarySplitGroups.answerGroups[0].part.text, "QA_NOVEL_COMMENTARY_FINAL");
  assert.equal(novelCommentarySplitGroups.processGroups.length, 1);
  assert.equal(novelCommentarySplitGroups.processGroups[0].type, "note");

  // Phase 4: 未知 source 的 final_answer 应识别为正文,不进 process。
  const novelFinalSplitGroups = splitAssistantPartsForSurface([
    {
      id: "novel-final-note",
      type: "note",
      text: "Novel final answer should not be treated as commentary",
      tone: "status",
      data: {
        source: "novel-kernel",
        kind: "agent_message",
        phase: "final_answer",
      },
    },
    { id: "novel-final-text", type: "text", text: "QA_NOVEL_FINAL_ANSWER" },
  ], "message-novel-final");
  assert.equal(novelFinalSplitGroups.answerGroups.length, 1, "novel final_answer: only text in answer");
  assert.equal(novelFinalSplitGroups.answerGroups[0].part.text, "QA_NOVEL_FINAL_ANSWER");
  assert.doesNotMatch(
    JSON.stringify(novelFinalSplitGroups.answerGroups),
    /Novel final answer should not be treated as commentary/,
    "novel final_answer note must not leak into answer as commentary",
  );

  assert.equal(isNativeAgentCommentaryNote({
    id: "agent-message-without-phase",
    type: "note",
    text: "Agent message without phase should not render as commentary prose",
    tone: "status",
    data: {
      source: "novel-kernel",
      kind: "agent_message",
    },
  }), false, "agent_message without phase is final/answer-class, not commentary");

  const contextUsageEvents = [
    { type: "model.response", runId: "run-current", response: { usage: { contextWindowSize: 1000, contextUsedTokens: 200 } } },
    { type: "model.response", runId: "run-other", response: { usage: { contextWindowSize: 1000, contextUsedTokens: 900 } } },
  ];
  assert.deepEqual(latestContextUsage(contextUsageEvents, { runIds: ["run-current"] }), { used: 200, total: 1000 });
  assert.equal(latestContextUsage(contextUsageEvents, { runIds: [] }), undefined);
  assert.deepEqual(latestContextUsage(contextUsageEvents), { used: 900, total: 1000 });
  assert.equal(
    latestContextUsage([{
      type: "model.response",
      runId: "run-cumulative-only",
      response: { usage: { contextWindowSize: 1000, totalTokens: 5000 } },
    }], { runIds: ["run-cumulative-only"] }),
    undefined,
    "cumulative billing totals must not be presented as current context occupancy",
  );
  assert.equal(
    latestContextUsage([
      {
        type: "model.response",
        runId: "run-stale-native-context",
        response: { usage: { contextWindowSize: 1000, contextUsedTokens: 200 } },
      },
      {
        type: "model.response",
        runId: "run-stale-native-context",
        response: { usage: { contextWindowSize: 1000, totalTokens: 5000 } },
      },
    ], { runIds: ["run-stale-native-context"] }),
    undefined,
    "a newer response with unavailable occupancy must hide the ring instead of reusing stale native usage",
  );

  const retiredConnectorDiagnosticMessage = {
    id: "message-retired-connector-diagnostics",
    role: "assistant",
    text: "",
    context: null,
    pending: true,
    parts: [],
  };
  for (const name of [
    "cloud_connector.dispatch",
    "cloud_connector.run_status",
    "cloud_connector.activity",
    "cloud_connector_unavailable",
  ]) {
    applyStreamEventToMessage(retiredConnectorDiagnosticMessage, {
      type: "runtime.diagnostic",
      runId: "run-retired-connector-diagnostics",
      name,
      data: { text: "Tool started: host.ui.requestChoices" },
    });
  }
  assert.deepEqual(retiredConnectorDiagnosticMessage.parts, []);
  assert.deepEqual(
    normalizeMessagePartsForDisplay([
      {
        id: "internal-diagnostic-note",
        type: "note",
        text: "运行诊断 · codex reasoning summary part",
        tone: "diagnostic",
      },
    ]),
    [],
    "runtime diagnostics remain available to Ops but must not render as chat content",
  );
  const actionableErrorMessage = {
    id: "message-actionable-runtime-error",
    role: "assistant",
    text: "",
    context: null,
    pending: true,
    parts: [],
  };
  applyStreamEventToMessage(actionableErrorMessage, {
    type: "error",
    runId: "run-actionable-runtime-error",
    message: "连接已中断，请重试。",
    diagnostics: { upstreamRequestId: "req-internal-only" },
  });
  assert.equal(actionableErrorMessage.pending, false);
  assert.doesNotMatch(JSON.stringify(actionableErrorMessage.parts), /req-internal-only/);
  assert.match(
    normalizeMessagePartsForDisplay(actionableErrorMessage.parts)
      .map((part) => part.type === "note" ? part.text : "")
      .join("\\n"),
    /连接已中断，请重试。/,
    "actionable runtime errors must remain visible even though diagnostic telemetry is hidden",
  );

  const renderedRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-render-process",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "done",
      duration: "25s",
      createdAt,
      parts: [
        { id: "render-answer", type: "text", text: "我会用本地版继续。" },
        {
          id: "render-command",
          type: "tool",
          phase: "call",
          toolId: "codex.commandExecution",
          title: "codex.commandExecution",
          status: "complete",
          input: { command: "/bin/zsh -lc 'git diff'", cwd: "/tmp" },
        },
      ],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
    onReplyMessage() {},
    onDeleteMessage() {},
  }));
  assert.match(renderedRoomStream, /class="og-disclosure og-disclosure--room-run"/);
  assert.match(renderedRoomStream, /class="og-disclosure-toggle"/);
  assert.match(renderedRoomStream, /aria-expanded="false"/);
  assert.doesNotMatch(renderedRoomStream, /消息操作|room-chat-message-action-trigger|room-chat-message-actions/);
  assert.match(renderedRoomStream, /Ran 1 command · 25s/);
  assert.doesNotMatch(renderedRoomStream, /Explored|Thought|Delegated an agent/);
  assert.doesNotMatch(renderedRoomStream, /class="room-work-divider"|class="thread-activity-row status-complete"|room-chat-status/);
  {
    const processIndex = renderedRoomStream.indexOf("og-disclosure-toggle");
    const answerIndex = renderedRoomStream.indexOf("我会用本地版继续。");
    assert.ok(processIndex >= 0 && answerIndex >= 0, "expected room process summary and answer to render");
    assert.ok(processIndex < answerIndex, "room process bar stays above the final answer");
  }

  const delegatedRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    roomId: "room-delegation-visibility",
    messages: [
      {
        id: "message-pm-final",
        senderId: "member-app-story-seed-pm",
        senderName: "故事种子 PM",
        senderType: "agent",
        text: "PM_FINAL_ROUTE_RECEIPT",
        targetIds: [],
        status: "done",
        createdAt,
      },
      {
        id: "message-pm-delegation-transport",
        senderId: "member-app-story-seed-pm",
        senderName: "故事种子 PM",
        senderType: "agent",
        text: "PM_DELEGATION_TRANSPORT_SHOULD_NOT_RENDER",
        targetIds: ["member-app-story-seed-architect"],
        status: "done",
        deliveryKind: "pm_auto_route",
        createdAt,
      },
      {
        id: "message-agent-delegation-transport",
        senderId: "member-app-story-seed-architect",
        senderName: "故事架构师",
        senderType: "agent",
        text: "AGENT_DELEGATION_TRANSPORT_SHOULD_NOT_RENDER",
        targetIds: ["member-app-story-seed-editor"],
        status: "done",
        deliveryKind: "agent_delegation",
        createdAt,
      },
      {
        id: "message-architect-final",
        senderId: "member-app-story-seed-architect",
        senderName: "故事架构师",
        senderType: "agent",
        text: "ARCHITECT_FINAL_RESPONSE",
        targetIds: [],
        status: "done",
        createdAt,
      },
    ],
    members: [],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
  }));
  assert.match(delegatedRoomStream, /PM_FINAL_ROUTE_RECEIPT/);
  assert.match(delegatedRoomStream, /ARCHITECT_FINAL_RESPONSE/);
  assert.doesNotMatch(delegatedRoomStream, /PM_DELEGATION_TRANSPORT_SHOULD_NOT_RENDER/);
  assert.doesNotMatch(delegatedRoomStream, /AGENT_DELEGATION_TRANSPORT_SHOULD_NOT_RENDER/);

  const sidebarVisibleMessage = {
    id: "message-sidebar-visible",
    senderId: "member-app-story-seed-architect",
    senderName: "故事架构师",
    senderType: "agent",
    text: "SIDEBAR_LAST_VISIBLE_MESSAGE",
    targetIds: [],
    status: "done",
    createdAt,
  };
  const sidebarHiddenTransport = {
    id: "message-sidebar-hidden-transport",
    senderId: "member-app-story-seed-pm",
    senderName: "故事种子 PM",
    senderType: "agent",
    text: "SIDEBAR_HIDDEN_TRANSPORT_MESSAGE",
    targetIds: ["member-app-story-seed-architect"],
    status: "done",
    deliveryKind: "pm_auto_route",
    createdAt,
  };
  const delegationPreviewRoom = {
    id: "room-delegation-preview",
    kind: "group",
    title: "Transport Preview Room",
    badge: "",
    memberIds: [],
    messages: [sidebarVisibleMessage, sidebarHiddenTransport],
    updatedAt: createdAt,
    unread: 0,
  };
  const renderDelegationSidebar = (roomQuery) => renderToStaticMarkup(React.createElement(RoomSidebar, {
    activeRoom: delegationPreviewRoom,
    rooms: [delegationPreviewRoom],
    members: [],
    roomQuery,
    createMenuRef: { current: null },
    createMenuOpen: false,
    onToggleCreateMenu() {},
    onCreateGroup() {},
    onRecruitEmployee() {},
    onOpenContacts() {},
    onRoomQueryChange() {},
    onOpenRoom() {},
    onOpenDirectMember() {},
  }));
  const delegatedRoomSidebar = renderDelegationSidebar("Transport Preview Room");
  assert.match(delegatedRoomSidebar, /SIDEBAR_LAST_VISIBLE_MESSAGE/);
  assert.doesNotMatch(delegatedRoomSidebar, /SIDEBAR_HIDDEN_TRANSPORT_MESSAGE/);
  assert.match(
    renderDelegationSidebar("SIDEBAR_HIDDEN_TRANSPORT_MESSAGE"),
    /No matching conversations or installed kernels/,
    "room search must not match a transport message hidden from the chat projection",
  );

  const roomParityCommentary = "在。操盘手(campaign)再检一次，结论未变。";
  const parityRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-room-parity-process",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "ROOM_PARITY_FINAL_ANSWER",
      targetIds: [],
      status: "done",
      duration: "38.4s",
      createdAt,
      parts: [
        {
          id: "room-parity-commentary",
          type: "note",
          text: roomParityCommentary,
          tone: "status",
          data: {
            source: "claude-sdk",
            kind: "agent_message",
            phase: "commentary",
          },
        },
        { id: "room-parity-hook", type: "note", text: "claude.sdk.hook_response", tone: "status" },
        {
          id: "room-parity-reasoning",
          type: "reasoning",
          reasoningId: "room-parity-reasoning-native",
          kernelId: "claude-code",
          kind: "native",
          text: "ROOM_NATIVE_REASONING_PROCESS_TEXT",
          status: "complete",
          redacted: false,
          elapsedMs: 12000,
        },
        {
          id: "room-parity-agent-call",
          type: "tool",
          phase: "call",
          toolId: "claude.Agent",
          title: "claude.Agent",
          status: "complete",
          input: {
            description: "Check campaign config",
            subagent_type: "Explore",
            prompt: "INTERNAL_AGENT_PROMPT_SHOULD_NOT_RENDER",
          },
        },
        {
          id: "room-parity-agent-result",
          type: "tool",
          phase: "result",
          toolId: "claude.Agent",
          title: "claude.Agent",
          status: "complete",
          result: {
            status: "completed",
            prompt: "INTERNAL_AGENT_PROMPT_SHOULD_NOT_RENDER",
            agentType: "Explore",
            content: [{ type: "text", text: "AGENT_CONTENT_SHOULD_NOT_RENDER" }],
          },
        },
        {
          id: "room-parity-question",
          type: "tool",
          phase: "question",
          toolId: "question",
          title: "Question",
          input: { params: { title: "继续吗？" } },
          status: "requires-action",
          questionId: "room-parity-question",
          questionStatus: "pending",
          questionPrompt: "继续吗？",
          questionInput: { params: { title: "继续吗？" } },
        },
        { id: "room-parity-final", type: "text", text: "ROOM_PARITY_FINAL_ANSWER" },
      ],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
    onReplyMessage() {},
    onDeleteMessage() {},
  }));
  assert.match(parityRoomStream, /class="og-disclosure-toggle" aria-expanded="false"/);
  assert.match(parityRoomStream, /Delegated an agent · 38\.4s/);
  assert.doesNotMatch(parityRoomStream, /Explored|Thought|Ran/);
  assert.doesNotMatch(parityRoomStream, new RegExp(roomParityCommentary), "collapsed process details must not leak commentary into the chat timeline");
  assert.match(parityRoomStream, /class="thread-question-card"/);
  assert.doesNotMatch(parityRoomStream, /claude\.sdk\.hook_|ROOM_NATIVE_REASONING_PROCESS_TEXT|subagent_type|INTERNAL_AGENT_PROMPT_SHOULD_NOT_RENDER|AGENT_CONTENT_SHOULD_NOT_RENDER|\{\s*&quot;/);
  assert.match(parityRoomStream, /ROOM_PARITY_FINAL_ANSWER/);

  const answeredQuestionParts = [{
    id: "room-answered-question",
    type: "tool",
    phase: "question",
    toolId: "question",
    title: "Question",
    status: "answered",
    questionId: "room-answered-question",
    questionStatus: "answered",
    questionPrompt: "本次怎么推进？",
    questionInput: {
      questions: [
        { id: "direction", title: "本次怎么推进？" },
        { id: "pace", title: "节奏怎么样？" },
      ],
    },
    result: {
      answers: {
        direction: { answers: ["功能开发"] },
        pace: { answers: ["轻松一点"] },
      },
    },
  }];
  const answeredQuestionSplit = splitAssistantPartsForSurface(answeredQuestionParts, "message-answered-question");
  assert.equal(answeredQuestionSplit.answerGroups.length, 1);
  assert.equal(answeredQuestionSplit.answerGroups[0].type, "question");
  assert.equal(answeredQuestionSplit.processGroups.length, 0, "native questions belong to the chat timeline, not process details");
  const answeredQuestionRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-answered-question",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "done",
      createdAt,
      parts: answeredQuestionParts,
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.match(answeredQuestionRoomStream, /class="thread-question-summary is-answered"/);
  assert.match(answeredQuestionRoomStream, /本次怎么推进？/);
  assert.match(answeredQuestionRoomStream, /功能开发/);
  assert.match(answeredQuestionRoomStream, /节奏怎么样？/);
  assert.match(answeredQuestionRoomStream, /轻松一点/);
  assert.doesNotMatch(answeredQuestionRoomStream, /class="og-disclosure/);

  const declinedQuestionPart = {
    ...answeredQuestionParts[0],
    id: "room-declined-question",
    status: "declined",
    questionId: "room-declined-question",
    questionStatus: "declined",
    result: { error: "Question request aborted: room-declined-question" },
  };
  const declinedQuestionRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-declined-question",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "interrupted",
      createdAt,
      parts: [declinedQuestionPart],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.match(declinedQuestionRoomStream, /class="thread-question-summary is-declined"/);
  assert.match(declinedQuestionRoomStream, /Skipped/);
  assert.doesNotMatch(declinedQuestionRoomStream, /Question request aborted/);

  const cyclicQuestionResult = {};
  cyclicQuestionResult.answer = cyclicQuestionResult;
  let deeplyNestedQuestionResult = { answer: "must-not-render" };
  for (let index = 0; index < 40; index += 1) {
    deeplyNestedQuestionResult = { answer: deeplyNestedQuestionResult };
  }
  const unreadableQuestionResult = Object.defineProperty({}, "answer", {
    enumerable: true,
    get() {
      throw new Error("question getter exploded");
    },
  });
  for (const [caseName, result] of [
    ["empty", {}],
    ["null", null],
    ["error", { error: "Question request aborted" }],
    ["cyclic", { answers: { direction: cyclicQuestionResult } }],
    ["deep", { answers: { direction: deeplyNestedQuestionResult } }],
    ["unreadable", { answers: { direction: unreadableQuestionResult } }],
  ]) {
    const malformedAnswerRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
      messages: [{
        id: "message-malformed-question-" + caseName,
        senderId: finalMember.id,
        senderName: finalMember.name,
        senderType: "agent",
        text: "",
        targetIds: [],
        status: "done",
        createdAt,
        parts: [{
          ...answeredQuestionParts[0],
          id: "room-malformed-question-" + caseName,
          questionId: "room-malformed-question-" + caseName,
          result,
        }],
      }],
      members: [finalMember],
      runtimeEventsByRunId: new Map(),
      onResolveApproval() {},
      onResolveQuestion() {},
      onInsertPrompt() {},
      onSubmitPrompt() {},
    }));
    assert.match(malformedAnswerRoomStream, /Answered; content cannot be displayed/, caseName);
  }

  const cyclicActivityArray = [];
  cyclicActivityArray.push(cyclicActivityArray);
  const cyclicReadActivity = {
    type: "tool",
    key: "cyclic-read-result",
    result: {
      id: "cyclic-read-result",
      type: "tool",
      phase: "result",
      toolId: "Read",
      title: "Read",
      status: "complete",
      result: cyclicActivityArray,
    },
  };
  assert.equal(activityItemDetailDisplay(cyclicReadActivity), null);

  const cyclicActivityObject = {};
  cyclicActivityObject.self = cyclicActivityObject;
  const cyclicGenericActivity = {
    type: "tool",
    key: "cyclic-generic-result",
    result: {
      id: "cyclic-generic-result",
      type: "tool",
      phase: "result",
      toolId: "custom",
      title: "custom",
      status: "complete",
      result: cyclicActivityObject,
    },
  };
  assert.equal(activityItemTitleTooltip(cyclicGenericActivity), "");
  assert.equal(editDiffFromItem(cyclicGenericActivity), null);

  let deeplyNestedActivityResult = { path: "/tmp/beyond-depth-limit.txt" };
  for (let index = 0; index < 80; index += 1) {
    deeplyNestedActivityResult = { child: deeplyNestedActivityResult };
  }
  assert.equal(activityItemTitleTooltip({
    ...cyclicGenericActivity,
    key: "deeply-nested-result",
    result: { ...cyclicGenericActivity.result, id: "deeply-nested-result", result: deeplyNestedActivityResult },
  }), "/tmp/beyond-depth-limit.txt");

  const wideActivityResult = Array.from({ length: 10_100 }, () => ({}));
  wideActivityResult[wideActivityResult.length - 1] = { path: "/tmp/beyond-node-limit.txt" };
  assert.equal(activityItemTitleTooltip({
    ...cyclicGenericActivity,
    key: "wide-result",
    result: { ...cyclicGenericActivity.result, id: "wide-result", result: wideActivityResult },
  }), "/tmp/beyond-node-limit.txt");

  useUiStore.getState().replaceMessages([{
    id: "message-cyclic-store-result",
    role: "assistant",
    text: "",
    context: null,
    pending: false,
    runId: "",
    parts: [{
      id: "part-cyclic-store-result",
      type: "tool",
      phase: "result",
      toolId: "custom",
      title: "custom",
      status: "complete",
      result: cyclicActivityObject,
    }],
  }]);
  assert.deepEqual(useUiStore.getState().messages[0]?.parts[0]?.result, {
    self: "[omitted circular reference]",
  });

  const legacyAgentRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-legacy-agent-render",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "FINAL_AGENT_ANSWER_VISIBLE",
      targetIds: [],
      status: "done",
      duration: "42s",
      createdAt,
      parts: [
        { id: "legacy-room-hook", type: "note", text: "claude.sdk.hook_started", tone: "status" },
        {
          id: "legacy-room-agent-call",
          type: "tool",
          phase: "call",
          toolId: "claude.Agent",
          title: "claude.Agent",
          status: "complete",
          input: {
            description: "Check campaign config",
            subagent_type: "Explore",
            prompt: "INTERNAL_AGENT_PROMPT_SHOULD_NOT_RENDER",
          },
        },
        {
          id: "legacy-room-agent-result",
          type: "tool",
          phase: "result",
          toolId: "claude.Agent",
          title: "claude.Agent",
          status: "complete",
          result: {
            status: "completed",
            prompt: "INTERNAL_AGENT_PROMPT_SHOULD_NOT_RENDER",
            agentType: "Explore",
            content: [{ type: "text", text: "AGENT_CONTENT_SHOULD_NOT_RENDER" }],
          },
        },
      ],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
    onReplyMessage() {},
    onDeleteMessage() {},
  }));
  assert.match(legacyAgentRoomStream, /FINAL_AGENT_ANSWER_VISIBLE/);
  assert.match(legacyAgentRoomStream, /Delegated an agent · 42s/);
  assert.doesNotMatch(legacyAgentRoomStream, /Explored|Thought|Ran/);
  assert.doesNotMatch(legacyAgentRoomStream, /claude\.sdk\.hook_|subagent_type|INTERNAL_AGENT_PROMPT_SHOULD_NOT_RENDER|AGENT_CONTENT_SHOULD_NOT_RENDER|\{\s*&quot;/);

  const legacyChineseFailureStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-legacy-chinese-failure",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "当前员工运行失败，请稍后重试。",
      targetIds: [],
      status: "failed",
      createdAt,
      parts: [{
        id: "legacy-chinese-failure-answer",
        type: "text",
        text: "当前员工运行失败，请稍后重试。",
      }],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
  }));
  assert.match(
    legacyChineseFailureStream,
    /当前员工运行失败/,
    "persisted legacy message content remains verbatim instead of being replaced by locale-specific fallback copy",
  );

  for (const [status, expectedSummary] of [
    ["failed", "Failed"],
    ["interrupted", "Interrupted"],
  ]) {
    const statusRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
      messages: [{
        id: "message-" + status + "-process",
        senderId: finalMember.id,
        senderName: finalMember.name,
        senderType: "agent",
        text: "",
        targetIds: [],
        status,
        duration: "13s",
        createdAt,
        parts: [{
          id: status + "-command",
          type: "tool",
          phase: "call",
          toolId: "codex.commandExecution",
          title: "codex.commandExecution",
          status: "complete",
          input: { command: "/bin/zsh -lc 'npm test'", cwd: "/tmp" },
        }],
      }],
      members: [finalMember],
      runtimeEventsByRunId: new Map(),
      onResolveApproval() {},
      onResolveQuestion() {},
      onInsertPrompt() {},
      onSubmitPrompt() {},
    }));
    assert.match(statusRoomStream, /class="og-disclosure-toggle"/);
    assert.match(statusRoomStream, new RegExp(expectedSummary));
    assert.doesNotMatch(statusRoomStream, /Processed/);
  }

  const runningRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-running-collapsed-process",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      createdAt,
      runId: "run-running-collapsed-process",
      parts: [{
        id: "running-command",
        type: "tool",
        phase: "call",
        toolId: "codex.commandExecution",
        title: "codex.commandExecution",
        status: "running",
        input: { command: "/bin/zsh -lc 'git status'", cwd: "/tmp" },
      }],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
    onCancelRun() {},
  }));
  assert.match(runningRoomStream, /class="og-disclosure-toggle"/);
  assert.match(runningRoomStream, /aria-expanded="false"/);
  assert.match(runningRoomStream, />Running</);
  assert.doesNotMatch(runningRoomStream, /git status/);
  assert.match(runningRoomStream, /data-text-shimmer="true"/);
  assert.match(runningRoomStream, /class="agent-state-indicator room-run-agent-orb"/);
  assert.match(runningRoomStream, /class="room-run-leading-slot room-run-leading-control"/);
  assert.match(runningRoomStream, /class="room-run-leading-orb"/);
  assert.match(runningRoomStream, /class="room-run-leading-stop"/);
  assert.ok(
    runningRoomStream.indexOf('class="room-run-leading-slot room-run-leading-control"')
      < runningRoomStream.indexOf('class="og-disclosure-toggle"'),
    "the shared Orb/stop control must occupy the leading slot before the process summary",
  );
  assert.doesNotMatch(
    runningRoomStream,
    /class="room-work-divider"|class="room-chat-tools"|class="room-chat-thinking-row"/,
  );

  const pendingCancelRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-pending-cancel",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      createdAt,
      runId: "run-pending-cancel",
      parts: [{
        id: "pending-cancel-command",
        type: "tool",
        phase: "call",
        toolId: "codex.commandExecution",
        title: "codex.commandExecution",
        status: "running",
        input: { command: "/bin/zsh -lc 'git status'", cwd: "/tmp" },
      }],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    pendingCancelRunIds: new Set(["run-pending-cancel"]),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
    onCancelRun() {},
  }));
  assert.match(pendingCancelRoomStream, /class="room-run-leading-slot room-run-leading-control" disabled=""/);
  assert.match(pendingCancelRoomStream, /class="room-run-leading-orb"/);
  assert.match(pendingCancelRoomStream, /class="room-run-leading-stop"/);

  const initialRunningRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-initial-running",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      createdAt,
      runId: "run-initial-running",
      parts: [],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
    onCancelRun() {},
  }));
  assert.match(initialRunningRoomStream, /class="room-chat-thinking-row"/);
  assert.match(initialRunningRoomStream, /class="room-run-leading-slot room-run-leading-control"/);
  assert.doesNotMatch(initialRunningRoomStream, /class="room-chat-status-row"/);
  assert.ok(
    initialRunningRoomStream.indexOf('class="room-run-leading-slot room-run-leading-control"')
      < initialRunningRoomStream.indexOf('class="room-chat-thinking room-chat-agent-live"'),
    "the initial stop action must use the same leading Orb slot instead of appearing after the status text",
  );

  const runningRuntimeRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-running-runtime-process",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      createdAt,
      runId: "run-running-runtime-process",
      parts: [],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map([["run-running-runtime-process", [{
      type: "tool.started",
      runId: "run-running-runtime-process",
      toolId: "codex.commandExecution",
      input: { command: "/bin/zsh -lc 'git diff --stat'", cwd: "/tmp" },
    }]]]),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.match(runningRuntimeRoomStream, /class="og-disclosure-toggle"/);
  assert.match(runningRuntimeRoomStream, /aria-expanded="false"/);
  assert.match(runningRuntimeRoomStream, />Running</);
  assert.doesNotMatch(runningRuntimeRoomStream, /git diff --stat/);
  assert.match(runningRuntimeRoomStream, /class="agent-state-indicator room-run-agent-orb"/);
  assert.match(runningRuntimeRoomStream, /class="room-run-leading-slot"/);
  assert.doesNotMatch(runningRuntimeRoomStream, /room-run-leading-control|room-run-leading-stop/);
  assert.doesNotMatch(runningRuntimeRoomStream, /lucide-loader-circle/);
  assert.doesNotMatch(runningRuntimeRoomStream, /class="room-work-divider"|class="room-chat-tools"/);

  const runningKernelStream = renderToStaticMarkup(React.createElement(MessageList, {
    messages: [{
      id: "message-kernel-running-process",
      role: "assistant",
      text: "",
      context: null,
      pending: true,
      runId: "run-kernel-running-process",
      startedAt: "2026-06-02T00:00:00.000Z",
      parts: [
        {
          id: "kernel-running-read",
          type: "tool",
          phase: "call",
          toolId: "codex.commandExecution",
          title: "codex.commandExecution",
          status: "complete",
          input: { command: "/bin/zsh -lc 'ls web/src'", cwd: "/tmp" },
        },
        {
          id: "kernel-running-search",
          type: "tool",
          phase: "call",
          toolId: "codex.commandExecution",
          title: "codex.commandExecution",
          status: "running",
          input: { command: "/bin/zsh -lc 'rg AssistantProcessBlock web/src'", cwd: "/tmp" },
        },
      ],
    }],
    runtimeEvents: [],
    runs: [],
    onResolveApproval() {},
    onResolveQuestion() {},
  }));
  assert.match(runningKernelStream, /class="og-disclosure og-disclosure--process" data-open="false"/);
  assert.match(runningKernelStream, /class="og-disclosure-toggle" aria-expanded="false"/);
  assert.ok(runningKernelStream.includes("Running rg AssistantProcessBlock web/src"), runningKernelStream);
  assert.match(runningKernelStream, /class="agent-state-indicator"/);
  assert.doesNotMatch(runningKernelStream, /lucide-loader-circle/);
  assert.doesNotMatch(
    runningKernelStream,
    /thread-activity-toggle|class="thread-activity-row status-running"|class="thread-activity-live-list"/,
  );

  const runtimeOnlyChoiceFormStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-runtime-choice-form",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      createdAt,
      runId: "run-runtime-choice-form",
      parts: [],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map([["run-runtime-choice-form", [{
      type: "tool.finished",
      runId: "run-runtime-choice-form",
      toolId: "host.ui.requestChoices",
      result: {
        ok: true,
        value: {
          kind: "choice_form",
          title: "选择继续方式",
          instructions: "请选择下一步",
          submitLabel: "继续",
          questions: [{
            id: "q1",
            prompt: "下一步？",
            options: [{ value: "continue", label: "继续", description: "继续当前任务", action: "submit" }],
          }],
        },
      },
    }]]]),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.match(runtimeOnlyChoiceFormStream, /aria-expanded="true"/);
  assert.match(runtimeOnlyChoiceFormStream, /class="thread-choice-form"/);
  assert.match(runtimeOnlyChoiceFormStream, /选择继续方式/);
  assert.doesNotMatch(runtimeOnlyChoiceFormStream, /&quot;kind&quot;|&quot;questions&quot;/);
  assert.doesNotMatch(runtimeOnlyChoiceFormStream, /host\.ui\.requestChoices/);

  const separatedChoiceValue = {
    kind: "choice_form",
    title: "跨评注选择",
    instructions: "请选择",
    submitLabel: "继续",
    questions: [{
      id: "q-separated",
      prompt: "继续吗？",
      options: [{ value: "yes", label: "继续", description: "继续任务", action: "submit" }],
    }],
  };
  const separatedChoiceParts = [
    { id: "separated-choice-call", type: "tool", phase: "call", toolId: "host.ui.requestChoices", callId: "choice-separated", title: "host.ui.requestChoices", status: "running", input: {} },
    {
      id: "separated-choice-commentary",
      type: "note",
      text: "Please choose how to continue.",
      tone: "status",
      data: { source: "claude-sdk", kind: "agent_message", phase: "commentary" },
    },
    { id: "separated-choice-result", type: "tool", phase: "result", toolId: "host.ui.requestChoices", callId: "choice-separated", title: "host.ui.requestChoices", status: "complete", result: separatedChoiceValue },
  ];
  const separatedChoiceRoomMessage = {
    id: "message-separated-choice",
    senderId: finalMember.id,
    senderName: finalMember.name,
    senderType: "agent",
    text: "",
    targetIds: [],
    status: "running",
    createdAt,
    parts: separatedChoiceParts,
  };
  const separatedChoiceGroups = splitAssistantPartsForSurface(
    separatedChoiceParts,
    separatedChoiceRoomMessage.id,
  ).processGroups;
  const separatedChoiceEntry = processGroupsToActivityEntries(separatedChoiceGroups)
    .find(({ item }) => Boolean(choiceFormFromItem(item)));
  const activeSeparatedRoomChoice = findActiveRoomChoiceForm([separatedChoiceRoomMessage]);
  assert.equal(activeSeparatedRoomChoice?.groupKey, separatedChoiceEntry?.groupKey);
  assert.equal(activeSeparatedRoomChoice?.memberId, finalMember.id);
  const separatedChoiceChatMessage = {
      id: "message-separated-choice-chat",
      role: "assistant",
      text: "",
      context: null,
      pending: true,
      parts: separatedChoiceParts,
  };
  const separatedChoiceChat = renderToStaticMarkup(React.createElement(MessageList, {
    messages: [separatedChoiceChatMessage],
    runtimeEvents: [],
    runs: [],
    onResolveApproval() {},
    onResolveQuestion() {},
    onSubmitPrompt() {},
  }));
  assert.match(separatedChoiceChat, /aria-expanded="true"/);
  assert.match(separatedChoiceChat, /跨评注选择/);
  assert.doesNotMatch(separatedChoiceChat, /disabled=""/);

  const claudeRunParts = [
    { id: "claude-run-call-1", type: "tool", phase: "call", toolId: "claude.Bash", title: "claude.Bash", status: "complete", input: { command: "/bin/zsh -lc 'ls bin/'" } },
    { id: "claude-run-result-1", type: "tool", phase: "result", toolId: "claude.Bash", title: "claude.Bash", status: "complete", result: { stdout: "drama-ops" } },
    { id: "claude-run-call-2", type: "tool", phase: "call", toolId: "claude.Bash", title: "claude.Bash", status: "complete", input: { command: "/bin/zsh -lc 'npm run check'" } },
    { id: "claude-run-result-2", type: "tool", phase: "result", toolId: "claude.Bash", title: "claude.Bash", status: "complete", result: { stdout: "ok" } },
    { id: "claude-run-approval", type: "tool", phase: "approval", toolId: "claude.Bash", title: "Bash", status: "rejected", approvalId: "approval-no", approvalStatus: "rejected", input: { command: "ls workspace/cache" } },
    { id: "claude-run-rejected-result", type: "tool", phase: "result", toolId: "claude.Bash", title: "claude.Bash", status: "incomplete", error: "Error: Rejected by user through OpenGrove.", result: "Error: Rejected by user through OpenGrove." },
  ];
  const claudeRunSplit = splitAssistantPartsForSurface(claudeRunParts, "message-claude-run-split");
  assert.equal(claudeRunSplit.answerGroups.filter((group) => group.type === "approval").length, 1);
  assert.equal(
    claudeRunSplit.processGroups
      .filter((group) => group.type === "activity")
      .flatMap((group) => buildActivityItems(group.parts))
      .filter((item) => item.type === "approval")
      .length,
    0,
    "approval interactions stay directly visible instead of being hidden in process details",
  );
  const claudeCollapsedRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-claude-collapsed-process",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "完成",
      targetIds: [],
      status: "done",
      duration: "150.6s",
      createdAt,
      runId: "run-claude-collapsed-process",
      parts: claudeRunParts,
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.match(claudeCollapsedRoomStream, /class="og-disclosure-toggle"/);
  assert.match(claudeCollapsedRoomStream, /aria-expanded="false"/);
  assert.match(claudeCollapsedRoomStream, /Ran 3 commands 1 error · 150\.6s/);
  assert.match(claudeCollapsedRoomStream, /class="thread-approval-interaction"/);
  assert.match(claudeCollapsedRoomStream, /Declined · Bash/);
  assert.doesNotMatch(claudeCollapsedRoomStream, /&quot;command&quot;/);
  assert.doesNotMatch(claudeCollapsedRoomStream, /claude\\.Bash/);
  assert.doesNotMatch(claudeCollapsedRoomStream, />Processed \\d+ items</);

  const claudeExpandedRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-claude-expanded-process",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "完成",
      targetIds: [],
      status: "running",
      duration: "150.6s",
      createdAt,
      runId: "run-claude-expanded-process",
      parts: [
        ...claudeRunParts,
        {
          id: "claude-run-native-reasoning",
          type: "reasoning",
          reasoningId: "claude-run-native-reasoning-event",
          kernelId: "claude-code",
          kind: "native",
          text: "ROOM_NATIVE_REASONING_PROCESS_TEXT",
          status: "complete",
          redacted: false,
        },
        {
          id: "claude-run-choice-form",
          type: "tool",
          phase: "result",
          toolId: "host.ui.requestChoices",
          title: "host.ui.requestChoices",
          status: "complete",
          result: {
            kind: "choice_form",
            title: "选择继续方式",
            instructions: "请选择下一步",
            submitLabel: "继续",
            questions: [{
              id: "q1",
              prompt: "下一步？",
              options: [{ value: "continue", label: "继续", description: "继续当前任务", action: "submit" }],
            }],
          },
        },
      ],
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.match(claudeExpandedRoomStream, /class="og-disclosure-toggle"/);
  assert.match(claudeExpandedRoomStream, /aria-expanded="true"/);
  assert.match(claudeExpandedRoomStream, /Waiting for a choice/);
  assert.match(claudeExpandedRoomStream, /Ran 2 commands/);
  assert.match(claudeExpandedRoomStream, /ROOM_NATIVE_REASONING_PROCESS_TEXT/);
  assert.doesNotMatch(claudeExpandedRoomStream, /已运行 ls bin/);
  assert.doesNotMatch(claudeExpandedRoomStream, /已运行 npm run check/);
  assert.match(claudeExpandedRoomStream, /Declined · Bash/);
  assert.match(claudeExpandedRoomStream, /Incomplete Bash/);
  assert.match(claudeExpandedRoomStream, /class="thread-choice-form"/);
  assert.match(claudeExpandedRoomStream, /class="thread-activity-toggle"/);
  assert.match(claudeExpandedRoomStream, /class="og-disclosure og-disclosure--exploration"/);
  assert.doesNotMatch(claudeExpandedRoomStream, /claude\\.Bash/);
  assert.doesNotMatch(claudeExpandedRoomStream, />Processed \\d+ items</);

  // Regression: a codex "tool → diagnostic → tool → diagnostic → tool" sequence must collapse
  // into ONE activity block, not fragment into several stacked "已运行 N 条命令" summaries.
  // (Process notes — tone diagnostic/status — must not break the surrounding activity group.)
  const interleavedParts = [
    { id: "il-cmd-1", type: "tool", phase: "call", toolId: "codex.commandExecution", title: "codex.commandExecution", status: "complete", input: { command: "/bin/zsh -lc 'ls'", cwd: "/tmp" } },
    { id: "il-diag-1", type: "note", text: "运行诊断 · codex.goal.cleared", tone: "diagnostic" },
    { id: "il-cmd-2", type: "tool", phase: "call", toolId: "codex.commandExecution", title: "codex.commandExecution", status: "complete", input: { command: "/bin/zsh -lc 'git status'", cwd: "/tmp" } },
    { id: "il-diag-2", type: "note", text: "运行诊断 · codex.goal.cleared", tone: "diagnostic" },
    { id: "il-cmd-3", type: "tool", phase: "call", toolId: "codex.commandExecution", title: "codex.commandExecution", status: "complete", input: { command: "/bin/zsh -lc 'git diff'", cwd: "/tmp" } },
    { id: "il-final", type: "text", text: "QA_INTERLEAVED_FINAL" },
  ];
  const interleavedSplit = splitAssistantPartsForSurface(interleavedParts, "message-interleaved-process");
  assert.equal(interleavedSplit.processGroups.filter((group) => group.type === "activity").length, 1);
  const interleavedRoomStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-interleaved-process",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "done",
      duration: "12s",
      createdAt,
      parts: interleavedParts,
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.match(interleavedRoomStream, /Ran 3 commands · 12s/);
  assert.doesNotMatch(interleavedRoomStream, /class="room-chat-tools"/);
  assert.match(interleavedRoomStream, /QA_INTERLEAVED_FINAL/);

  // One outer process bar stays in the message frame. Inside the expanded panel,
  // commentary/compaction boundaries split contiguous tool groups chronologically.
  const boundedTurnParts = [
    {
      id: "bounded-commentary-1",
      type: "note",
      text: "BOUNDARY_TEXT_ONE",
      tone: "status",
      data: { source: "codex", kind: "agent_message", phase: "commentary" },
    },
    { id: "bounded-read", type: "tool", phase: "call", toolId: "claude.Read", title: "claude.Read", status: "complete", input: { file_path: "README.md" } },
    { id: "bounded-read-result", type: "tool", phase: "result", toolId: "claude.Read", title: "claude.Read", status: "running", result: { type: "file", title: "README.md", path: "README.md" } },
    { id: "bounded-compact", type: "note", text: "上下文已自动压缩", tone: "compaction-finished" },
    { id: "bounded-search", type: "tool", phase: "call", toolId: "codex.commandExecution", title: "codex.commandExecution", status: "complete", input: { command: "/bin/zsh -lc 'rg boundary web/src'", cwd: "/tmp" } },
    {
      id: "bounded-commentary",
      type: "note",
      text: "BOUNDARY_TEXT_TWO",
      tone: "status",
      data: { source: "codex", kind: "agent_message", phase: "commentary" },
    },
    { id: "bounded-edit", type: "tool", phase: "call", toolId: "claude.Edit", title: "claude.Edit", status: "running", input: { file_path: "web/src/app.tsx" } },
    { id: "bounded-approval", type: "tool", phase: "approval", toolId: "claude.Edit", title: "Edit", status: "requires-action", approvalId: "bounded-approval", approvalStatus: "pending" },
    { id: "bounded-final", type: "text", text: "BOUNDARY_FINAL_ANSWER" },
  ];
  const boundedTurnSplit = splitAssistantPartsForSurface(boundedTurnParts, "message-bounded-turn");
  assert.deepEqual(boundedTurnSplit.segments.map((segment) => segment.type), ["process", "content", "content"]);
  assert.deepEqual(
    boundedTurnSplit.processGroups.map((group) => group.type),
    ["note", "activity", "note", "activity", "note", "activity"],
  );
  const boundedTurnStream = renderToStaticMarkup(React.createElement(RoomMessageStream, {
    messages: [{
      id: "message-bounded-turn",
      senderId: finalMember.id,
      senderName: finalMember.name,
      senderType: "agent",
      text: "",
      targetIds: [],
      status: "running",
      createdAt,
      parts: boundedTurnParts,
    }],
    members: [finalMember],
    runtimeEventsByRunId: new Map(),
    onResolveApproval() {},
    onResolveQuestion() {},
    onInsertPrompt() {},
    onSubmitPrompt() {},
  }));
  assert.equal((boundedTurnStream.match(/og-disclosure--room-run/g) || []).length, 1);
  assert.match(boundedTurnStream, /aria-expanded="false"/);
  assert.match(boundedTurnStream, /BOUNDARY_FINAL_ANSWER/);
  assert.match(boundedTurnStream, /class="thread-approval-interaction"/);
  assert.match(boundedTurnStream, /Waiting for confirmation · Edit/);
  assert.doesNotMatch(
    boundedTurnStream,
    /BOUNDARY_TEXT_ONE|BOUNDARY_TEXT_TWO|README\.md|class="thread-activity-row status-running"/,
    "collapsed process details stay hidden while pending approval remains directly visible",
  );
  assert.doesNotMatch(boundedTurnStream, /thread-artifact-card/);

  const renderedKernelStream = renderToStaticMarkup(React.createElement(MessageList, {
    messages: [{
      id: "message-kernel-render-process",
      role: "assistant",
      text: "",
      context: null,
      pending: false,
      runId: "run-kernel-render-process",
      startedAt: "2026-06-02T00:00:00.000Z",
      finishedAt: "2026-06-02T00:00:25.000Z",
      parts: [
        {
          id: "kernel-commentary",
          type: "note",
          text: "Codex native commentary",
          tone: "status",
          data: {
            source: "codex",
            kind: "agent_message",
            phase: "commentary",
            itemId: "assistant-commentary",
          },
        },
        { id: "kernel-connector-note", type: "note", text: "Connector 状态已更新", tone: "diagnostic" },
        {
          id: "kernel-command",
          type: "tool",
          phase: "call",
          toolId: "codex.commandExecution",
          title: "codex.commandExecution",
          status: "complete",
          input: { command: "/bin/zsh -lc 'git diff'", cwd: "/tmp" },
        },
        { id: "kernel-final-answer", type: "text", text: "QA_KERNEL_PROCESS_FINAL" },
      ],
    }],
    runtimeEvents: [],
    runs: [],
    onResolveApproval() {},
    onResolveQuestion() {},
  }));
  assert.match(renderedKernelStream, /class="og-disclosure og-disclosure--process"/);
  assert.match(renderedKernelStream, /class="og-disclosure-toggle"/);
  // Run duration is folded into the process-summary line (no separate turn-status row when a
  // process timeline is present), e.g. "已运行 1 条命令 · 25s".
  assert.match(renderedKernelStream, /Ran 1 command · 25s/);
  assert.doesNotMatch(renderedKernelStream, /class="thread-turn-status"/);
  assert.match(renderedKernelStream, /QA_KERNEL_PROCESS_FINAL/);
  assert.doesNotMatch(renderedKernelStream, /<details|<summary|thread-activity-toggle|class="thread-activity-row status-complete"|Codex native commentary|Connector 状态已更新/);
  // #1 Process summary (with folded-in duration) sits before the final answer.
  {
    const processIndex = renderedKernelStream.indexOf("og-disclosure-toggle");
    const answerIndex = renderedKernelStream.indexOf("QA_KERNEL_PROCESS_FINAL");
    assert.ok(processIndex >= 0 && answerIndex >= 0, "expected process summary and answer to both render");
    assert.ok(processIndex < answerIndex, "process summary should render before the final answer");
  }

  // #2/#3/#4 reasoning elapsed, edit +/- line counts, and exploration accordion.
  const activityDetailParts = [
    {
      id: "details-reasoning",
      type: "reasoning",
      reasoningId: "details-reasoning-event",
      kernelId: "codex",
      kind: "summary",
      text: "已理解需求",
      status: "complete",
      redacted: false,
      elapsedMs: 8000,
    },
    {
      id: "details-read-1",
      type: "tool",
      phase: "result",
      toolId: "codex.commandExecution",
      title: "codex.commandExecution",
      status: "complete",
      result: { type: "commandExecution", command: "cat web/src/app.tsx", cwd: "/repo" },
    },
    {
      id: "details-read-2",
      type: "tool",
      phase: "result",
      toolId: "codex.commandExecution",
      title: "codex.commandExecution",
      status: "complete",
      result: { type: "commandExecution", command: "rg useState web/src", cwd: "/repo" },
    },
    {
      id: "details-edit",
      type: "tool",
      phase: "result",
      toolId: "codex.fileChange",
      title: "codex.fileChange",
      status: "complete",
      result: { type: "fileChange", changes: { "web/src/app.tsx": { type: "modify", diff: "+12 -3" } } },
    },
  ];
  const activityDetailItems = buildActivityItems(activityDetailParts);
  const activityDetailSummary = summarizeActivityItems(activityDetailItems);
  // #2 reasoning elapsed surfaces in the collapsed summary.
  assert.match(activityDetailSummary, /Thought · 8s/);
  // #3 edit summary stays aggregate-only; concrete file names and +/- counts render one level lower.
  assert.ok(activityDetailSummary.includes("Edited 1 file"), activityDetailSummary);
  assert.ok(!activityDetailSummary.includes("+12 -3"), activityDetailSummary);
  // #4 consecutive read/search collapse into an exploration render node.
  const activityDetailNodes = buildActivityRenderNodes(activityDetailItems.map((item) => ({ groupKey: "details", item })));
  const explorationNode = activityDetailNodes.find((node) => node.type === "exploration");
  assert.ok(explorationNode, "expected an exploration cluster node");
  assert.equal(explorationNode.entries.length, 2);
  const editNode = activityDetailNodes.find((node) => node.type === "edit");
  assert.ok(editNode, "expected an edit cluster node");
  assert.equal(editNode.entries.length, 1);
  assert.equal(activityDetailNodes.some((node) => node.type === "item" && node.entry.item === activityDetailItems[0]), true);
  const singleReadNodes = buildActivityRenderNodes([{ groupKey: "details", item: activityDetailItems[1] }]);
  assert.equal(singleReadNodes[0]?.type, "exploration");
  assert.equal(singleReadNodes.length, 1);

  const skillInvokeItems = buildActivityItems([
    {
      id: "skill-invoke-call",
      type: "tool",
      phase: "call",
      toolId: "skill.invoke",
      title: "Invoke skill",
      status: "complete",
      input: { skill: "story-outline", args: "" },
    },
    {
      id: "skill-invoke-result",
      type: "tool",
      phase: "result",
      toolId: "skill.invoke",
      title: "Invoke skill",
      status: "complete",
      result: { status: "loaded", skillName: "story-outline", contentPreview: "FULL_SKILL_BODY" },
    },
  ]);
  assert.equal(activityItemKind(skillInvokeItems[0]), "skill");
  assert.match(activityItemTitle(skillInvokeItems[0]), /Used \\/story-outline/);
  assert.match(summarizeActivityItems(skillInvokeItems), /Used \\/story-outline/);
  const skillInvokeNodes = buildActivityRenderNodes([{ groupKey: "skill", item: skillInvokeItems[0] }]);
  assert.equal(skillInvokeNodes.length, 1);
  assert.equal(skillInvokeNodes[0]?.type, "skill", "skill.invoke should use a collapsed skill cluster");

  const skillLifecycleItem = buildActivityItems([{
    id: "skill-lifecycle",
    type: "skill",
    skillId: "skill.story-outline",
    skillName: "story-outline",
    title: "故事大纲共创",
    status: "loaded",
    contentPreview: "FULL_SKILL_BODY",
    allowedTools: [],
    model: "",
    effort: "",
    forkSessionId: "",
    result: "",
    description: "",
    whenToUse: "",
    source: "project",
    trust: "trusted",
    context: "inline",
    packId: "app.story-seed",
  }])[0];
  const skillLifecycleNodes = buildActivityRenderNodes([{ groupKey: "skill", item: skillLifecycleItem }]);
  assert.equal(skillLifecycleNodes[0]?.type, "skill", "skill lifecycle parts should share the collapsed skill cluster");
  const nativeMcpSkillItem = buildActivityItems([{
    id: "native-mcp-skill",
    type: "tool",
    phase: "result",
    toolId: "mcp__opengrove__skill_invoke",
    title: "skill_invoke",
    status: "complete",
    result: { skillName: "story-review", contentPreview: "FULL_REVIEW_SKILL_BODY" },
  }])[0];
  assert.equal(activityItemKind(nativeMcpSkillItem), "skill", "native MCP skill.invoke names should collapse too");
  const combinedSkillNodes = buildActivityRenderNodes([
    { groupKey: "skill", item: skillInvokeItems[0] },
    { groupKey: "skill", item: skillLifecycleItem },
    { groupKey: "skill", item: nativeMcpSkillItem },
  ]);
  assert.equal(combinedSkillNodes.length, 1, "consecutive skill activity should share one disclosure");
  assert.equal(combinedSkillNodes[0]?.type, "skill");
  assert.equal(combinedSkillNodes[0]?.entries.length, 3);

  // Edit diff: Claude-style old_string/new_string reconstructs into del/add lines.
  const claudeEditItems = buildActivityItems([
    {
      id: "claude-edit-call",
      type: "tool",
      phase: "call",
      toolId: "claude.Edit",
      title: "claude.Edit",
      status: "complete",
      input: { file_path: "/repo/run.py", old_string: "a = 1", new_string: "a = 2" },
      result: { type: "edit", id: "call_RiLEVQ0tVcAA4Mo1QqDGn5NK", filePath: "/repo/run.py" },
    },
  ]);
  const claudeEditItem = claudeEditItems[0];
  const claudeEditDiff = editDiffFromItem(claudeEditItem);
  assert.ok(claudeEditDiff && claudeEditDiff.length, "expected a reconstructed edit diff");
  assert.ok(claudeEditDiff.some((line) => line.kind === "del" && line.text === "a = 1"), "expected a removed line");
  assert.ok(claudeEditDiff.some((line) => line.kind === "add" && line.text === "a = 2"), "expected an added line");
  // The edit row must NOT emit a generic artifact card (e.g. from the tool-call id in the result).
  assert.deepEqual(artifactCardsFromItem(claudeEditItem), [], "edit should not render artifact cards");

  // Edit diff: an explicit unified diff string parses by +/- prefixes.
  const patchEditItems = buildActivityItems([
    {
      id: "patch-edit",
      type: "tool",
      phase: "result",
      toolId: "codex.fileChange",
      title: "codex.fileChange",
      status: "complete",
      result: { type: "fileChange", changes: { "a.ts": { type: "modify", diff: "@@ -1,2 +1,2 @@\\n ctx\\n-old\\n+new" } } },
    },
  ]);
  const patchEditDiff = editDiffFromItem(patchEditItems[0]);
  assert.ok(patchEditDiff && patchEditDiff.some((line) => line.kind === "del" && line.text === "old"), "expected unified diff removed line");
  assert.ok(patchEditDiff.some((line) => line.kind === "add" && line.text === "new"), "expected unified diff added line");
  assert.ok(patchEditDiff.some((line) => line.kind === "context" && line.text === "ctx"), "expected unified diff context line");

  const finalizeMessage = {
    id: "message-finalize-regression",
    role: "assistant",
    text: "",
    context: null,
    pending: true,
    runId: "run-finalize-regression",
    parts: [
      { id: "finalize-draft-1", type: "text", text: "Draft answer" },
      {
        id: "finalize-command",
        type: "tool",
        phase: "call",
        toolId: "codex.commandExecution",
        title: "codex.commandExecution",
        status: "complete",
        input: { command: "/bin/zsh -lc 'ls generated'", cwd: "/tmp" },
      },
      { id: "finalize-draft-2", type: "text", text: " stale tail" },
    ],
  };
  finalizeAssistantMessage(finalizeMessage, {
    events: [{
      type: "assistant.final",
      runId: "run-finalize-regression",
      text: "Final answer with image ![chart](/generated/final-chart.png)",
    }],
  });
  const finalizeTextParts = finalizeMessage.parts.filter((part) => part.type === "text");
  assert.equal(finalizeTextParts.length, 1);
  assert.match(finalizeTextParts[0].text, /\\/generated\\/final-chart\\.png/);
  const finalizedSplitGroups = splitAssistantPartsForSurface(
    normalizeMessagePartsForDisplay(finalizeMessage.parts),
    finalizeMessage.id,
  );
  assert.equal(finalizedSplitGroups.answerGroups.length, 1);
  assert.equal(finalizedSplitGroups.processGroups.filter((group) => group.type === "activity").length, 1);

  const approvalMessage = {
    id: "message-approval",
    role: "assistant",
    text: "",
    context: null,
    pending: true,
    parts: [{
      id: "approval-part",
      type: "tool",
      phase: "approval",
      toolId: "codex.permission",
      title: "Approval",
      status: "pending",
      approvalId: "approval-ok",
      approvalStatus: "pending",
    }],
  };
  assert.equal(applyApprovalResultToMessages([approvalMessage], "approval-ok", {
    approval: { id: "approval-ok", status: "approved" },
  }, "approve"), true);
  assert.doesNotMatch(JSON.stringify(approvalMessage.parts), /动作已确认/);

  const questionMessage = {
    id: "message-question",
    role: "assistant",
    text: "",
    context: null,
    pending: true,
    parts: [{
      id: "question-part",
      type: "tool",
      phase: "question",
      toolId: "codex.question",
      title: "Question",
      status: "pending",
      questionId: "question-ok",
      questionStatus: "pending",
    }],
  };
  assert.equal(applyQuestionResultToMessages([questionMessage], "question-ok", {
    question: {
      id: "question-ok",
      status: "answered",
      response: { answers: { direction: { answers: ["功能开发"] } } },
    },
  }, "answer"), true);
  assert.deepEqual(questionMessage.parts[0].result, {
    answers: { direction: { answers: ["功能开发"] } },
  });
  assert.equal(questionMessage.pending, true, "answering a question must not finish the active agent turn");
  assert.doesNotMatch(JSON.stringify(questionMessage.parts), /已回答/);


  const defaultAppGroup = {
    id: "app-room--story-seed--group--default",
    kind: "group",
    scope: { kind: "app", appId: "story-seed", role: "default" },
    title: "故事种子 群组",
    badge: "故事种子",
    memberIds: ["employee-writer"],
    pinned: false,
    unread: 0,
    updatedAt: createdAt,
    messages: [],
  };
  const customAppGroup = {
    ...defaultAppGroup,
    id: "app-room--story-seed--group--review",
    scope: { kind: "app", appId: "story-seed", role: "group" },
    title: "大纲评审群组",
  };
  assert.equal(
    canArchiveMountedAppGroup(defaultAppGroup, "story-seed"),
    true,
    "the App default group must expose the same dissolve action as every other group",
  );
  assert.equal(
    canArchiveMountedAppGroup(customAppGroup, "story-seed"),
    true,
    "a user-created App group can be archived from the desktop App",
  );
  assert.equal(
    canArchiveMountedAppGroup({ ...customAppGroup, kind: "direct" }, "story-seed"),
    false,
    "direct chats are not deletable through the App group control",
  );
  assert.equal(
    canArchiveMountedAppGroup({ ...customAppGroup, scope: { kind: "app", appId: "other-app", role: "group" } }, "story-seed"),
    false,
    "a mounted App cannot archive another App's group",
  );
  assert.equal(
    shouldEnsureMountedAppDefaultGroup(defaultAppGroup.id, new Set()),
    true,
    "the App may create its default group before the user dissolves it",
  );
  assert.equal(
    shouldEnsureMountedAppDefaultGroup(defaultAppGroup.id, new Set([defaultAppGroup.id])),
    false,
    "a dissolved default group must not be recreated automatically",
  );

  function createOptimisticRoomHarness(initialRoom) {
    let renderedRoom = initialRoom;
    const memberStatuses = [];
    return {
      get room() { return renderedRoom; },
      memberStatuses,
      callbacks: {
        onUpdateMemberStatus: (memberIds, status) => memberStatuses.push({ memberIds, status }),
        onHasOtherRunningMessage: (memberId, excludedMessageIds) => {
          const excluded = new Set(excludedMessageIds);
          return renderedRoom.messages.some((message) => (
            !excluded.has(message.id)
            && message.senderType === "agent"
            && message.senderId === memberId
            && message.status === "running"
          ));
        },
        onUpdateRoom: (_roomId, updater) => { renderedRoom = updater(renderedRoom); },
        onUpdateRoomMessage: (_roomId, messageId, updater) => {
          renderedRoom = {
            ...renderedRoom,
            messages: renderedRoom.messages.map((message) => message.id === messageId ? updater(message) : message),
          };
        },
        onUpsertRoomMessages: (_roomId, messages) => {
          const incomingIds = new Set(messages.map((message) => message.id));
          renderedRoom = {
            ...renderedRoom,
            messages: [...renderedRoom.messages.filter((message) => !incomingIds.has(message.id)), ...messages],
          };
        },
        onServerEventSeq: () => {},
      },
    };
  }

  async function waitForCondition(predicate, message) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(predicate(), message);
  }

  globalThis.__roomReplyApiTestPromise = (async () => {
    {
      const originalFetch = globalThis.fetch;
      let requestedUrl = "";
      let requestedMethod = "";
      globalThis.fetch = async (url, init) => {
        requestedUrl = String(url);
        requestedMethod = String(init?.method ?? "GET");
        return new Response(JSON.stringify({
          ok: true,
          room: { id: "room/read receipt", unread: 0 },
          currentEventSeq: 42,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      try {
        let requestedBody;
        const originalFetchWithBody = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          requestedUrl = String(url);
          requestedMethod = String(init?.method ?? "GET");
          requestedBody = JSON.parse(String(init?.body ?? "{}"));
          return originalFetchWithBody(url, init);
        };
        const result = await markServerRoomRead("room/read receipt", 41);
        assert.equal(result.currentEventSeq, 42);
        assert.match(requestedUrl, /\\/rooms\\/room%2Fread%20receipt\\/read$/);
        assert.equal(requestedMethod, "POST");
        assert.deepEqual(requestedBody, { observedEventSeq: 41 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    {
      let nextTimerId = 0;
      const timers = new Map();
      const sent = [];
      const queue = createRoomReadReceiptQueue({
        delayMs: 5_000,
        send: async (roomId, observedEventSeq) => {
          sent.push({ roomId, observedEventSeq });
        },
        setTimer: (callback) => {
          nextTimerId += 1;
          timers.set(nextTimerId, callback);
          return nextTimerId;
        },
        clearTimer: (timerId) => {
          timers.delete(timerId);
        },
      });
      queue.enqueue({ roomId: "room-busy", observedEventSeq: 10, unread: 1 });
      queue.enqueue({ roomId: "room-busy", observedEventSeq: 12, unread: 3 });
      assert.equal(timers.size, 1, "repeated active-room reads must share one debounce timer");
      const runTimer = [...timers.values()][0];
      timers.clear();
      runTimer();
      await waitForCondition(() => sent.length === 1, "the coalesced read receipt must be sent");
      assert.deepEqual(sent, [{ roomId: "room-busy", observedEventSeq: 12 }]);
    }

    {
      let releaseFirstReceipt;
      const sent = [];
      const timers = [];
      const queue = createRoomReadReceiptQueue({
        delayMs: 5_000,
        send: async (roomId, observedEventSeq) => {
          sent.push({ roomId, observedEventSeq });
          if (sent.length === 1) await new Promise((resolve) => { releaseFirstReceipt = resolve; });
        },
        setTimer: (callback) => {
          timers.push(callback);
          return timers.length;
        },
        clearTimer: () => {},
      });
      queue.enqueue({ roomId: "room-switch", observedEventSeq: 20, unread: 1 });
      timers.shift()();
      await waitForCondition(() => sent.length === 1, "the first receipt must enter flight");
      queue.enqueue({ roomId: "room-switch", observedEventSeq: 21, unread: 1 });
      const flushed = queue.flush("room-switch");
      releaseFirstReceipt();
      await flushed;
      assert.deepEqual(
        sent,
        [
          { roomId: "room-switch", observedEventSeq: 20 },
          { roomId: "room-switch", observedEventSeq: 21 },
        ],
        "leaving a Room must flush the newest cursor queued during an in-flight receipt",
      );
    }

    {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        ok: false,
        error: "room_message_rejected",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      try {
        await assert.rejects(
          postServerRoomMessage({
            roomId: "room-rejected",
            text: "hi",
            targetIds: [],
            attachments: [],
          }),
          { message: "room_message_rejected" },
          "a 200 business failure must expose the Bridge error instead of crashing during response normalization",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    {
      const originalFetch = globalThis.fetch;
      const requestBodies = [];
      const optimisticMembers = [
        {
          ...appPm,
          employeeDefinitionId: "pm",
          kernel: "codex",
        },
        appWorker,
      ];
      const optimisticAppRoom = {
        ...appRoom,
        adminMemberIds: [appPm.id],
        memberIds: optimisticMembers.map((member) => member.id),
        messages: [],
      };
      const harness = createOptimisticRoomHarness(optimisticAppRoom);
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        requestBodies.push(body);
        return new Response(JSON.stringify({
          ok: true,
          room: optimisticAppRoom,
          userMessage: {
            id: body.userMessageId,
            roomId: optimisticAppRoom.id,
            channelSeq: 1,
            senderId: "user",
            senderName: "Me",
            senderType: "user",
            text: "hi",
            targetIds: [appPm.id],
            status: "sent",
            createdAt,
            deliveryKind: "pm_auto_route",
          },
          assistantMessages: [{
            id: body.assistantMessageIds[0],
            roomId: optimisticAppRoom.id,
            channelSeq: 2,
            senderId: appPm.id,
            senderName: appPm.name,
            senderType: "agent",
            text: "",
            targetIds: [],
            status: "running",
            createdAt,
            startedAt: createdAt,
            runId: "room-run-optimistic-pm",
          }],
          currentEventSeq: 2,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      try {
        assert.equal(sendRoomText({
          rawText: "hi",
          activeRoom: optimisticAppRoom,
          roomMembers: optimisticMembers,
          kernelOptions: [{ ...availableCodex, hostTools: true }],
          ...harness.callbacks,
        }), true);
        const optimisticPmMessage = harness.room.messages.find((message) => message.senderId === appPm.id);
        assert.equal(optimisticPmMessage?.status, "running", "an automatic PM route must render its running placeholder synchronously");
        assert.deepEqual(requestBodies[0]?.targetIds, [], "the optimistic PM must not become an explicit server target");
        assert.deepEqual(
          requestBodies[0]?.assistantMessageIds,
          [optimisticPmMessage?.id],
          "the bridge must reuse the optimistic PM placeholder identity",
        );
        assert.deepEqual(harness.memberStatuses[0], { memberIds: [appPm.id], status: "running" });
        await waitForCondition(
          () => harness.room.messages.some((message) => message.runId === "room-run-optimistic-pm"),
          "the authoritative PM response must replace the optimistic record",
        );
        assert.equal(
          harness.room.messages.filter((message) => message.senderId === appPm.id).length,
          1,
          "the authoritative PM response must update rather than duplicate the optimistic placeholder",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    {
      const originalFetch = globalThis.fetch;
      const failureMembers = [{ ...appPm, employeeDefinitionId: "pm", kernel: "codex" }, appWorker];
      const failureRoom = {
        ...appRoom,
        adminMemberIds: [appPm.id],
        memberIds: failureMembers.map((member) => member.id),
        messages: [],
      };
      const harness = createOptimisticRoomHarness(failureRoom);
      globalThis.fetch = async () => {
        throw new Error("network unavailable");
      };
      try {
        assert.equal(sendRoomText({
          rawText: "hi",
          activeRoom: failureRoom,
          roomMembers: failureMembers,
          kernelOptions: [{ ...availableCodex, hostTools: true }],
          ...harness.callbacks,
        }), true);
        const optimisticMessage = harness.room.messages.find((message) => message.senderId === appPm.id);
        assert.equal(optimisticMessage?.status, "running");
        await waitForCondition(
          () => harness.room.messages.some((message) => message.id === optimisticMessage?.id && message.status === "failed"),
          "a failed PM request must settle its optimistic placeholder",
        );
        assert.equal(
          harness.memberStatuses.some(({ memberIds, status }) => status === "idle" && memberIds.includes(appPm.id)),
          true,
          "a failed PM request must return the predicted member to idle",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    {
      const originalFetch = globalThis.fetch;
      const predictedPm = { ...appPm, employeeDefinitionId: "pm", kernel: "codex" };
      const authoritativePm = {
        ...predictedPm,
        id: "member-app-story-seed-pm-authoritative",
        name: "权威故事种子 PM",
      };
      const priorRunningMessage = {
        id: "message-prior-pm-run",
        senderId: predictedPm.id,
        senderName: predictedPm.name,
        senderType: "agent",
        text: "",
        targetIds: [predictedPm.id],
        status: "running",
        createdAt,
      };
      const replacementRoom = {
        ...appRoom,
        adminMemberIds: [predictedPm.id, authoritativePm.id],
        memberIds: [predictedPm.id, authoritativePm.id, appWorker.id],
        messages: [priorRunningMessage],
      };
      const harness = createOptimisticRoomHarness(replacementRoom);
      let optimisticMessageId = "";
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        optimisticMessageId = body.assistantMessageIds[0];
        return new Response(JSON.stringify({
          ok: true,
          room: replacementRoom,
          userMessage: {
            id: body.userMessageId,
            roomId: replacementRoom.id,
            channelSeq: 3,
            senderId: "user",
            senderName: "Me",
            senderType: "user",
            text: "hi",
            targetIds: [authoritativePm.id],
            status: "sent",
            createdAt,
            deliveryKind: "pm_auto_route",
          },
          assistantMessages: [{
            id: optimisticMessageId,
            roomId: replacementRoom.id,
            channelSeq: 4,
            senderId: authoritativePm.id,
            senderName: authoritativePm.name,
            senderType: "agent",
            text: "",
            targetIds: [],
            status: "running",
            createdAt,
            startedAt: createdAt,
            runId: "room-run-authoritative-pm",
          }],
          currentEventSeq: 4,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      try {
        assert.equal(sendRoomText({
          rawText: "hi",
          activeRoom: replacementRoom,
          roomMembers: [predictedPm, authoritativePm, appWorker],
          kernelOptions: [{ ...availableCodex, hostTools: true }],
          ...harness.callbacks,
        }), true);
        await waitForCondition(
          () => harness.room.messages.some((message) => message.id === optimisticMessageId && message.senderId === authoritativePm.id),
          "the authoritative PM must take ownership of the reused optimistic placeholder",
        );
        assert.equal(
          harness.memberStatuses.some(({ memberIds, status }) => status === "idle" && memberIds.includes(predictedPm.id)),
          false,
          "a superseded PM with another running message must not be reset to idle",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    {
      const originalFetch = globalThis.fetch;
      const fallbackMembers = [{ ...appPm, employeeDefinitionId: "pm", kernel: "codex" }, appWorker];
      const fallbackRoom = {
        ...appRoom,
        adminMemberIds: [appPm.id],
        memberIds: fallbackMembers.map((member) => member.id),
        messages: [],
      };
      const harness = createOptimisticRoomHarness(fallbackRoom);
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({
          ok: true,
          room: fallbackRoom,
          userMessage: {
            id: body.userMessageId,
            roomId: fallbackRoom.id,
            channelSeq: 1,
            senderId: "user",
            senderName: "Me",
            senderType: "user",
            text: "hi",
            targetIds: [appPm.id],
            status: "sent",
            createdAt,
            deliveryKind: "pm_auto_route",
          },
          assistantMessages: [{
            id: "message-pm-unavailable",
            roomId: fallbackRoom.id,
            channelSeq: 2,
            senderId: "system",
            senderName: "System",
            senderType: "system",
            text: "PM unavailable",
            targetIds: [],
            status: "done",
            createdAt,
          }],
          currentEventSeq: 2,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      try {
        assert.equal(sendRoomText({
          rawText: "hi",
          activeRoom: fallbackRoom,
          roomMembers: fallbackMembers,
          kernelOptions: [{ ...availableCodex, hostTools: true }],
          ...harness.callbacks,
        }), true);
        assert.equal(
          harness.room.messages.some((message) => message.senderId === appPm.id && message.status === "running"),
          true,
          "the predicted PM placeholder must exist while the bridge response is pending",
        );
        await waitForCondition(
          () => harness.room.messages.some((message) => message.id === "message-pm-unavailable"),
          "the Bridge fallback must replace the optimistic PM placeholder",
        );
        assert.equal(
          harness.room.messages.some((message) => message.senderId === appPm.id),
          false,
          "a bridge fallback must remove the unmatched optimistic PM placeholder",
        );
        assert.equal(
          harness.room.messages.some((message) => message.id === "message-pm-unavailable"),
          true,
          "the bridge fallback must replace the optimistic presentation",
        );
        assert.equal(
          harness.memberStatuses.some(({ memberIds, status }) => status === "idle" && memberIds.includes(appPm.id)),
          true,
          "a replaced optimistic PM must not remain in the running state",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    const originalFetch = globalThis.fetch;
    const requestBodies = [];
    let requestCount = 0;
    globalThis.fetch = async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ ok: false, error: "reply_message_not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        room: {
          id: "room-reply-fallback",
          kind: "group",
          title: "Reply fallback",
          badge: "Local",
          memberIds: [],
          messages: [],
          updatedAt: createdAt,
          unread: 0,
        },
        userMessage: {
          id: "message-reply-fallback",
          roomId: "room-reply-fallback",
          channelSeq: 1,
          senderId: "user",
          senderName: "Me",
          senderType: "user",
          text: "continue",
          targetIds: [],
          status: "sent",
          createdAt,
        },
        assistantMessages: [],
        currentEventSeq: 1,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const result = await postServerRoomMessageWithReplyFallback({
        roomId: "room-reply-fallback",
        text: "continue",
        targetIds: [],
        attachments: [],
        inReplyToMessageId: "message-deleted-parent",
      });
      assert.equal(requestBodies.length, 2);
      assert.equal(requestBodies[0].inReplyToMessageId, "message-deleted-parent");
      assert.equal("inReplyToMessageId" in requestBodies[1], false);
      assert.equal(result.userMessage.inReplyToMessageId, undefined);
      assert.equal(result.userMessage.rootMessageId, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();

  console.log("web-room-state-harness ok");
`,
  "utf8",
);

try {
  const configPath = ts.findConfigFile(join(projectRoot, "web"), ts.sys.fileExists, "tsconfig.json");
  assert.ok(configPath, "web/tsconfig.json should exist");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, join(projectRoot, "web"));
  const contractProgram = ts.createProgram({
    rootNames: [roomMessageContractPath],
    options: {
      ...parsedConfig.options,
      noEmit: true,
      allowImportingTsExtensions: true,
    },
  });
  const contractDiagnostics = ts.getPreEmitDiagnostics(contractProgram);
  assert.equal(
    contractDiagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(contractDiagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => projectRoot,
      getNewLine: () => "\n",
    }),
  );

  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    absWorkingDir: projectRoot,
    nodePaths: [join(projectRoot, "node_modules")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2022",
    jsx: "automatic",
    loader: { ".css": "empty" },
    banner: {
      js: "globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };",
    },
    logLevel: "silent",
  });
  await import(pathToFileURL(bundlePath).href);
  await globalThis.__roomReplyApiTestPromise;
  const roomsApiSource = await readFile(roomsApiImport, "utf8");
  const fetchRoomEventsSource = roomsApiSource.slice(
    roomsApiSource.indexOf("export async function fetchRoomEvents"),
    roomsApiSource.indexOf("export async function postServerRoomMessage"),
  );
  assert.match(fetchRoomEventsSource, /params\.set\("eventVersion", "2"\)/);
  const mountedAppChatPanelSource = await readFile(mountedAppChatPanelSourcePath, "utf8");
  assert.match(
    mountedAppChatPanelSource,
    /resolveRoomSendTargets/,
    "the App Workspace send path must share the strict automatic PM target resolver",
  );
  assert.match(mountedAppChatPanelSource, /import \{ groupEventsByRunId \} from "\.\.\/rooms\/rooms-guide";/);
  assert.match(mountedAppChatPanelSource, /runtimeEvents\?: AgentEventRecord\[\]/);
  assert.doesNotMatch(mountedAppChatPanelSource, /fetchJson<EventsResponse>\("\/events"/);
  assert.match(mountedAppChatPanelSource, /groupEventsByRunId\(runtimeEventsSnapshot, activeRoomRunIds\)/);
  assert.match(mountedAppChatPanelSource, /runtimeEventsByRunId=\{runtimeEventsByRunId\}/);
  assert.doesNotMatch(mountedAppChatPanelSource, /if \(!message\.runId\) return false/);
  assert.doesNotMatch(mountedAppChatPanelSource, /emptyRuntimeEventsByRunId/);
  assert.doesNotMatch(mountedAppChatPanelSource, /outgoingAttachments\.length \? "发送了附件"/);
  assert.match(mountedAppChatPanelSource, /t\("rooms\.sentAttachment"\)/);
  assert.doesNotMatch(mountedAppChatPanelSource, /roomPickerInitiallyOpen/);
  assert.match(
    mountedAppChatPanelSource,
    /sendText\(prompt, \[\], replyingToMessage\)/,
    "mounted App activity submissions must preserve the selected reply target",
  );

  const roomsViewSource = await readFile(roomsViewSourcePath, "utf8");
  assert.match(
    roomsViewSource,
    /sendText\(prompt, \[\], replyingToMessage\)/,
    "Rooms activity submissions must preserve the selected reply target",
  );
  const roomMessageActionsSource = await readFile(roomMessageActionsImport, "utf8");
  assert.match(
    roomMessageActionsSource,
    /postServerRoomMessageWithReplyFallback/,
    "Rooms sends must retry without a stale reply pointer",
  );
  assert.doesNotMatch(roomMessageActionsSource, /outgoingAttachments\.length \? "发送了附件"/);
  assert.match(roomMessageActionsSource, /translate\("rooms\.sentAttachment"\)/);
  assert.match(
    roomMessageActionsSource,
    /kernelOptions: KernelOption\[\];/,
    "Room sends must require the Bridge capability snapshot used for optimistic PM prediction",
  );
  assert.match(
    roomMessageActionsSource,
    /onHasOtherRunningMessage\(memberId: string, excludedMessageIds: string\[\]\): boolean;/,
    "Room sends must require the concurrent-run guard before resetting a member to idle",
  );

  const appMainViewsSource = await readFile(appMainViewsSourcePath, "utf8");
  assert.match(appMainViewsSource, /runtimeEvents\?: AgentEventRecord\[\]/);
  assert.match(appMainViewsSource, /runtimeEvents=\{props\.runtimeEvents\}/);

  const appSource = await readFile(appSourcePath, "utf8");
  assert.ok((appSource.match(/runtimeEvents=\{events\}/g) ?? []).length >= 2);
  assert.ok(true);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
