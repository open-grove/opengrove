import assert from "node:assert/strict";
import { isRunnableRoomAssistantTarget, RoomChannelStore } from "../rooms/channel-store.js";
import { normalizePersistedAgentState } from "../storage/json-state-store.js";
import {
  migrateLocalStateToUnscoped,
  unscopedMemberId,
  unscopedRoomId,
} from "../server/migrations/local-unscoped-v1.js";
import { migrateRoomAdministratorsV1 } from "../server/migrations/room-administrators-v1.js";
import { migrateKernelNativeResumeV1 } from "../server/migrations/kernel-native-resume-v1.js";
import { migrateAppRoomScopesV1 } from "../server/migrations/app-room-scopes-v1.js";
import { migrateAppMemberIdentitiesV1 } from "../server/migrations/app-member-identities-v1.js";
import { pmAgentMemberId } from "../rooms/room-pm.js";

const hash = "9f86d081884c";
const scopedEmployeeId = `member-user-${hash}-employee`;
const connectorMemberId = `member-cloud-app-${hash}-agent`;
const cloudRunMemberId = `member-cloud-run-${hash}`;
const matrixMemberId = "matrix_member_legacy_remote";
const scopedEmployeeRoomId = `cloud-user:u:direct-${scopedEmployeeId}`;
const scopedConnectorRoomId = `cloud-user:u:app-room--demo--direct--${connectorMemberId}`;

assert.equal(unscopedMemberId(scopedEmployeeId), "employee");
assert.equal(unscopedMemberId(connectorMemberId), connectorMemberId);
assert.equal(unscopedMemberId(cloudRunMemberId), cloudRunMemberId);
assert.equal(unscopedRoomId(scopedEmployeeRoomId), "direct-employee");
assert.equal(unscopedRoomId(scopedConnectorRoomId), `app-room--demo--direct--${connectorMemberId}`);
assert.equal(unscopedMemberId("member-user-ab-cd-member-app-x"), "member-user-ab-cd-member-app-x");

assert.deepEqual(
  migrateKernelNativeResumeV1({
    type: "codex.native",
    runId: "run-old-codex-approval",
  }),
  {
    type: "kernel.native",
    kernelId: "codex",
    runId: "run-old-codex-approval",
    continuation: "same-loop",
  },
);

