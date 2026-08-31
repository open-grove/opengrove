import assert from "node:assert/strict";
import type { ApprovalResume } from "../core.js";
import { RoomChannelStore, type RoomChannelMember, type RoomChannelSnapshot } from "../rooms/channel-store.js";
import { ROOM_MEMBER_AVATAR_MAX_BYTES, normalizedRoomMemberAvatarDataUrl } from "../rooms/avatar-data-url.js";
import { isRunnableRoomAssistantTarget } from "../server/room-runs.js";
import { migrateRoomAdministratorsV1 } from "../server/migrations/room-administrators-v1.js";
import { normalizePersistedAgentState } from "../storage/json-state-store.js";

const codex: RoomChannelMember = {
  id: "employee-codex",
  name: "Codex",
  kernel: "codex",
  model: "gpt-5.5",
  role: "agent",
  status: "idle",
  color: "#2563eb",
  lastActive: "now",
  source: "local",
};

const claude: RoomChannelMember = {
  id: "employee-claude",
  name: "Claude Code",
  kernel: "claude-code",
  model: "default",
  role: "agent",
  status: "idle",
  color: "#f59e0b",
  lastActive: "now",
  source: "local",
};

const store = new RoomChannelStore();

const maximumAvatarDataUrl = `data:image/png;base64,${Buffer.alloc(ROOM_MEMBER_AVATAR_MAX_BYTES).toString("base64")}`;
assert.equal(
  normalizedRoomMemberAvatarDataUrl(maximumAvatarDataUrl),
  maximumAvatarDataUrl,
  "the persisted avatar validator accepts the full advertised 1.5 MB raw payload",
);
assert.equal(
  normalizedRoomMemberAvatarDataUrl(
    `data:image/png;base64,${Buffer.alloc(ROOM_MEMBER_AVATAR_MAX_BYTES + 1).toString("base64")}`,
  ),
  undefined,
  "the persisted avatar validator rejects raw payloads above 1.5 MB",
);

store.ensureOpenGroup([codex, claude]);

const openGroup = store.getRoom("room-open-group");
assert.equal(openGroup, undefined, "local rooms should not seed the Grove direct room");
assert.equal(
  store.listMembers().some((member) => member.id === "grove-guide" || member.id === "app-creator"),
  false,
);
assert.deepEqual(
  store
    .listMembers()
    .map((member) => member.id)
    .sort(),
  [claude.id, codex.id].sort(),
);
assert.deepEqual(store.listDeletedMemberIds(), []);

const accessModeStore = new RoomChannelStore();
accessModeStore.upsertMember({ ...codex, id: "employee-access-mode", accessMode: "full-access" });
assert.equal(accessModeStore.listMembers()[0]?.accessMode, "full-access");
accessModeStore.patchMember("employee-access-mode", { accessMode: "auto-review" });
assert.equal(accessModeStore.listMembers()[0]?.accessMode, "auto-review");
const restoredAccessModeStore = new RoomChannelStore();
restoredAccessModeStore.restore(accessModeStore.snapshot());
assert.equal(restoredAccessModeStore.listMembers()[0]?.accessMode, "auto-review");

const reasoningEffortStore = new RoomChannelStore();
reasoningEffortStore.upsertMember({ ...codex, id: "employee-reasoning-effort", reasoningEffort: "high" });
assert.equal(reasoningEffortStore.listMembers()[0]?.reasoningEffort, "high");
reasoningEffortStore.patchMember("employee-reasoning-effort", { reasoningEffort: "xhigh" });
assert.equal(reasoningEffortStore.listMembers()[0]?.reasoningEffort, "xhigh");
const restoredReasoningEffortStore = new RoomChannelStore();
restoredReasoningEffortStore.restore(reasoningEffortStore.snapshot());
assert.equal(restoredReasoningEffortStore.listMembers()[0]?.reasoningEffort, "xhigh");

const avatarModeStore = new RoomChannelStore();
avatarModeStore.upsertMember({
  ...codex,
  id: "employee-avatar-mode",
  avatarMode: "generated",
  avatarSeed: "notionists-choice-3",
});
avatarModeStore.patchMember("employee-avatar-mode", {
  avatarMode: "initials",
  avatarSeed: undefined,
  avatarDataUrl: undefined,
});
const restoredAvatarModeStore = new RoomChannelStore();
restoredAvatarModeStore.restore(avatarModeStore.snapshot());
assert.equal(restoredAvatarModeStore.listMembers()[0]?.avatarMode, "initials");
assert.equal(restoredAvatarModeStore.listMembers()[0]?.avatarSeed, undefined);
assert.equal(restoredAvatarModeStore.listMembers()[0]?.avatarDataUrl, undefined);

const contextBudgetStore = new RoomChannelStore();
contextBudgetStore.upsertMember({ ...codex, id: "employee-context-budget", contextTokenBudget: 150_000 });
contextBudgetStore.patchMember("employee-context-budget", { contextTokenBudget: 120_000 });
const restoredContextBudgetStore = new RoomChannelStore();
restoredContextBudgetStore.restore(contextBudgetStore.snapshot());
assert.equal(restoredContextBudgetStore.listMembers()[0]?.contextTokenBudget, 120_000);

