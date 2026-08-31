import type { JsonObject } from "../../core.js";
import type { RoomChannelMember } from "../../rooms/channel-store.js";
import { legacyMountedAppMemberSlug, mountedAppMemberSlug } from "../../rooms/room-pm.js";
import type { PersistedAgentState } from "../../storage/json-state-store.js";

/**
 * Older mounted-App Employee ids could collide because their component codec
 * left `-` separators ambiguous. This migration uses the App scope stored on
 * members, Rooms, messages, and events to recover the intended identity.
 * Supports: OpenGrove <=0.6.3 lossy ids and PR #721 pre-release builds whose
 * component codec left Employee `-` separators ambiguous.
 * Remove when: the standalone legacy importer owns <=0.6.3 upgrades and no
 * supported PR #721 pre-release build can upgrade in place.
 */

const MEMBER_REFERENCE_KEYS = new Set([
  "memberId",
  "senderId",
  "directMemberId",
  "targetMemberId",
  "localMemberId",
  "requestedMemberId",
]);
const MEMBER_REFERENCE_ARRAY_KEYS = new Set([
  "memberIds",
  "adminMemberIds",
  "removedMemberIds",
  "targetIds",
  "deletedMemberIds",
]);

type AppScopedReplacements = ReadonlyMap<string, ReadonlyMap<string, string>>;

type MemberReferenceRewriteContext = {
  roomAppIds: ReadonlyMap<string, string>;
  persistedMemberAppIds: ReadonlyMap<string, string>;
};

/**
 * Rewrites previous mounted-App Employee ids using the exact App scope carried
 * by members, Rooms, messages, and events. The scope is what lets one collided
 * storage key split into different current ids without a global guess.
 */
export function migrateAppMemberIdentitiesV1(
  input: PersistedAgentState,
  seedMembers: RoomChannelMember[],
): {
  state: PersistedAgentState;
  changed: boolean;
  migratedMemberIds: Array<{ from: string; to: string }>;
} {
  const candidatesByPreviousId = new Map<string, Map<string, Set<string>>>();
  for (const seed of seedMembers) {
    const appId = seed.appId?.trim();
    if (!appId) continue;
    for (const previousId of previousSeedMemberIds(seed)) {
      const candidatesByAppId = candidatesByPreviousId.get(previousId) ?? new Map<string, Set<string>>();
      const candidates = candidatesByAppId.get(appId) ?? new Set<string>();
      candidates.add(seed.id);
      candidatesByAppId.set(appId, candidates);
      candidatesByPreviousId.set(previousId, candidatesByAppId);
    }
  }

  const replacements = new Map<string, Map<string, string>>();
  for (const [previousId, candidatesByAppId] of candidatesByPreviousId) {
    const resolvedByAppId = new Map<string, string>();
    for (const [appId, candidates] of candidatesByAppId) {
      if (candidates.size === 1) resolvedByAppId.set(appId, [...candidates][0]!);
    }
    if (resolvedByAppId.size) replacements.set(previousId, resolvedByAppId);
  }
  if (!replacements.size) return { state: input, changed: false, migratedMemberIds: [] };

  const context: MemberReferenceRewriteContext = {
    roomAppIds: new Map(
      input.rooms.rooms.flatMap((room) => (room.scope?.kind === "app" ? [[room.id, room.scope.appId] as const] : [])),
    ),
    persistedMemberAppIds: new Map(
      input.rooms.members.flatMap((member) => (member.appId ? [[member.id, member.appId] as const] : [])),
    ),
  };
  const rewritten = rewriteMemberReferences(input, replacements, context) as PersistedAgentState;
  const membersById = new Map<string, RoomChannelMember>();
  for (const member of rewritten.rooms.members) {
    const existing = membersById.get(member.id);
    if (!existing || (existing.disabled && !member.disabled)) membersById.set(member.id, member);
  }
  rewritten.rooms = {
    ...rewritten.rooms,
    members: [...membersById.values()],
  };
  const changed = JSON.stringify(rewritten) !== JSON.stringify(input);
  if (!changed) return { state: input, changed: false, migratedMemberIds: [] };
  const migratedMemberIds = input.rooms.members.flatMap((member) => {
    const to = replacementMemberId(member.id, member.appId, replacements, context);
    return to === member.id ? [] : [{ from: member.id, to }];
  });
  return {
    state: rewritten,
    changed,
    migratedMemberIds,
  };
}

