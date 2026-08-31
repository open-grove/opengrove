import assert from "node:assert/strict";
import { RoomChannelStore, type RoomChannelMember } from "../rooms/channel-store.js";
import {
  reconcileMountedAppGroupRooms,
  shouldDisableStaleMountedAppSeedMember,
  shouldRestoreMountedAppSeedMember,
  syncMountedAppDefaultGroups,
} from "../server/bridge-state.js";
import { defaultAppGroupRoomId } from "../server/app-room-ids.js";

const APP_ID = "demo-notes";
const ROOM_ID = defaultAppGroupRoomId(APP_ID);

assert.notEqual(
  defaultAppGroupRoomId("my.app"),
  defaultAppGroupRoomId("my-app"),
  "valid App ids must never collapse onto the same default Room identity",
);

function seedEmployee(slug: string, overrides: Partial<RoomChannelMember> = {}): RoomChannelMember {
  return {
    id: `member-app-demo-notes-${slug}`,
    employeeDefinitionId: slug === "pm" ? "pm" : undefined,
    name: slug === "pm" ? "示例笔记 PM" : slug,
    kernel: "claude-code",
    model: "default",
    role: `${slug} role`,
    status: "idle",
    color: "#22c55e",
    lastActive: "now",
    appId: APP_ID,
    source: "local",
    sourceLabel: "Demo Notes App",
    ...overrides,
  };
}

function sharedEmployee(overrides: Partial<RoomChannelMember> = {}): RoomChannelMember {
  return {
    id: "employee-shared-reviewer",
    name: "共享评审",
    kernel: "claude-code",
    model: "default",
    role: "shared reviewer",
    status: "idle",
    color: "#0ea5e9",
    lastActive: "now",
    source: "local",
    ...overrides,
  };
}

function member(store: RoomChannelStore, memberId: string): RoomChannelMember {
  const found = store.listMembers().find((candidate) => candidate.id === memberId);
  assert.ok(found, `missing member ${memberId}`);
  return found;
}

function roomMemberIds(store: RoomChannelStore): string[] {
  return store.getRoom(ROOM_ID)?.memberIds ?? [];
}

function upsertAll(store: RoomChannelStore, members: RoomChannelMember[]): void {
  for (const item of members) {
    store.upsertMember(item, { emitEvent: true });
  }
}

function markRoomAppScoped(store: RoomChannelStore, roomId: string, appId: string): void {
  const snapshot = store.snapshot();
  const room = snapshot.rooms.find((candidate) => candidate.id === roomId);
  assert.ok(room, `missing Room ${roomId}`);
  room.scope = { kind: "app", appId };
  store.restore(snapshot);
}

const pm = seedEmployee("pm");
const writer = seedEmployee("writer");
const editor = seedEmployee("editor");
const worldbuilder = seedEmployee("worldbuilder");
const shared = sharedEmployee();

const roomIdCollisionStore = new RoomChannelStore();
upsertAll(roomIdCollisionStore, [pm, writer]);
roomIdCollisionStore.createRoom({
  id: ROOM_ID,
  title: "General Room using an App-looking storage id",
  badge: "General",
  memberIds: [writer.id],
});
assert.throws(
  () =>
    roomIdCollisionStore.ensureGroupRoom({
      id: ROOM_ID,
      scope: { kind: "app", appId: APP_ID, role: "default" },
      title: "Must not claim the general Room",
      badge: "Demo Notes",
      memberIds: [pm.id, writer.id],
    }),
  /room_scope_conflict/,
  "an App scope must not be inferred from or grafted onto an existing Room id",
);
assert.equal(syncMountedAppDefaultGroups(roomIdCollisionStore, [pm, writer]), true);
assert.equal(roomIdCollisionStore.getRoom(ROOM_ID)?.scope, undefined, "the colliding general Room keeps its identity");
const collisionSafeDefault = roomIdCollisionStore
  .listRooms()
  .find((room) => room.scope?.kind === "app" && room.scope.appId === APP_ID && room.scope.role === "default");
assert.ok(collisionSafeDefault, "the App still receives a default Room under a free storage id");
assert.notEqual(
  collisionSafeDefault.id,
  ROOM_ID,
  "business scope, not the preferred Room id, identifies the default Room",
);

const store = new RoomChannelStore();
upsertAll(store, [pm, writer, editor]);

assert.equal(syncMountedAppDefaultGroups(store, [pm, writer, editor]), true, "initial default group should be created");
assert.deepEqual(roomMemberIds(store), [pm.id, writer.id, editor.id], "new default group starts from seed employees");
store.patchRoom(ROOM_ID, {
  title: "My story team",
  badge: "Custom",
  generatedTitle: null,
});
syncMountedAppDefaultGroups(store, [pm, writer, editor]);
assert.equal(store.getRoom(ROOM_ID)?.title, "My story team", "default-group sync preserves a custom title");
assert.equal(store.getRoom(ROOM_ID)?.badge, "Custom", "default-group sync preserves a custom badge");
assert.equal(
  store.getRoom(ROOM_ID)?.generatedTitle,
  undefined,
  "default-group sync does not reclaim a user-owned title",
);

