export interface RoomMutationErrorResponse {
  status: 400 | 409;
  error: string;
}

export function roomMutationErrorResponse(error: unknown): RoomMutationErrorResponse | undefined {
  const code = error instanceof Error ? (error.message.split(":", 1)[0] ?? "") : "";
  if (
    [
      "room_scope_conflict",
      "cross_app_member_forbidden",
      "app_room_pm_scope_mismatch",
      "room_read_cursor_ahead",
    ].includes(code)
  ) {
    return { status: 409, error: code };
  }
  if (["room_member_reference_invalid", "room_administrator_not_member", "room_read_cursor_invalid"].includes(code)) {
    return { status: 400, error: code };
  }
  return undefined;
}