const unreadStore = new RoomChannelStore();
unreadStore.upsertMember(codex);
const unreadRoom = unreadStore.createRoom({ id: "room-unread", title: "Unread", memberIds: [codex.id] });
const unreadPending = unreadStore.postUserMessage({
  roomId: unreadRoom.id,
  text: "@Codex report back",
  targetIds: [codex.id],
  assistantTargets: [codex],
});
assert.equal(
  unreadStore.getRoom(unreadRoom.id)?.unread,
  0,
  "the user's own message and an empty running assistant placeholder must not become unread",
);
const firstUnreadMessage = unreadStore.updateMessage(unreadRoom.id, unreadPending.assistantMessages[0]!.id, {
  text: "The report is ready.",
  status: "done",
});
assert.equal(unreadStore.getRoom(unreadRoom.id)?.unread, 1, "the first visible agent reply must become unread");
unreadStore.updateMessage(unreadRoom.id, unreadPending.assistantMessages[0]!.id, {
  duration: "2s",
});
assert.equal(unreadStore.getRoom(unreadRoom.id)?.unread, 1, "later updates to one reply must not count it twice");
const restoredUnreadStore = new RoomChannelStore();
restoredUnreadStore.restore(unreadStore.snapshot());
assert.equal(restoredUnreadStore.getRoom(unreadRoom.id)?.unread, 1, "unread state must survive snapshot restore");
restoredUnreadStore.postAgentMessage({
  roomId: unreadRoom.id,
  senderId: codex.id,
  senderName: codex.name,
  text: "One more update.",
});
assert.equal(restoredUnreadStore.getRoom(unreadRoom.id)?.unread, 2);
restoredUnreadStore.markRoomRead(unreadRoom.id, firstUnreadMessage.notificationEventSeq!);
assert.equal(
  restoredUnreadStore.getRoom(unreadRoom.id)?.unread,
  1,
  "a read receipt must preserve messages newer than the client's observed cursor",
);
const fullyObservedEventSeq = restoredUnreadStore.snapshot().currentEventSeq;
restoredUnreadStore.markRoomRead(unreadRoom.id, fullyObservedEventSeq);
assert.equal(
  restoredUnreadStore.getRoom(unreadRoom.id)?.unread,
  0,
  "the latest observed cursor must clear visible unread replies",
);
restoredUnreadStore.markRoomRead(unreadRoom.id, firstUnreadMessage.notificationEventSeq!);
assert.equal(
  restoredUnreadStore.getRoom(unreadRoom.id)?.lastReadEventSeq,
  fullyObservedEventSeq,
  "a stale receipt must never move the read cursor backwards",
);
assert.throws(
  () => restoredUnreadStore.markRoomRead(unreadRoom.id, restoredUnreadStore.snapshot().currentEventSeq + 1),
  /room_read_cursor_ahead/,
  "a client cursor beyond the Host ledger must be rejected",
);
const finalUnreadMessage = restoredUnreadStore.postAgentMessage({
  roomId: unreadRoom.id,
  senderId: codex.id,
  senderName: codex.name,
  text: "Final update.",
});
assert.equal(restoredUnreadStore.getRoom(unreadRoom.id)?.unread, 1, "a reply after the read cursor must become unread");
restoredUnreadStore.deleteMessage(unreadRoom.id, finalUnreadMessage.id);
assert.equal(
  restoredUnreadStore.getRoom(unreadRoom.id)?.unread,
  0,
  "deleting an unread reply must recalculate the count",
);

const appGroupStore = new RoomChannelStore();
appGroupStore.upsertMember({ ...codex, id: "member-app-demo-old", name: "Old App Employee", appId: "demo-app" });
appGroupStore.createRoom({
  id: "app-room--demo-app--group--default",
  title: "Demo App 群组",
  badge: "Demo App",
  memberIds: ["member-app-demo-old"],
});
appGroupStore.upsertMember({ ...codex, id: "member-app-demo-analyst", name: "分析师", appId: "demo-app" });
appGroupStore.upsertMember({ ...claude, id: "member-app-demo-clipper", name: "自动剪辑师", appId: "demo-app" });
assert.equal(
  appGroupStore.ensureGroupRoom({
    id: "app-room--demo-app--group--default",
    title: "Demo App 群组",
    badge: "Demo App",
    memberIds: ["member-app-demo-analyst", "member-app-demo-clipper"],
  }),
  true,
);
assert.deepEqual(appGroupStore.getRoom("app-room--demo-app--group--default")?.memberIds, [
  "member-app-demo-analyst",
  "member-app-demo-clipper",
]);

