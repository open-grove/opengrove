export type RoomMessageSenderType = "user" | "agent" | "system";

export type RoomMessageDeliveryKind =
  | "user_direct"
  | "user_broadcast"
  | "pm_auto_route"
  | "agent_delegation"
  | "system_routine";

export type RoomMemberSource = "local" | "human";