const migrated = migrateLocalStateToUnscoped(
  normalizePersistedAgentState({
    version: 9,
    savedAt: "2026-06-30T00:00:00.000Z",
    knowledge: [
      {
        id: "knowledge-scoped",
        slug: "knowledge-scoped",
        type: "routine",
        title: "Scoped refs",
        body: [`Room ${scopedEmployeeRoomId}`, `member ${scopedEmployeeId}`, `agent ${connectorMemberId}`].join("\n"),
        format: "markdown",
        tags: [],
        links: [],
        backlinks: [],
        sourceRefs: [],
        scope: "global",
        lifecycle: "active",
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
        metadata: { memberId: scopedEmployeeId },
      },
    ],
    routines: [
      {
        id: "routine-scoped",
        title: "Scoped routine",
        status: "active",
        trigger: "manual",
        capabilityIds: [],
        approvalRules: [],
        steps: [
          {
            id: "step-scoped",
            title: "Scoped step",
            memberId: scopedEmployeeId,
            roomId: scopedEmployeeRoomId,
            input: { targetMemberId: scopedEmployeeId, connectorMemberId },
            prompt: `Ask ${scopedEmployeeId}`,
          },
        ],
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
    ],
    rooms: {
      version: 1,
      currentEventSeq: 1,
      rooms: [
        {
          id: scopedEmployeeRoomId,
          kind: "direct",
          title: "Employee",
          badge: "E",
          memberIds: [scopedEmployeeId],
          directMemberId: scopedEmployeeId,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
        {
          id: scopedConnectorRoomId,
          kind: "direct",
          title: "Connector",
          badge: "A",
          memberIds: [connectorMemberId, cloudRunMemberId],
          directMemberId: connectorMemberId,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
        {
          id: "room-legacy-matrix",
          kind: "group",
          title: "Legacy Matrix",
          badge: "Matrix",
          memberIds: [matrixMemberId],
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
      ],
      members: [
        {
          id: scopedEmployeeId,
          name: "Fallback Employee",
          kernel: "codex",
          model: "gpt-5.5",
          role: "employee fallback",
          status: "idle",
          color: "#2563eb",
          lastActive: "在线",
          source: "local",
        },
        {
          id: connectorMemberId,
          name: "Connector Agent",
          kernel: "codex",
          model: "gpt-5.5",
          role: "connector agent",
          status: "idle",
          color: "#2563eb",
          lastActive: "在线",
          source: "local",
        },
        {
          id: cloudRunMemberId,
          name: "Cloud Run Agent",
          kernel: "codex",
          model: "cloud",
          role: "cloud run fallback",
          status: "idle",
          color: "#2563eb",
          lastActive: "Cloud",
          source: "local",
        },
        {
          id: matrixMemberId,
          name: "Legacy Remote Claude",
          kernel: "claude-code",
          model: "claude-code-default",
          role: "remote collaborator",
          status: "idle",
          color: "#14b8a6",
          lastActive: "now",
          source: "remote",
          sourceLabel: "Matrix",
          remote: {
            provider: "matrix",
            accountId: "default",
            ownerId: "@friend:example.com",
            agentId: "remote-claude",
          },
        },
      ],
      messages: [
        {
          id: "message-scoped",
          roomId: scopedEmployeeRoomId,
          channelSeq: 1,
          senderId: scopedEmployeeId,
          senderName: "Fallback Employee",
          senderType: "agent",
          text: `delegated to ${scopedEmployeeId}`,
          targetIds: [connectorMemberId, cloudRunMemberId],
          status: "done",
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
        },
      ],
      events: [
        {
          eventSeq: 1,
          type: "room.message.created",
          roomId: scopedEmployeeRoomId,
          memberId: scopedEmployeeId,
          createdAt: "2026-06-30T00:00:00.000Z",
          payload: { roomId: scopedEmployeeRoomId, memberId: scopedEmployeeId, text: scopedEmployeeId },
        },
      ],
      deletedMemberIds: [],
    },
  }),
);

assert.equal(migrated.result.changed, true);
assert.deepEqual(
  migrated.state.rooms.members.map((member) => member.id).sort(),
  ["employee", cloudRunMemberId, connectorMemberId, matrixMemberId].sort(),
);
assert.deepEqual(
  migrated.state.rooms.rooms.map((room) => room.id).sort(),
  [`app-room--demo--direct--${connectorMemberId}`, "direct-employee", "room-legacy-matrix"].sort(),
);
assert.equal(migrated.state.rooms.messages[0]?.senderId, "employee");
assert.deepEqual(migrated.state.rooms.messages[0]?.targetIds, [connectorMemberId, cloudRunMemberId]);
assert.equal(migrated.state.rooms.messages[0]?.text, `delegated to ${scopedEmployeeId}`);
for (const memberId of [connectorMemberId, cloudRunMemberId, matrixMemberId]) {
  const removedMember = migrated.state.rooms.members.find((member) => member.id === memberId);
  assert.equal(removedMember?.disabled, true, `${memberId} should not remain active after the frozen stack is removed`);
  assert.equal(removedMember?.status, "offline");
  assert.ok(migrated.state.rooms.deletedMemberIds?.includes(memberId));
}
const restoredRooms = new RoomChannelStore();
restoredRooms.restore(migrated.state.rooms);
for (const memberId of [connectorMemberId, cloudRunMemberId, matrixMemberId]) {
  const removedMember = restoredRooms.listMembers().find((member) => member.id === memberId);
  assert.ok(removedMember);
  assert.equal(isRunnableRoomAssistantTarget(removedMember), false);
  assert.ok(restoredRooms.listDeletedMemberIds().includes(memberId));
}
assert.equal(migrated.state.rooms.events[0]?.roomId, "direct-employee");
assert.equal(migrated.state.rooms.events[0]?.memberId, "employee");
assert.equal((migrated.state.rooms.events[0]?.payload as { text?: string } | undefined)?.text, scopedEmployeeId);
assert.equal(migrated.state.routines[0]?.steps[0]?.memberId, "employee");
assert.equal(migrated.state.routines[0]?.steps[0]?.roomId, "direct-employee");
assert.equal(
  (migrated.state.routines[0]?.steps[0]?.input as { targetMemberId?: string } | undefined)?.targetMemberId,
  "employee",
);
assert.equal(
  (migrated.state.routines[0]?.steps[0]?.input as { connectorMemberId?: string } | undefined)?.connectorMemberId,
  connectorMemberId,
);
assert.equal(migrated.state.routines[0]?.steps[0]?.prompt, `Ask ${scopedEmployeeId}`);
assert.match(migrated.state.knowledge[0]?.body ?? "", new RegExp(escapeRegExp(scopedEmployeeRoomId)));
assert.match(migrated.state.knowledge[0]?.body ?? "", new RegExp(escapeRegExp(scopedEmployeeId)));
assert.equal(migrated.state.knowledge[0]?.metadata.memberId, "employee");
assert.equal(JSON.stringify(migrated.state.rooms.rooms).includes("cloud-user:"), false);

const scopedLegacyPmId = `member-user-${hash}-legacy-pm`;
const legacyWorkerId = "legacy-worker";
const legacyAdminMigration = migrateLocalStateToUnscoped(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 0,
      rooms: [
        {
          id: "legacy-group-with-pm",
          kind: "group",
          title: "Legacy group with PM",
          badge: "L",
          memberIds: [scopedLegacyPmId],
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
        {
          id: "explicit-no-admin-group",
          kind: "group",
          title: "Explicit no-admin group",
          badge: "N",
          memberIds: [scopedLegacyPmId],
          adminMemberIds: [],
          updatedAt: "2026-06-30T00:00:01.000Z",
          unread: 0,
        },
        {
          id: "legacy-group-needs-global-pm",
          kind: "group",
          title: "Legacy group needs global PM",
          badge: "G",
          memberIds: [legacyWorkerId],
          updatedAt: "2026-06-30T00:00:02.000Z",
          unread: 0,
        },
      ],
      members: [
        {
          id: scopedLegacyPmId,
          employeeDefinitionId: "pm",
          name: "Legacy PM",
          kernel: "codex",
          model: "gpt-5.5",
          role: "project manager",
          status: "idle",
          color: "#2563eb",
          lastActive: "在线",
          source: "local",
        },
        {
          id: legacyWorkerId,
          name: "Legacy worker",
          kernel: "codex",
          model: "gpt-5.5",
          role: "worker",
          status: "idle",
          color: "#64748b",
          lastActive: "在线",
          source: "local",
        },
      ],
      messages: [],
      events: [],
      deletedMemberIds: [],
    },
  }),
);
const roomAdministratorMigration = migrateRoomAdministratorsV1(legacyAdminMigration.state);
const migratedLegacyRoom = roomAdministratorMigration.state.rooms.rooms[0];
assert.equal(roomAdministratorMigration.changed, true);
assert.deepEqual(roomAdministratorMigration.migratedRoomIds, ["legacy-group-with-pm", "legacy-group-needs-global-pm"]);
assert.deepEqual(migratedLegacyRoom?.adminMemberIds, ["legacy-pm"]);
assert.deepEqual(
  roomAdministratorMigration.state.rooms.rooms[1]?.adminMemberIds,
  [],
  "migration must preserve an explicit no-administrator choice",
);
const restoredLegacyRooms = new RoomChannelStore();
restoredLegacyRooms.restore(roomAdministratorMigration.state.rooms);
restoredLegacyRooms.ensureOpenGroup([
  ...roomAdministratorMigration.state.rooms.members,
  {
    id: "pm",
    employeeDefinitionId: "pm",
    name: "PM",
    kernel: "codex",
    model: "gpt-5.5",
    role: "project manager",
    status: "idle",
    color: "#7c3aed",
    lastActive: "在线",
    source: "local",
  },
]);
assert.deepEqual(
  restoredLegacyRooms.getRoom("legacy-group-with-pm")?.adminMemberIds,
  ["legacy-pm"],
  "legacy PM administrators must survive the unscoped migration",
);
assert.deepEqual(
  restoredLegacyRooms.getRoom("explicit-no-admin-group")?.adminMemberIds,
  [],
  "an explicit no-administrator choice must survive the unscoped migration",
);
assert.deepEqual(
  restoredLegacyRooms.getRoom("legacy-group-needs-global-pm")?.memberIds,
  [legacyWorkerId],
  "format migration must not make a product decision by injecting global PM",
);
assert.deepEqual(
  restoredLegacyRooms.getRoom("legacy-group-needs-global-pm")?.adminMemberIds,
  [],
  "legacy groups without a known PM remain administrator-free until runtime reconciliation",
);

const legacyPm = legacyAdminMigration.state.rooms.members[0];
assert.ok(legacyPm);
const legacyRoomMergeMigration = migrateLocalStateToUnscoped(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 0,
      rooms: [
        {
          id: "cloud-user:u:legacy-room-merge",
          kind: "group",
          title: "Scoped legacy room",
          badge: "S",
          memberIds: [legacyPm.id],
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
        {
          id: "legacy-room-merge",
          kind: "group",
          title: "Unscoped legacy room",
          badge: "U",
          memberIds: [legacyPm.id],
          updatedAt: "2026-06-30T00:00:01.000Z",
          unread: 0,
        },
      ],
      members: [legacyPm],
      messages: [],
      events: [],
      deletedMemberIds: [],
    },
  }),
);
assert.equal(legacyRoomMergeMigration.state.rooms.rooms.length, 1);
const mergedRoomAdministratorMigration = migrateRoomAdministratorsV1(legacyRoomMergeMigration.state);
assert.deepEqual(
  mergedRoomAdministratorMigration.state.rooms.rooms[0]?.adminMemberIds,
  ["legacy-pm"],
  "merged legacy rooms must be normalized before runtime restore",
);
assert.equal(
  migrateRoomAdministratorsV1(mergedRoomAdministratorMigration.state).changed,
  false,
  "the Room administrator migration must be idempotent",
);