store.upsertMember(shared, { emitEvent: true });
store.addMember(ROOM_ID, shared);
assert.ok(roomMemberIds(store).includes(shared.id), "manual shared member can be added");
syncMountedAppDefaultGroups(store, [pm, writer, editor]);
assert.ok(roomMemberIds(store).includes(shared.id), "merge sync preserves manually added shared member");

store.removeMember(ROOM_ID, writer.id);
assert.equal(
  member(store, writer.id).disabled,
  false,
  "removing from one group must not disable the employee globally",
);
assert.equal(
  store.listDeletedMemberIds().includes(writer.id),
  false,
  "group removal must not enter the global deleted set",
);
assert.deepEqual(
  store.getRoom(ROOM_ID)?.removedMemberIds,
  [writer.id],
  "the room remembers its own explicit exclusion",
);

syncMountedAppDefaultGroups(store, [pm, writer, editor]);
assert.equal(
  roomMemberIds(store).includes(writer.id),
  false,
  "removed seed employee stays out after default-group sync",
);
assert.equal(
  member(store, writer.id).disabled,
  false,
  "default-group sync must not turn a room exclusion into a global disable",
);
assert.ok(
  roomMemberIds(store).includes(shared.id),
  "manual shared member still survives after removing a seed employee",
);

store.upsertMember(worldbuilder, { emitEvent: true });
syncMountedAppDefaultGroups(store, [pm, writer, editor, worldbuilder]);
assert.ok(
  roomMemberIds(store).includes(worldbuilder.id),
  "new manifest seed employee is merged into the default group",
);
assert.equal(
  roomMemberIds(store).includes(writer.id),
  false,
  "new manifest seed does not resurrect removed seed employee",
);

const restored = new RoomChannelStore();
restored.restore(store.snapshot());
assert.equal(
  member(restored, writer.id).disabled,
  false,
  "snapshot/restore keeps a group-removed employee globally active",
);
assert.deepEqual(
  restored.getRoom(ROOM_ID)?.removedMemberIds,
  [writer.id],
  "snapshot/restore preserves room-scoped exclusions",
);
syncMountedAppDefaultGroups(restored, [pm, writer, editor, worldbuilder]);
assert.equal(roomMemberIds(restored).includes(writer.id), false, "restored room exclusion is not erased by seed sync");
assert.ok(roomMemberIds(restored).includes(shared.id), "restored manually added member survives sync");

restored.addMember(ROOM_ID, writer);
assert.deepEqual(restored.getRoom(ROOM_ID)?.removedMemberIds, [], "explicit re-add clears the room exclusion");
syncMountedAppDefaultGroups(restored, [pm, writer, editor, worldbuilder]);
assert.ok(roomMemberIds(restored).includes(writer.id), "re-added seed employee survives later sync");

restored.patchMember(editor.id, { disabled: true, status: "offline", lastActive: "已移除" });
syncMountedAppDefaultGroups(restored, [pm, writer, editor, worldbuilder]);
assert.equal(
  roomMemberIds(restored).includes(editor.id),
  false,
  "the separate global delete operation still removes a disabled employee from groups",
);
assert.ok(restored.listDeletedMemberIds().includes(editor.id), "global deletion still owns deletedMemberIds");

const referencedStore = new RoomChannelStore();
upsertAll(referencedStore, [pm, editor]);
syncMountedAppDefaultGroups(referencedStore, [pm, editor]);
referencedStore.openDirect({ id: `direct-${editor.id}`, memberId: editor.id, title: editor.name });
referencedStore.removeMember(ROOM_ID, editor.id);
assert.equal(
  member(referencedStore, editor.id).disabled,
  false,
  "removing from a group leaves the direct-chat employee active",
);
assert.equal(referencedStore.getRoom(`direct-${editor.id}`)?.memberIds.includes(editor.id), true);
assert.equal(referencedStore.listDeletedMemberIds().includes(editor.id), false);

const dirtyReinstallStore = new RoomChannelStore();
const globalPm = { ...pm, id: "pm", appId: undefined, name: "Global PM" };
upsertAll(dirtyReinstallStore, [globalPm, pm, writer, editor]);
dirtyReinstallStore.createRoom({
  id: "app-room--demo-notes--group--36",
  scope: { kind: "app", appId: APP_ID },
  title: "Demo Notes Group 36",
  generatedTitle: { kind: "app-group", appId: APP_ID, sequence: 36 },
  badge: "Demo Notes",
  memberIds: [pm.id],
});
const dirtySnapshot = dirtyReinstallStore.snapshot();
const dirtyRoom = dirtySnapshot.rooms.find((room) => room.id === "app-room--demo-notes--group--36");
assert.ok(dirtyRoom);
dirtyRoom.memberIds = [pm.id, globalPm.id];
dirtyRoom.adminMemberIds = [globalPm.id];
dirtyReinstallStore.restore(dirtySnapshot);
assert.equal(
  reconcileMountedAppGroupRooms(dirtyReinstallStore, [pm, writer, editor]),
  true,
  "startup consistency repair must detect a dirty App group",
);
assert.deepEqual(
  dirtyReinstallStore.getRoom("app-room--demo-notes--group--36")?.memberIds,
  [pm.id, writer.id, editor.id],
  "generated App groups recover the active App roster and remove global PM",
);
assert.deepEqual(
  dirtyReinstallStore.getRoom("app-room--demo-notes--group--36")?.adminMemberIds,
  [pm.id],
  "the stable App PM projection becomes the App group's administrator",
);
const dirtyRepairEventSeq = dirtyReinstallStore.snapshot().currentEventSeq;
assert.equal(
  reconcileMountedAppGroupRooms(dirtyReinstallStore, [pm, writer, editor]),
  false,
  "startup consistency repair is idempotent",
);
assert.equal(
  dirtyReinstallStore.snapshot().currentEventSeq,
  dirtyRepairEventSeq,
  "an already-converged reconcile must not append another Room event",
);