function previousSeedMemberIds(seed: RoomChannelMember): string[] {
  const appId = seed.appId?.trim();
  if (!appId) return [];
  const currentPrefix = `member-app-${mountedAppMemberSlug(appId) || "app"}-`;
  if (!seed.id.startsWith(currentPrefix)) return [];
  const encodedEmployeeComponent = seed.id.slice(currentPrefix.length);
  let employeeComponent: string;
  try {
    employeeComponent = decodeURIComponent(encodedEmployeeComponent);
  } catch {
    return [];
  }
  const intermediateEmployeeComponent = mountedAppMemberSlug(employeeComponent);
  const legacyAppComponent = legacyMountedAppMemberSlug(appId) || "app";
  const legacyEmployeeComponent = legacyMountedAppMemberSlug(employeeComponent);
  return [
    ...new Set(
      [
        intermediateEmployeeComponent ? `${currentPrefix}${intermediateEmployeeComponent}` : "",
        legacyEmployeeComponent ? `member-app-${legacyAppComponent}-${legacyEmployeeComponent}` : "",
      ].filter(Boolean),
    ),
  ];
}

function rewriteMemberReferences(
  value: unknown,
  replacements: AppScopedReplacements,
  context: MemberReferenceRewriteContext,
  parentKey = "",
  inheritedAppId?: string,
): unknown {
  if (Array.isArray(value)) {
    const rewritten = value.map((item) =>
      MEMBER_REFERENCE_ARRAY_KEYS.has(parentKey) && typeof item === "string"
        ? replacementMemberId(item, inheritedAppId, replacements, context)
        : rewriteMemberReferences(item, replacements, context, "", inheritedAppId),
    );
    return MEMBER_REFERENCE_ARRAY_KEYS.has(parentKey) ? [...new Set(rewritten)] : rewritten;
  }
  if (!value || typeof value !== "object") return value;
  const source = value as JsonObject;
  const appId = memberReferenceAppId(source, context.roomAppIds, inheritedAppId);
  const output: JsonObject = {};
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === "string" && MEMBER_REFERENCE_KEYS.has(key)) {
      output[key] = replacementMemberId(raw, appId, replacements, context);
      continue;
    }
    if (key === "id" && typeof raw === "string" && typeof source.appId === "string") {
      output[key] = replacementMemberId(raw, appId, replacements, context);
      continue;
    }
    output[key] = rewriteMemberReferences(raw, replacements, context, key, appId) as JsonObject[keyof JsonObject];
  }
  return output;
}

function memberReferenceAppId(
  source: JsonObject,
  roomAppIds: ReadonlyMap<string, string>,
  inheritedAppId?: string,
): string | undefined {
  if (typeof source.appId === "string" && source.appId.trim()) return source.appId.trim();
  const scope = source.scope;
  if (
    scope &&
    typeof scope === "object" &&
    !Array.isArray(scope) &&
    scope.kind === "app" &&
    typeof scope.appId === "string" &&
    scope.appId.trim()
  ) {
    return scope.appId.trim();
  }
  if (typeof source.roomId === "string") return roomAppIds.get(source.roomId) ?? inheritedAppId;
  return inheritedAppId;
}

function replacementMemberId(
  memberId: string,
  appId: string | undefined,
  replacements: AppScopedReplacements,
  context: MemberReferenceRewriteContext,
): string {
  const replacementsByAppId = replacements.get(memberId);
  if (!replacementsByAppId) return memberId;
  if (appId) return replacementsByAppId.get(appId) ?? memberId;
  const persistedAppId = context.persistedMemberAppIds.get(memberId);
  if (persistedAppId) return replacementsByAppId.get(persistedAppId) ?? memberId;
  const targets = new Set(replacementsByAppId.values());
  return targets.size === 1 ? [...targets][0]! : memberId;
}
