import { appScopedRoomComponent } from "../../app-room-ids.js";

export function createRoomId(): string {
  return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function appScopedDirectRoomId(appId: string | undefined, memberId: string): string {
  return `app-room--${appScopedRoomComponent(appId)}--direct--${appScopedRoomComponent(memberId)}`;
}
