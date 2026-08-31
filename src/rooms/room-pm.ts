import type { RoomMessageDeliveryKind, RoomMessageSenderType } from "./channel-types.js";

export const PM_AGENT_SKILL_NAME = "pm-planner";
export const OPENGROVE_PM_MEMBER_ID = "pm";

type RoomPmIdentity = {
  employeeDefinitionId?: string;
};

type RoomPmCompatibilityIdentity = RoomPmIdentity & {
  id: string;
  appId?: string;
  defaultSkillIds?: string[];
};

export function pmAgentMemberId(appId: string): string {
  return mountedAppMemberId(appId, OPENGROVE_PM_MEMBER_ID);
}

export function isRoomPmMember(member: RoomPmIdentity): boolean {
  return member.employeeDefinitionId === OPENGROVE_PM_MEMBER_ID;
}

export function isPmAutoRouteTurn(
  member: RoomPmIdentity,
  message: { senderType: RoomMessageSenderType; deliveryKind?: RoomMessageDeliveryKind },
): boolean {
  return isRoomPmMember(member) && message.senderType === "user" && message.deliveryKind === "pm_auto_route";
}

export function canRoomPmAutoRoute(
  member: RoomPmIdentity,
  input: { isRoomAdministrator: boolean; hostTools: boolean },
): boolean {
  return isRoomPmMember(member) && input.isRoomAdministrator && input.hostTools;
}

// Compatibility-only recognition for legacy persisted App PM bindings that
// predate employeeDefinitionId. Never use this heuristic for authorization.
export function isLegacyRoomPmMember(member: RoomPmCompatibilityIdentity): boolean {
  if (isRoomPmMember(member)) return true;
  if (member.defaultSkillIds?.includes(PM_AGENT_SKILL_NAME)) return true;
  const appId = member.appId?.trim();
  if (!appId) return false;
  const pmId = pmAgentMemberId(appId);
  return member.id === pmId || member.id.endsWith(`-${pmId}`);
}

export function mountedAppMemberSlug(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase()).replace(
    /[!'()*~]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Employee components additionally escape the `-` separator. The App component
 * may keep readable hyphens because the final raw hyphen now unambiguously marks
 * the start of an Employee component.
 */
export function mountedAppEmployeeSlug(value: string): string {
  return mountedAppMemberSlug(value).replace(/-/g, "%2D");
}

export function mountedAppMemberId(appId: string, employeeId: string): string {
  const appComponent = mountedAppMemberSlug(appId) || "app";
  const employeeComponent = mountedAppEmployeeSlug(employeeId) || "employee";
  return `member-app-${appComponent}-${employeeComponent}`;
}

/** Pre-v1 compatibility codec. It is intentionally lossy and must not create new identities. */
export function legacyMountedAppMemberSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