const removedPmStore = new RoomChannelStore();
upsertAll(removedPmStore, [pm, writer]);
syncMountedAppDefaultGroups(removedPmStore, [pm, writer]);
removedPmStore.removeMember(ROOM_ID, pm.id);
assert.deepEqual(removedPmStore.getRoom(ROOM_ID)?.removedMemberIds, [pm.id]);
assert.equal(syncMountedAppDefaultGroups(removedPmStore, [pm, writer]), false);
assert.equal(reconcileMountedAppGroupRooms(removedPmStore, [pm, writer]), false);
assert.equal(
  removedPmStore.getRoom(ROOM_ID)?.memberIds.includes(pm.id),
  false,
  "a user-removed optional PM must not be resurrected by seed sync or startup reconciliation",
);

const pmOnlyStore = new RoomChannelStore();
upsertAll(pmOnlyStore, [pm]);
syncMountedAppDefaultGroups(pmOnlyStore, [pm]);
pmOnlyStore.removeMember(ROOM_ID, pm.id);
assert.deepEqual(pmOnlyStore.getRoom(ROOM_ID)?.memberIds, [], "the optional PM can be the last member removed");
assert.equal(syncMountedAppDefaultGroups(pmOnlyStore, [pm]), false);
assert.equal(reconcileMountedAppGroupRooms(pmOnlyStore, [pm]), false);
assert.deepEqual(pmOnlyStore.getRoom(ROOM_ID)?.removedMemberIds, [pm.id]);

const missingPmStore = new RoomChannelStore();
upsertAll(missingPmStore, [writer]);
missingPmStore.createRoom({
  id: ROOM_ID,
  title: "Missing PM",
  generatedTitle: { kind: "app-group", appId: APP_ID, sequence: 1 },
  badge: "Demo Notes",
  memberIds: [writer.id],
});
markRoomAppScoped(missingPmStore, ROOM_ID, APP_ID);
assert.equal(
  reconcileMountedAppGroupRooms(missingPmStore, [pm, writer]),
  false,
  "a Room with a usable worker does not require a PM binding to converge",
);
assert.equal(
  missingPmStore.listMembers().some((candidate) => candidate.id === pm.id),
  false,
);
assert.deepEqual(missingPmStore.getRoom(ROOM_ID)?.adminMemberIds, []);
assert.equal(
  syncMountedAppDefaultGroups(missingPmStore, [pm, writer]),
  true,
  "default-group sync may repair presentation while tolerating a missing optional PM",
);
assert.equal(missingPmStore.getRoom(ROOM_ID)?.memberIds.includes(pm.id), false);
assert.equal(syncMountedAppDefaultGroups(missingPmStore, [pm, writer]), false, "the PM-free result converges");

const disabledOptionalPmStore = new RoomChannelStore();
upsertAll(disabledOptionalPmStore, [{ ...pm, disabled: true, status: "offline", lastActive: "已移除" }, writer]);
disabledOptionalPmStore.createRoom({
  id: ROOM_ID,
  title: "Disabled PM",
  generatedTitle: { kind: "app-group", appId: APP_ID, sequence: 1 },
  badge: "Demo Notes",
  memberIds: [writer.id],
});
markRoomAppScoped(disabledOptionalPmStore, ROOM_ID, APP_ID);
assert.equal(reconcileMountedAppGroupRooms(disabledOptionalPmStore, [pm, writer]), false);
assert.equal(member(disabledOptionalPmStore, pm.id).disabled, true, "a deliberately disabled PM stays disabled");
assert.deepEqual(disabledOptionalPmStore.getRoom(ROOM_ID)?.adminMemberIds, []);

const disabledPm = { ...pm, disabled: true, status: "offline" as const, lastActive: "manifest removed" };
assert.equal(
  shouldDisableStaleMountedAppSeedMember(pm, new Set()),
  true,
  "uninstall marks the existing App PM projection offline instead of deleting it",
);
assert.equal(shouldRestoreMountedAppSeedMember(disabledPm, pm), true, "reinstall reactivates the same App PM identity");

console.log("mounted-app-member-management-harness ok");