const uninstalledAppId = "removed-story-app";
const uninstalledPmId = `member-app-${uninstalledAppId}-pm`;
const uninstalledWorkerId = `member-app-${uninstalledAppId}-writer`;
const activeAppPmId = "member-app-active-story-app-pm";
const uninstalledGroupRoomId = `app-room--${uninstalledAppId}--group--default`;
const uninstalledDirectRoomId = `app-room--${uninstalledAppId}--direct--${uninstalledPmId}`;
const uninstalledAppState = normalizePersistedAgentState({
  rooms: {
    version: 1,
    currentEventSeq: 3,
    rooms: [
      {
        id: uninstalledGroupRoomId,
        kind: "group",
        title: "Removed Story App",
        badge: "R",
        memberIds: [uninstalledPmId, uninstalledWorkerId],
        adminMemberIds: [uninstalledPmId],
        updatedAt: "2026-06-30T00:00:00.000Z",
        unread: 0,
      },
      {
        id: uninstalledDirectRoomId,
        kind: "direct",
        title: "Removed Story PM",
        badge: "P",
        memberIds: [uninstalledPmId],
        adminMemberIds: [],
        updatedAt: "2026-06-30T00:00:00.000Z",
        unread: 0,
      },
      {
        id: "active-story-group",
        kind: "group",
        title: "Active Story App",
        badge: "A",
        memberIds: [activeAppPmId],
        adminMemberIds: [activeAppPmId],
        updatedAt: "2026-06-30T00:00:00.000Z",
        unread: 0,
      },
    ],
    members: [
      {
        id: uninstalledPmId,
        appId: uninstalledAppId,
        name: "Removed Story PM",
        kernel: "claude-code",
        model: "claude-opus-4-8",
        role: "legacy project manager",
        status: "idle",
        color: "#2563eb",
        lastActive: "在线",
        defaultSkillIds: ["pm-planner"],
        userOverrides: ["kernel", "model"],
        source: "local",
      },
      {
        id: uninstalledWorkerId,
        appId: uninstalledAppId,
        name: "Removed Story Writer",
        kernel: "codex",
        model: "gpt-5.5",
        role: "writer",
        status: "idle",
        color: "#64748b",
        lastActive: "在线",
        defaultSkillIds: ["pm-planner"],
        source: "local",
      },
      {
        id: activeAppPmId,
        employeeDefinitionId: "pm",
        appId: "active-story-app",
        name: "Active Story PM",
        kernel: "claude-code",
        model: "claude-opus-4-8",
        role: "project manager",
        status: "idle",
        color: "#2563eb",
        lastActive: "在线",
        source: "local",
      },
    ],
    messages: [
      {
        id: "removed-pm-group-message",
        roomId: uninstalledGroupRoomId,
        channelSeq: 1,
        senderId: uninstalledPmId,
        senderName: "Removed Story PM",
        senderType: "agent",
        text: "Historical answer",
        targetIds: [uninstalledPmId, uninstalledWorkerId],
        status: "done",
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
      {
        id: "removed-pm-direct-message",
        roomId: uninstalledDirectRoomId,
        channelSeq: 1,
        senderId: uninstalledPmId,
        senderName: "Removed Story PM",
        senderType: "agent",
        text: "Obsolete direct chat",
        targetIds: [],
        status: "done",
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      },
    ],
    events: [
      {
        eventSeq: 1,
        type: "room.member.added",
        roomId: uninstalledGroupRoomId,
        memberId: uninstalledPmId,
        createdAt: "2026-06-30T00:00:00.000Z",
        payload: { member: { id: uninstalledPmId } },
      },
      {
        eventSeq: 2,
        type: "room.message.created",
        roomId: uninstalledGroupRoomId,
        messageId: "removed-pm-group-message",
        createdAt: "2026-06-30T00:00:00.000Z",
        payload: {
          message: {
            id: "removed-pm-group-message",
            roomId: uninstalledGroupRoomId,
            senderId: uninstalledPmId,
            senderName: "Removed Story PM",
            targetIds: [uninstalledPmId, uninstalledWorkerId],
          },
        },
      },
      {
        eventSeq: 3,
        type: "room.created",
        roomId: uninstalledDirectRoomId,
        createdAt: "2026-06-30T00:00:00.000Z",
        payload: { room: { id: uninstalledDirectRoomId, directMemberId: uninstalledPmId } },
      },
    ],
    deletedMemberIds: [uninstalledPmId],
  },
});
const uninstalledAppMigration = migrateLocalStateToUnscoped(uninstalledAppState, {
  uninstalledAppIds: [uninstalledAppId],
});
assert.deepEqual(
  uninstalledAppMigration.result.purgedPmMembers.map((member) => member.id),
  [],
);
assert.equal(uninstalledAppMigration.result.pmPurgeChanged, false);
assert.deepEqual(uninstalledAppMigration.result.removedRoomEventSeqs, []);
assert.equal(
  uninstalledAppMigration.state.rooms.members.some((member) => member.id === uninstalledPmId),
  true,
  "format migration must preserve an uninstalled App's stable scoped PM identity",
);
assert.ok(
  uninstalledAppMigration.state.rooms.members.some((member) => member.id === uninstalledWorkerId),
  "migration must not remove ordinary employees merely because their App was uninstalled",
);
assert.ok(
  uninstalledAppMigration.state.rooms.members.some((member) => member.id === activeAppPmId),
  "migration must preserve scoped PM bindings for Apps that are not marked uninstalled",
);
assert.deepEqual(
  uninstalledAppMigration.state.rooms.rooms.find((room) => room.id === uninstalledGroupRoomId)?.memberIds,
  [uninstalledPmId, uninstalledWorkerId],
);
assert.deepEqual(
  uninstalledAppMigration.state.rooms.rooms.find((room) => room.id === uninstalledGroupRoomId)?.adminMemberIds,
  [uninstalledPmId],
  "format migration preserves the App PM administrator projection",
);
assert.equal(
  uninstalledAppMigration.state.rooms.rooms.some((room) => room.id === uninstalledDirectRoomId),
  true,
  "uninstall preserves App PM direct history for a later reactivation",
);
const retainedHistoricalMessage = uninstalledAppMigration.state.rooms.messages.find(
  (message) => message.id === "removed-pm-group-message",
);
assert.equal(retainedHistoricalMessage?.senderId, uninstalledPmId);
assert.equal(retainedHistoricalMessage?.senderName, "Removed Story PM");
assert.deepEqual(retainedHistoricalMessage?.targetIds, [uninstalledPmId, uninstalledWorkerId]);
assert.equal(
  uninstalledAppMigration.state.rooms.messages.some((message) => message.roomId === uninstalledDirectRoomId),
  true,
);
assert.equal(
  uninstalledAppMigration.state.rooms.events.some(
    (event) => event.memberId === uninstalledPmId || event.roomId === uninstalledDirectRoomId,
  ),
  true,
);
assert.equal(uninstalledAppMigration.state.rooms.deletedMemberIds?.includes(uninstalledPmId), true);
const convergedUninstalledAppMigration = migrateLocalStateToUnscoped(uninstalledAppMigration.state, {
  uninstalledAppIds: [uninstalledAppId],
});
assert.equal(convergedUninstalledAppMigration.result.changed, false);
assert.equal(convergedUninstalledAppMigration.result.pmPurgeChanged, false);

const restoredUninstalledRooms = new RoomChannelStore();
const migratedUninstalledRoomAdministrators = migrateRoomAdministratorsV1(uninstalledAppMigration.state);
restoredUninstalledRooms.restore(migratedUninstalledRoomAdministrators.state.rooms);
restoredUninstalledRooms.ensureOpenGroup([
  {
    id: "pm",
    employeeDefinitionId: "pm",
    name: "PM",
    kernel: "claude-code",
    model: "claude-opus-4-8",
    role: "global project manager",
    status: "idle",
    color: "#2563eb",
    lastActive: "在线",
    defaultSkillIds: ["pm-planner"],
    source: "local",
  },
]);
assert.deepEqual(
  restoredUninstalledRooms.getRoom(uninstalledGroupRoomId)?.adminMemberIds,
  [uninstalledPmId],
  "restoring migrated data must retain the App PM administrator instead of injecting global PM",
);

const remountedAppMigration = migrateLocalStateToUnscoped(uninstalledAppState, {
  uninstalledAppIds: [uninstalledAppId],
  mountedAppIds: [uninstalledAppId],
});
assert.ok(
  remountedAppMigration.state.rooms.members.some((member) => member.id === uninstalledPmId),
  "an App that is mounted again must not be purged because of a stale uninstall marker",
);
assert.ok(
  remountedAppMigration.state.rooms.rooms.some((room) => room.id === uninstalledDirectRoomId),
  "a remounted App's PM direct history must survive stale uninstall metadata",
);

const archivedPmEventMigration = migrateLocalStateToUnscoped(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 1,
      rooms: [],
      members: [],
      messages: [],
      events: [
        {
          eventSeq: 1,
          type: "room.member.updated",
          roomId: "",
          memberId: uninstalledPmId,
          createdAt: "2026-06-30T00:00:00.000Z",
          payload: { member: { id: uninstalledPmId, appId: uninstalledAppId } },
        },
      ],
    },
  }),
  {
    uninstalledAppIds: [uninstalledAppId],
  },
);
assert.deepEqual(
  archivedPmEventMigration.state.rooms.events,
  [
    {
      eventSeq: 1,
      type: "room.member.updated",
      roomId: "",
      memberId: uninstalledPmId,
      createdAt: "2026-06-30T00:00:00.000Z",
      payload: { member: { id: uninstalledPmId, appId: uninstalledAppId } },
    },
  ],
  "format migration must not erase App PM history based on install state",
);