const roomAdminPm = {
  ...claude,
  id: "member-app-admin-demo-pm",
  name: "Admin Demo PM",
  employeeDefinitionId: "pm",
  appId: "admin-demo",
  defaultSkillIds: ["pm-planner"],
};
const roomAdminWorker = {
  ...codex,
  id: "member-app-admin-demo-worker",
  name: "Admin Demo Worker",
  appId: "admin-demo",
};
const globalRoomAdminPm = {
  ...roomAdminPm,
  id: "pm",
  name: "PM",
  appId: undefined,
};
const roomAdminStore = new RoomChannelStore();
roomAdminStore.ensureOpenGroup([roomAdminWorker, roomAdminPm, globalRoomAdminPm]);
const defaultAdminRoom = roomAdminStore.createRoom({
  id: "room-default-pm-admin",
  title: "Default PM admin",
  memberIds: [roomAdminWorker.id, roomAdminPm.id],
});
assert.deepEqual(
  defaultAdminRoom.adminMemberIds,
  [roomAdminPm.id],
  "new groups default to the PM even when it is not the first member",
);
assert.deepEqual(
  defaultAdminRoom.memberIds,
  [roomAdminWorker.id, roomAdminPm.id],
  "an App group that already has its scoped PM must not also receive the global PM",
);
const insertedPmRoom = roomAdminStore.createRoom({
  id: "room-insert-global-pm",
  title: "Insert global PM",
  memberIds: [roomAdminWorker.id],
});
assert.deepEqual(
  insertedPmRoom.memberIds,
  [roomAdminWorker.id, globalRoomAdminPm.id],
  "a new group without a PM receives the global PM",
);
assert.deepEqual(
  insertedPmRoom.adminMemberIds,
  [globalRoomAdminPm.id],
  "the automatically inserted PM is the new group's administrator",
);
const appRoomAwaitingScopedPm = roomAdminStore.createRoom({
  id: "app-room--admin-demo--group--awaiting-scoped-pm",
  scope: { kind: "app", appId: "admin-demo", role: "group" },
  title: "App Room awaiting scoped PM",
  memberIds: [roomAdminWorker.id],
});
assert.deepEqual(
  appRoomAwaitingScopedPm.memberIds,
  [roomAdminWorker.id],
  "an App-scoped group may omit its optional PM and never falls back to the global PM",
);
assert.deepEqual(appRoomAwaitingScopedPm.adminMemberIds, []);
const duplicateScopedPm = {
  ...roomAdminPm,
  id: "member-app-admin-demo-backup-pm",
  name: "Backup PM",
};
assert.throws(
  () => roomAdminStore.addMember(appRoomAwaitingScopedPm.id, duplicateScopedPm),
  /app_room_pm_scope_mismatch/,
  "an App group cannot gain a second PM projection",
);
assert.equal(
  roomAdminStore.listMembers().some((member) => member.id === duplicateScopedPm.id),
  false,
  "a rejected PM mutation must not partially upsert the extra identity",
);
const forgedPm = {
  ...roomAdminWorker,
  id: "member-app-admin-demo-forged-pm",
  defaultSkillIds: ["pm-planner"],
};
roomAdminStore.upsertMember(forgedPm);
const forgedPmRoom = roomAdminStore.createRoom({
  id: "room-forged-pm",
  title: "Forged PM",
  memberIds: [forgedPm.id],
});
assert.deepEqual(
  forgedPmRoom.memberIds,
  [forgedPm.id, globalRoomAdminPm.id],
  "a manifest-controlled Skill or member id cannot impersonate the trusted PM definition",
);
assert.deepEqual(forgedPmRoom.adminMemberIds, [globalRoomAdminPm.id]);
const explicitAdminRoom = roomAdminStore.createRoom({
  id: "room-explicit-worker-admin",
  title: "Explicit worker admin",
  memberIds: [roomAdminPm.id, roomAdminWorker.id],
  adminMemberIds: [roomAdminWorker.id],
});
assert.deepEqual(
  explicitAdminRoom.adminMemberIds,
  [roomAdminWorker.id],
  "an explicit user-selected administrator must be preserved",
);
const explicitNoAdminRoom = roomAdminStore.createRoom({
  id: "room-explicit-no-admin",
  title: "Explicit no admin",
  memberIds: [roomAdminPm.id, roomAdminWorker.id],
  adminMemberIds: [],
});
assert.deepEqual(
  explicitNoAdminRoom.adminMemberIds,
  [],
  "an explicit empty administrator choice must not be replaced by the PM default",
);

const restoredRoomAdminStore = new RoomChannelStore();
restoredRoomAdminStore.restore(
  migrateRoomAdministratorsV1(
    normalizePersistedAgentState({
      rooms: {
        version: 1,
        currentEventSeq: 0,
        members: [roomAdminWorker, roomAdminPm],
        rooms: [
          {
            id: "room-legacy-without-admins",
            kind: "group",
            title: "Legacy group",
            badge: "Legacy",
            memberIds: [roomAdminWorker.id, roomAdminPm.id],
            updatedAt: "2026-07-01T00:00:00.000Z",
            unread: 0,
          },
          {
            id: "room-saved-manual-admin",
            kind: "group",
            title: "Saved manual admin",
            badge: "Saved",
            memberIds: [roomAdminWorker.id, roomAdminPm.id],
            adminMemberIds: [roomAdminWorker.id],
            updatedAt: "2026-07-01T00:00:01.000Z",
            unread: 0,
          },
        ],
        messages: [],
        events: [],
      } as unknown as RoomChannelSnapshot,
    }),
  ).state.rooms,
);
assert.deepEqual(
  restoredRoomAdminStore.getRoom("room-legacy-without-admins")?.adminMemberIds,
  [roomAdminPm.id],
  "legacy groups without an administrator field migrate to their PM",
);
assert.deepEqual(
  restoredRoomAdminStore.getRoom("room-saved-manual-admin")?.adminMemberIds,
  [roomAdminWorker.id],
  "saved manual administrator choices survive restart and migration",
);