const removedOnlyMemberId = "matrix_member_already_unscoped";
const removedOnlyMigration = migrateLocalStateToUnscoped(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 0,
      rooms: [],
      members: [
        {
          id: removedOnlyMemberId,
          name: "Legacy Remote",
          kernel: "claude-code",
          model: "claude-code-default",
          role: "remote collaborator",
          status: "idle",
          color: "#14b8a6",
          lastActive: "now",
          source: "remote",
        },
      ],
      messages: [],
      events: [],
      // This reproduces an old inconsistent snapshot where the deletion set was
      // already present, so only the member object itself can trigger a save.
      deletedMemberIds: [removedOnlyMemberId],
    },
  }),
);
assert.equal(removedOnlyMigration.result.changed, true);
assert.equal(removedOnlyMigration.result.membersChanged, 1);
assert.equal(removedOnlyMigration.result.roomsChanged, 0);
assert.equal(removedOnlyMigration.state.rooms.members[0]?.disabled, true);
assert.equal(removedOnlyMigration.state.rooms.members[0]?.status, "offline");

const appScopeMigration = migrateAppRoomScopesV1(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 0,
      members: [
        {
          id: "member-app-demo-pm",
          employeeDefinitionId: "pm",
          name: "Demo PM",
          kernel: "claude-code",
          model: "default",
          role: "PM",
          status: "idle",
          color: "#f59e0b",
          lastActive: "now",
          appId: "demo.app",
        },
        {
          id: "member-app-demo-writer",
          name: "Writer",
          kernel: "claude-code",
          model: "default",
          role: "writer",
          status: "idle",
          color: "#2563eb",
          lastActive: "now",
          appId: "demo.app",
        },
        {
          id: "member-app-hyphen-worker",
          name: "Hyphen Worker",
          kernel: "claude-code",
          model: "default",
          role: "worker",
          status: "idle",
          color: "#2563eb",
          lastActive: "now",
          appId: "demo-app",
        },
      ],
      rooms: [
        {
          id: "app-room--demo-app--group--default",
          kind: "group",
          title: "Demo App",
          badge: "Demo",
          memberIds: ["member-app-demo-pm", "member-app-demo-writer"],
          adminMemberIds: ["member-app-demo-pm"],
          removedMemberIds: ["member-app-demo-pm"],
          pinned: false,
          archived: false,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
        {
          id: "app-room--demo-app--group--collision",
          kind: "group",
          title: "Ambiguous",
          badge: "App",
          memberIds: ["member-app-demo-writer", "member-app-hyphen-worker"],
          adminMemberIds: [],
          pinned: false,
          archived: false,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
      ],
      messages: [],
      events: [],
    },
  }),
);
assert.equal(appScopeMigration.changed, true);
assert.deepEqual(appScopeMigration.migratedRoomIds, ["app-room--demo-app--group--default"]);
assert.deepEqual(appScopeMigration.quarantinedRoomIds, ["app-room--demo-app--group--collision"]);
assert.deepEqual(appScopeMigration.state.rooms.rooms[0]?.scope, {
  kind: "app",
  appId: "demo.app",
  role: "default",
});
assert.deepEqual(
  appScopeMigration.state.rooms.rooms[0]?.removedMemberIds,
  ["member-app-demo-pm"],
  "scope migration preserves the user's Room-level removal of an optional PM",
);
assert.equal(
  appScopeMigration.state.rooms.rooms[1]?.scope,
  undefined,
  "ambiguous lossy-id Rooms are never assigned to the wrong App",
);
assert.equal(
  appScopeMigration.state.rooms.rooms[1]?.archived,
  true,
  "ambiguous App Rooms retain history in quarantine",
);
assert.equal(migrateAppRoomScopesV1(appScopeMigration.state).changed, false, "App Room scope migration is idempotent");