const restoredNoPmAdminStore = new RoomChannelStore();
restoredNoPmAdminStore.restore(
  migrateRoomAdministratorsV1(
    normalizePersistedAgentState({
      rooms: {
        version: 1,
        currentEventSeq: 0,
        members: [roomAdminWorker],
        rooms: [
          {
            id: "room-legacy-without-pm-or-admins",
            kind: "group",
            title: "Legacy group without PM",
            badge: "Legacy",
            memberIds: [roomAdminWorker.id],
            updatedAt: "2026-07-01T00:00:00.000Z",
            unread: 0,
          },
          {
            id: "room-legacy-with-explicit-pm-removal",
            kind: "group",
            title: "Legacy group with explicit PM removal",
            badge: "Legacy",
            memberIds: [roomAdminWorker.id],
            removedMemberIds: [globalRoomAdminPm.id],
            updatedAt: "2026-07-01T00:00:01.000Z",
            unread: 0,
          },
        ],
        messages: [],
        events: [],
      } as unknown as RoomChannelSnapshot,
    }),
  ).state.rooms,
);
restoredNoPmAdminStore.ensureOpenGroup([globalRoomAdminPm]);
assert.deepEqual(
  restoredNoPmAdminStore.getRoom("room-legacy-without-pm-or-admins")?.memberIds,
  [roomAdminWorker.id],
  "administrator format migration must not inject the global PM",
);
assert.deepEqual(restoredNoPmAdminStore.getRoom("room-legacy-without-pm-or-admins")?.adminMemberIds, []);
assert.deepEqual(
  restoredNoPmAdminStore.getRoom("room-legacy-with-explicit-pm-removal")?.memberIds,
  [roomAdminWorker.id],
  "administrator migration must not re-add a PM explicitly removed from this Room",
);
assert.deepEqual(
  restoredNoPmAdminStore.getRoom("room-legacy-with-explicit-pm-removal")?.adminMemberIds,
  [],
  "an explicit Room-level PM exclusion migrates to no administrator",
);

const restoredExplicitNoPmAdminStore = new RoomChannelStore();
restoredExplicitNoPmAdminStore.restore({
  version: 1,
  currentEventSeq: 0,
  members: [roomAdminWorker],
  rooms: [
    {
      id: "room-explicitly-without-pm-or-admins",
      kind: "group",
      title: "Explicitly no PM",
      badge: "Saved",
      memberIds: [roomAdminWorker.id],
      adminMemberIds: [],
      updatedAt: "2026-07-01T00:00:00.000Z",
      unread: 0,
    },
  ],
  messages: [],
  events: [],
});
restoredExplicitNoPmAdminStore.ensureOpenGroup([globalRoomAdminPm]);
assert.deepEqual(
  restoredExplicitNoPmAdminStore.getRoom("room-explicitly-without-pm-or-admins")?.memberIds,
  [roomAdminWorker.id],
  "an explicit saved membership choice is not overwritten during seed sync",
);
assert.deepEqual(restoredExplicitNoPmAdminStore.getRoom("room-explicitly-without-pm-or-admins")?.adminMemberIds, []);

const messageDeleteStore = new RoomChannelStore();
messageDeleteStore.upsertMember(codex);
const messageDeleteRoom = messageDeleteStore.createRoom({ title: "Delete smoke", memberIds: [codex.id] });
const messageDeletePost = messageDeleteStore.postUserMessage({
  roomId: messageDeleteRoom.id,
  text: "@Codex removable",
  targetIds: [codex.id],
  assistantTargets: [codex],
});
const messageDeleteEventSeq = messageDeleteStore.snapshot().currentEventSeq;
const deletedMessage = messageDeleteStore.deleteMessage(messageDeleteRoom.id, messageDeletePost.userMessage.id);
assert.equal(deletedMessage.id, messageDeletePost.userMessage.id);
assert.equal(messageDeleteStore.getMessage(messageDeleteRoom.id, messageDeletePost.userMessage.id), undefined);
assert.ok(
  messageDeleteStore
    .eventsAfter(messageDeleteEventSeq)
    .events.some(
      (event) => event.type === "room.message.deleted" && event.messageId === messageDeletePost.userMessage.id,
    ),
  "deleting a message should emit room.message.deleted",
);
const restoredMessageDeleteStore = new RoomChannelStore();
restoredMessageDeleteStore.restore(messageDeleteStore.snapshot());
assert.equal(restoredMessageDeleteStore.getMessage(messageDeleteRoom.id, messageDeletePost.userMessage.id), undefined);