const legacyColonPmId = "member-app-a-b-pm";
const encodedColonPmId = pmAgentMemberId("a:b");
const legacyColonPm = {
  id: legacyColonPmId,
  employeeDefinitionId: "pm",
  name: "Colon App PM",
  kernel: "claude-code",
  model: "default",
  role: "PM",
  status: "idle" as const,
  color: "#f59e0b",
  lastActive: "now",
  appId: "a:b",
};
const memberIdentityMigration = migrateAppMemberIdentitiesV1(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 1,
      members: [legacyColonPm],
      rooms: [
        {
          id: "app-room--a%3Ab--group--default",
          kind: "group",
          scope: { kind: "app", appId: "a:b", role: "default" },
          title: "Colon App",
          badge: "Colon",
          memberIds: [legacyColonPmId],
          adminMemberIds: [legacyColonPmId],
          pinned: false,
          archived: false,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
      ],
      messages: [
        {
          id: "message-colon-pm",
          roomId: "app-room--a%3Ab--group--default",
          channelSeq: 1,
          senderId: legacyColonPmId,
          senderName: "Colon App PM",
          senderType: "agent",
          text: "history survives",
          targetIds: [legacyColonPmId],
          status: "done",
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
        },
      ],
      events: [
        {
          eventSeq: 1,
          type: "room.member.added",
          roomId: "app-room--a%3Ab--group--default",
          memberId: legacyColonPmId,
          createdAt: "2026-06-30T00:00:00.000Z",
          payload: { member: legacyColonPm },
        },
      ],
    },
  }),
  [{ ...legacyColonPm, id: encodedColonPmId }],
);
assert.equal(memberIdentityMigration.changed, true);
assert.notEqual(encodedColonPmId, legacyColonPmId);
assert.deepEqual(memberIdentityMigration.migratedMemberIds, [{ from: legacyColonPmId, to: encodedColonPmId }]);
assert.equal(memberIdentityMigration.state.rooms.members[0]?.id, encodedColonPmId);
assert.deepEqual(memberIdentityMigration.state.rooms.rooms[0]?.memberIds, [encodedColonPmId]);
assert.deepEqual(memberIdentityMigration.state.rooms.rooms[0]?.adminMemberIds, [encodedColonPmId]);
assert.equal(memberIdentityMigration.state.rooms.messages[0]?.senderId, encodedColonPmId);
assert.deepEqual(memberIdentityMigration.state.rooms.messages[0]?.targetIds, [encodedColonPmId]);
assert.equal(memberIdentityMigration.state.rooms.events[0]?.memberId, encodedColonPmId);
assert.equal(
  (memberIdentityMigration.state.rooms.events[0]?.payload.member as { id?: string } | undefined)?.id,
  encodedColonPmId,
);
assert.equal(
  migrateAppMemberIdentitiesV1(memberIdentityMigration.state, [{ ...legacyColonPm, id: encodedColonPmId }]).changed,
  false,
  "App Employee identity migration is idempotent",
);

const ambiguousTupleId = "member-app-tuple-a-b-c";
const encodedTupleId = "member-app-tuple-a-b%2Dc";
const ambiguousTupleMember = {
  ...legacyColonPm,
  id: ambiguousTupleId,
  employeeDefinitionId: undefined,
  name: "Tuple Worker",
  appId: "tuple-a",
};
const tupleIdentityMigration = migrateAppMemberIdentitiesV1(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 0,
      members: [ambiguousTupleMember],
      rooms: [
        {
          id: "app-room--tuple-a--group--default",
          kind: "group",
          scope: { kind: "app", appId: "tuple-a", role: "default" },
          title: "Tuple App",
          badge: "Tuple",
          memberIds: [ambiguousTupleId],
          adminMemberIds: [],
          removedMemberIds: [ambiguousTupleId],
          pinned: false,
          archived: false,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
      ],
      messages: [],
      events: [],
      deletedMemberIds: [ambiguousTupleId],
    },
  }),
  [{ ...ambiguousTupleMember, id: encodedTupleId }],
);
assert.equal(tupleIdentityMigration.changed, true);
assert.deepEqual(tupleIdentityMigration.migratedMemberIds, [{ from: ambiguousTupleId, to: encodedTupleId }]);
assert.equal(tupleIdentityMigration.state.rooms.members[0]?.id, encodedTupleId);
assert.deepEqual(tupleIdentityMigration.state.rooms.rooms[0]?.memberIds, [encodedTupleId]);
assert.deepEqual(tupleIdentityMigration.state.rooms.rooms[0]?.removedMemberIds, [encodedTupleId]);
assert.deepEqual(tupleIdentityMigration.state.rooms.deletedMemberIds, [encodedTupleId]);