const provenanceStore = new RoomChannelStore();
provenanceStore.restore({
  version: 1,
  currentEventSeq: 0,
  rooms: [
    {
      id: "room-provenance",
      kind: "group",
      title: "Provenance",
      badge: "Test",
      memberIds: [codex.id, claude.id],
      unread: 0,
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
  ],
  members: [codex, claude],
  messages: [
    {
      id: "message-agent-delegation",
      roomId: "room-provenance",
      channelSeq: 2,
      senderId: codex.id,
      senderName: codex.name,
      senderType: "agent",
      text: "@Claude Code 请接手",
      targetIds: [claude.id],
      status: "done",
      createdAt: "2026-07-11T00:00:01.000Z",
      updatedAt: "2026-07-11T00:00:01.000Z",
      deliveryKind: "agent_delegation",
      inReplyToMessageId: "message-user-root",
      rootMessageId: "message-user-root",
    },
  ],
  events: [],
} as unknown as RoomChannelSnapshot);
const restoredProvenance = provenanceStore.getMessage("room-provenance", "message-agent-delegation");
const restoredProvenanceRecord = restoredProvenance as unknown as Record<string, unknown>;
assert.equal(restoredProvenanceRecord.deliveryKind, "agent_delegation");
assert.equal(restoredProvenanceRecord.inReplyToMessageId, "message-user-root");
assert.equal(restoredProvenanceRecord.rootMessageId, "message-user-root");

const builtinsCleanup = new RoomChannelStore();
builtinsCleanup.restore({
  version: 1,
  currentEventSeq: 5,
  rooms: [
    {
      id: "room-open-group",
      kind: "direct",
      title: "Grove",
      badge: "私聊",
      memberIds: ["grove-guide"],
      adminMemberIds: [],
      directMemberId: "grove-guide",
      unread: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "direct-app-creator",
      kind: "direct",
      title: "App Creator",
      badge: "DM",
      memberIds: ["app-creator"],
      adminMemberIds: [],
      directMemberId: "app-creator",
      unread: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "room-user",
      kind: "group",
      title: "User room",
      badge: "Group",
      memberIds: [codex.id, "grove-guide", "app-creator"],
      adminMemberIds: [codex.id],
      unread: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  members: [
    codex,
    {
      id: "grove-guide",
      name: "Grove",
      kernel: "codex",
      model: "gpt-5.5",
      role: "guide",
      status: "idle",
      color: "#168A53",
      lastActive: "在线",
      defaultSkillIds: ["grove-guide"],
    },
    {
      id: "app-creator",
      name: "App Creator",
      kernel: "codex",
      model: "gpt-5.5",
      role: "import",
      status: "idle",
      color: "#7c3aed",
      lastActive: "在线",
      defaultSkillIds: ["app-creator"],
    },
  ],
  messages: [
    {
      id: "seed-open-system",
      roomId: "room-open-group",
      channelSeq: 1,
      senderId: "grove-guide",
      senderName: "Grove",
      senderType: "agent",
      text: "legacy seed",
      targetIds: [],
      status: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "message-user-targets-builtins",
      roomId: "room-user",
      channelSeq: 1,
      senderId: "user",
      senderName: "You",
      senderType: "user",
      text: "legacy",
      targetIds: [codex.id, "grove-guide", "app-creator"],
      status: "sent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "message-app-creator",
      roomId: "room-user",
      channelSeq: 2,
      senderId: "app-creator",
      senderName: "App Creator",
      senderType: "agent",
      text: "legacy agent",
      targetIds: [],
      status: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  events: [
    {
      eventSeq: 1,
      type: "room.message.created",
      roomId: "room-user",
      messageId: "message-app-creator",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { message: { id: "message-app-creator", senderId: "app-creator", roomId: "room-user" } },
    },
  ],
});
assert.equal(builtinsCleanup.getRoom("room-open-group"), undefined);
assert.equal(builtinsCleanup.getRoom("direct-app-creator"), undefined);
assert.equal(
  builtinsCleanup.listMembers().some((member) => member.id === "grove-guide"),
  true,
);
assert.equal(
  builtinsCleanup.listMembers().some((member) => member.id === "app-creator"),
  false,
);
assert.deepEqual(builtinsCleanup.getRoom("room-user")?.memberIds, [codex.id, "grove-guide"]);
assert.deepEqual(
  builtinsCleanup.listMessages("room-user").map((message) => message.id),
  ["message-user-targets-builtins"],
);
assert.deepEqual(builtinsCleanup.listMessages("room-user")[0]?.targetIds, [codex.id, "grove-guide"]);
assert.equal(builtinsCleanup.eventsAfter(0).events.length, 0);
assert.equal(builtinsCleanup.listDeletedMemberIds().includes("grove-guide"), false);
assert.ok(builtinsCleanup.listDeletedMemberIds().includes("app-creator"));

const room = store.createRoom({ title: "Slock parity", memberIds: [codex.id] });
store.addMember(room.id, claude);

const first = store.postUserMessage({
  roomId: room.id,
  text: "@Codex give the codeword",
  targetIds: [codex.id],
  assistantTargets: [codex],
  deliveryKind: "user_direct",
  selectedFile: { path: "项目/长安客/章节大纲.md" },
});
assert.equal(first.userMessage.channelSeq, 1);
assert.equal(first.assistantMessages[0]?.channelSeq, 2);
assert.equal(first.userMessage.deliveryKind, "user_direct");
assert.deepEqual(first.userMessage.selectedFile, { path: "项目/长安客/章节大纲.md" });
assert.equal(first.userMessage.rootMessageId, undefined, "a root message must not point to itself");
assert.equal(first.assistantMessages[0]?.inReplyToMessageId, first.userMessage.id);
assert.equal(first.assistantMessages[0]?.rootMessageId, first.userMessage.id);
const firstCreatedEvent = store.snapshot().events.find((event) => event.messageId === first.userMessage.id);
assert.equal(
  (firstCreatedEvent?.payload.message as { deliveryKind?: string } | undefined)?.deliveryKind,
  "user_direct",
  "message provenance must survive the created event payload",
);
store.updateMessage(room.id, first.userMessage.id, {
  selectedFile: { path: "项目/长安客/修订版.md" },
});
const firstUpdatedEvent = store
  .snapshot()
  .events.filter((event) => event.messageId === first.userMessage.id && event.type === "room.message.updated")
  .at(-1);
assert.deepEqual(
  (firstUpdatedEvent?.payload.messagePatch as { set?: { selectedFile?: { path: string } } } | undefined)?.set
    ?.selectedFile,
  { path: "项目/长安客/修订版.md" },
  "selectedFile must survive compact message.updated patches",
);
assert.equal(firstUpdatedEvent?.schemaVersion, 2);
assert.equal(firstUpdatedEvent?.payload.message, undefined, "message updates must not duplicate the full message");
const selectedFileRestoreStore = new RoomChannelStore();
selectedFileRestoreStore.restore(store.snapshot());
assert.deepEqual(
  selectedFileRestoreStore.getMessage(room.id, first.userMessage.id)?.selectedFile,
  { path: "项目/长安客/修订版.md" },
  "selectedFile must survive snapshot and restore",
);
const idempotentRoom = store.createRoom({ id: room.id, title: "Should not replace", memberIds: [claude.id] });
assert.equal(idempotentRoom.title, "Slock parity");
assert.deepEqual(idempotentRoom.memberIds.sort(), [claude.id, codex.id].sort());
assert.equal(store.listMessages(room.id).length, 2, "creating an existing room id should preserve message history");

const second = store.postUserMessage({
  roomId: room.id,
  text: "@Claude Code repeat the codeword",
  targetIds: [claude.id],
  assistantTargets: [claude],
});
assert.equal(second.userMessage.channelSeq, 3);
assert.equal(second.assistantMessages[0]?.channelSeq, 4);
assert.ok(second.currentEventSeq > first.currentEventSeq, "eventSeq should be global and increasing");

const afterFirst = store.eventsAfter(first.currentEventSeq);
assert.ok(
  afterFirst.events.some((event) => event.type === "room.message.created" && event.messageId === second.userMessage.id),
);
const existingMemberEventSeq = store.snapshot().currentEventSeq;
store.upsertMember({ ...codex, lastActive: "later" }, { emitEvent: true });
assert.ok(
  store
    .eventsAfter(existingMemberEventSeq)
    .events.some((event) => event.type === "room.member.updated" && event.memberId === codex.id),
  "upserting an existing member should emit member.updated",
);

const platformPost = store.postSystemTargetedMessage({
  roomId: room.id,
  senderName: "平台",
  text: "平台触发员工接手任务",
  targetIds: [codex.id],
  assistantTargets: [codex],
});
assert.equal(platformPost.userMessage.senderType, "system");
assert.equal(platformPost.userMessage.senderId, "system");
assert.equal(platformPost.userMessage.senderName, "平台");
assert.deepEqual(platformPost.userMessage.targetIds, [codex.id]);
assert.equal(platformPost.assistantMessages.length, 1);
assert.equal(platformPost.assistantMessages[0]?.senderId, codex.id);
assert.equal(platformPost.assistantMessages[0]?.status, "running");

store.upsertMember(
  {
    ...codex,
    visibility: "public",
    publicDescription: "Public A2A profile",
    publicSkills: ["review", "summarize"],
    inputSpec: "Plain text request",
    outputSpec: "Concise Markdown answer",
  },
  { emitEvent: true },
);

const activityMessage = store.updateMessage(room.id, second.assistantMessages[0]!.id, {
  text: "done",
  status: "done",
  parts: [
    {
      id: "part-tool-import",
      type: "tool",
      phase: "result",
      toolId: "opengrove.app.import",
      title: "opengrove.app.import",
      status: "complete",
      error: "",
      approvalId: "",
      approvalStatus: "",
      approvalReason: "",
    },
  ],
});

const restored = new RoomChannelStore();
restored.restore(store.snapshot());
const restoredContractMember = restored.listMembers().find((member) => member.id === codex.id);
assert.equal(restoredContractMember?.visibility, "public");
assert.equal(restoredContractMember?.publicDescription, "Public A2A profile");
assert.deepEqual(restoredContractMember?.publicSkills, ["review", "summarize"]);
assert.equal(restoredContractMember?.inputSpec, "Plain text request");
assert.equal(restoredContractMember?.outputSpec, "Concise Markdown answer");
assert.equal(restored.listMessages(room.id).length, 6);
assert.equal(restored.eventsAfter(0).currentEventSeq, store.snapshot().currentEventSeq);
assert.ok(
  restored
    .eventsAfter(existingMemberEventSeq)
    .events.some((event) => event.type === "room.member.updated" && event.memberId === codex.id),
  "global member update events should survive snapshot restore",
);
const restoredActivityMessage = restored.listMessages(room.id).find((message) => message.id === activityMessage.id);
assert.equal(restoredActivityMessage?.parts?.[0]?.toolId, "opengrove.app.import");
assert.equal(restoredActivityMessage?.parts?.[0]?.status, "complete");

const paged = restored.listMessages(room.id, { beforeSeq: 4, limit: 2 });
assert.deepEqual(
  paged.map((message) => message.channelSeq),
  [2, 3],
);

const firstEventPage = restored.eventsAfter(0, 1);
assert.equal(firstEventPage.events.length, 1);
assert.equal(firstEventPage.hasMore, true);
const secondEventPage = restored.eventsAfter(firstEventPage.events[0]!.eventSeq, 1);
assert.equal(secondEventPage.events.length, 1);
assert.ok(secondEventPage.events[0]!.eventSeq > firstEventPage.events[0]!.eventSeq);

const gapStore = new RoomChannelStore();
gapStore.upsertMember(codex);
const gapRoom = gapStore.createRoom({ title: "Gap detection", memberIds: [codex.id] });
const disconnectedAt = gapStore.snapshot().currentEventSeq;
for (let index = 0; index < 5_001; index += 1) {
  gapStore.patchRoom(gapRoom.id, { title: `Gap detection ${index}` });
}
const expiredCursor = gapStore.eventsAfter(disconnectedAt);
assert.equal(expiredCursor.resetRequired, true, "an expired cursor must request a full Rooms rehydrate");
assert.equal(expiredCursor.events.length, 0);
assert.ok(expiredCursor.oldestAvailableEventSeq > disconnectedAt + 1);

assert.equal(isRunnableRoomAssistantTarget(codex), true);
assert.equal(isRunnableRoomAssistantTarget({ ...codex, source: "human", kernel: "user" }), false);
assert.equal(isRunnableRoomAssistantTarget({ ...codex, disabled: true }), false);
assert.equal(isRunnableRoomAssistantTarget({ ...codex, kernel: "browser" }), false);

const restoredStaleRuntime = normalizePersistedAgentState({
  rooms: {
    version: 1,
    currentEventSeq: 0,
    rooms: [
      {
        id: "room-stale-runtime",
        kind: "group",
        title: "Stale runtime",
        badge: "群聊",
        memberIds: [codex.id],
        unread: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    members: [{ ...codex, status: "running", lastActive: "运行中" }],
    messages: [
      {
        id: "message-stale-runtime",
        roomId: "room-stale-runtime",
        channelSeq: 1,
        senderId: codex.id,
        senderName: codex.name,
        senderType: "agent",
        text: "",
        targetIds: [],
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        runId: "room_run_stale_runtime",
        parts: [
          {
            id: "part-stale-tool",
            type: "tool",
            status: "running",
            toolId: "opengrove.app.import",
          },
          {
            id: "part-stale-question",
            type: "tool",
            phase: "question",
            status: "requires-action",
            questionId: "question-stale-runtime",
            questionStatus: "pending",
          },
        ],
      },
    ],
    events: [],
  },
});
const staleRuntimeMember = restoredStaleRuntime.rooms.members.find((member) => member.id === codex.id);
assert.equal(staleRuntimeMember?.status, "idle");
assert.equal(staleRuntimeMember?.lastActive, "待命");
const staleRuntimeMessage = restoredStaleRuntime.rooms.messages.find(
  (message) => message.id === "message-stale-runtime",
);
assert.equal(staleRuntimeMessage?.status, "interrupted");
assert.match(staleRuntimeMessage?.text ?? "", /运行已中断/);
assert.equal(staleRuntimeMessage?.parts?.[0]?.status, "failed");
assert.equal(staleRuntimeMessage?.parts?.[1]?.status, "canceled");
assert.equal(staleRuntimeMessage?.parts?.[1]?.questionStatus, "declined");

const restoredLiveRuntime = normalizePersistedAgentState(
  {
    rooms: {
      version: 1,
      currentEventSeq: 0,
      rooms: [],
      members: [{ ...codex, status: "running", lastActive: "运行中" }],
      messages: [
        {
          id: "message-live-runtime",
          roomId: "room-live-runtime",
          channelSeq: 1,
          senderId: codex.id,
          senderName: codex.name,
          senderType: "agent",
          text: "",
          targetIds: [],
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          runId: "room_run_live_runtime",
          parts: [
            {
              id: "part-live-tool",
              type: "tool",
              status: "running",
              toolId: "opengrove.app.import",
            },
          ],
        },
      ],
      events: [],
    },
  },
  {
    activeRunIds: new Set(["room_run_live_runtime"]),
    activeRoomRunIds: new Set(["room_run_live_runtime"]),
  },
);
assert.equal(restoredLiveRuntime.rooms.members[0]?.status, "running");
assert.equal(restoredLiveRuntime.rooms.messages[0]?.status, "running");
assert.equal(restoredLiveRuntime.rooms.messages[0]?.parts?.[0]?.status, "running");

const restoredLivePendingState = normalizePersistedAgentState(
  {
    workingState: {
      pendingApprovalIds: ["approval-live-runtime", "approval-orphaned-runtime"],
      pendingQuestionIds: ["question-live-runtime"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    approvals: [
      {
        id: "approval-live-runtime",
        kind: "tool",
        title: "Live approval",
        reason: "The Room Run is still waiting",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        resume: { type: "codex.native", runId: "room_run_live_runtime" } as unknown as ApprovalResume,
      },
      {
        id: "approval-orphaned-runtime",
        kind: "tool",
        title: "Orphaned approval",
        reason: "No live Room Run owns this request",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        resume: { type: "codex.native", runId: "room_run_orphaned_runtime" } as unknown as ApprovalResume,
      },
    ],
    questions: [
      {
        id: "question-live-runtime",
        title: "Live question",
        prompt: "The Room Run is still waiting",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        resume: { type: "claude.native", runId: "room_run_live_runtime" } as unknown as ApprovalResume,
      },
    ],
  },
  {
    activeRunIds: new Set(["room_run_live_runtime"]),
    activeRoomRunIds: new Set(["room_run_live_runtime"]),
  },
);
assert.deepEqual(restoredLivePendingState.workingState.pendingApprovalIds, ["approval-live-runtime"]);
assert.deepEqual(restoredLivePendingState.workingState.pendingQuestionIds, ["question-live-runtime"]);
assert.equal(restoredLivePendingState.approvals[0]?.status, "pending");
assert.equal(restoredLivePendingState.approvals[1]?.status, "rejected");
assert.equal(restoredLivePendingState.questions[0]?.status, "pending");
assert.equal(restoredLivePendingState.workingState.updatedAt, "2026-01-01T00:00:00.000Z");

const restoredRoutinePendingState = normalizePersistedAgentState(
  {
    approvals: [
      {
        id: "approval-routine-resumable",
        kind: "routine_step",
        title: "Routine approval",
        reason: "Resume from persisted step data",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        resume: {
          type: "routine.step",
          routineId: "routine-resumable",
          stepId: "approval-step",
          runId: "routine_run_resumable",
        },
      },
    ],
  },
  { preserveResumablePendingRequests: true },
);
assert.equal(restoredRoutinePendingState.approvals[0]?.status, "pending");

const restoredEnglishInterruption = normalizePersistedAgentState(
  {
    rooms: {
      version: 1,
      currentEventSeq: 0,
      rooms: [],
      members: [{ ...codex, status: "waiting", lastActive: "Waiting" }],
      messages: [
        {
          id: "message-english-interruption",
          roomId: "room-english-interruption",
          channelSeq: 1,
          senderId: codex.id,
          senderName: codex.name,
          senderType: "agent",
          text: "",
          targetIds: [],
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          runId: "room_run_english_interruption",
        },
      ],
      events: [],
    },
  },
  { language: "en" },
);
assert.equal(restoredEnglishInterruption.rooms.members[0]?.lastActive, "Idle");
assert.match(restoredEnglishInterruption.rooms.messages[0]?.text ?? "", /local service restarted/i);

const restoredHistoricalLastActive = normalizePersistedAgentState(
  {
    rooms: {
      version: 1,
      currentEventSeq: 0,
      rooms: [],
      members: [{ ...codex, status: "waiting", lastActive: "3 minutes ago" }],
      messages: [],
      events: [],
    },
  },
  { language: "en" },
);
assert.equal(restoredHistoricalLastActive.rooms.members[0]?.status, "idle");
assert.equal(restoredHistoricalLastActive.rooms.members[0]?.lastActive, "3 minutes ago");

const restoredStaleQuestionState = normalizePersistedAgentState({
  workingState: {
    pendingApprovalIds: ["approval-stale-runtime"],
    pendingQuestionIds: ["question-stale-runtime"],
  },
  approvals: [
    {
      id: "approval-stale-runtime",
      kind: "tool",
      title: "Stale approval",
      reason: "Needs a live waiter",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  questions: [
    {
      id: "question-stale-runtime",
      title: "Stale question",
      prompt: "Needs a live waiter",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
});
assert.deepEqual(restoredStaleQuestionState.workingState.pendingApprovalIds, []);
assert.deepEqual(restoredStaleQuestionState.workingState.pendingQuestionIds, []);
assert.equal(restoredStaleQuestionState.approvals[0]?.status, "rejected");
assert.equal(restoredStaleQuestionState.questions[0]?.status, "declined");

console.log(
  JSON.stringify(
    {
      ok: true,
      roomId: room.id,
      messages: restored.listMessages(room.id).length,
      currentEventSeq: restored.snapshot().currentEventSeq,
    },
    null,
    2,
  ),
);