const scopedTupleCollisionMigration = migrateAppMemberIdentitiesV1(
  normalizePersistedAgentState({
    rooms: {
      version: 1,
      currentEventSeq: 0,
      members: [{ ...ambiguousTupleMember, id: ambiguousTupleId, name: "Tuple B Worker", appId: "tuple-a-b" }],
      rooms: [
        {
          id: "app-room--tuple-a--group--default",
          kind: "group",
          scope: { kind: "app", appId: "tuple-a", role: "default" },
          title: "Tuple A",
          badge: "Tuple",
          memberIds: [ambiguousTupleId],
          adminMemberIds: [],
          pinned: false,
          archived: false,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
        {
          id: "app-room--tuple-a-b--group--default",
          kind: "group",
          scope: { kind: "app", appId: "tuple-a-b", role: "default" },
          title: "Tuple B",
          badge: "Tuple",
          memberIds: [ambiguousTupleId],
          adminMemberIds: [],
          pinned: false,
          archived: false,
          updatedAt: "2026-06-30T00:00:00.000Z",
          unread: 0,
        },
      ],
      messages: [
        {
          id: "message-tuple-a",
          roomId: "app-room--tuple-a--group--default",
          channelSeq: 1,
          senderId: ambiguousTupleId,
          senderName: "Tuple A Worker",
          senderType: "agent",
          text: "A history",
          targetIds: [],
          status: "done",
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
        },
        {
          id: "message-tuple-b",
          roomId: "app-room--tuple-a-b--group--default",
          channelSeq: 1,
          senderId: ambiguousTupleId,
          senderName: "Tuple B Worker",
          senderType: "agent",
          text: "B history",
          targetIds: [],
          status: "done",
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
        },
      ],
      events: [],
      deletedMemberIds: [ambiguousTupleId],
    },
  }),
  [
    { ...ambiguousTupleMember, id: encodedTupleId, appId: "tuple-a" },
    { ...ambiguousTupleMember, id: ambiguousTupleId, appId: "tuple-a-b" },
  ],
);
assert.equal(scopedTupleCollisionMigration.changed, true);
assert.deepEqual(scopedTupleCollisionMigration.migratedMemberIds, []);
assert.equal(scopedTupleCollisionMigration.state.rooms.members[0]?.id, ambiguousTupleId);
assert.deepEqual(scopedTupleCollisionMigration.state.rooms.rooms[0]?.memberIds, [encodedTupleId]);
assert.deepEqual(scopedTupleCollisionMigration.state.rooms.rooms[1]?.memberIds, [ambiguousTupleId]);
assert.equal(scopedTupleCollisionMigration.state.rooms.messages[0]?.senderId, encodedTupleId);
assert.equal(scopedTupleCollisionMigration.state.rooms.messages[1]?.senderId, ambiguousTupleId);
assert.deepEqual(scopedTupleCollisionMigration.state.rooms.deletedMemberIds, [ambiguousTupleId]);
assert.equal(
  migrateAppMemberIdentitiesV1(scopedTupleCollisionMigration.state, [
    { ...ambiguousTupleMember, id: encodedTupleId, appId: "tuple-a" },
    { ...ambiguousTupleMember, id: ambiguousTupleId, appId: "tuple-a-b" },
  ]).changed,
  false,
  "App-scoped tuple collision migration is idempotent",
);

console.log("local-unscoped-migration-harness passed");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
