export const ROOM_MEMBER_AVATAR_MAX_BYTES = 1_500_000;
export const ROOM_MEMBER_AVATAR_DATA_URL_MAX_LENGTH = Math.ceil(ROOM_MEMBER_AVATAR_MAX_BYTES / 3) * 4 + 64;
export const ROOM_MEMBER_AVATAR_DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i;

export function normalizedRoomMemberAvatarDataUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const dataUrl = value.trim();
  if (
    !dataUrl ||
    dataUrl.length > ROOM_MEMBER_AVATAR_DATA_URL_MAX_LENGTH ||
    !ROOM_MEMBER_AVATAR_DATA_URL_PATTERN.test(dataUrl) ||
    roomMemberAvatarDataUrlByteLength(dataUrl) > ROOM_MEMBER_AVATAR_MAX_BYTES
  ) {
    return undefined;
  }
  return dataUrl;
}

export function isSupportedRoomMemberAvatarDataUrl(value: unknown): value is string {
  return normalizedRoomMemberAvatarDataUrl(value) !== undefined;
}

function roomMemberAvatarDataUrlByteLength(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1).replace(/\s/g, "");
  if (!payload || payload.length % 4 !== 0) return Number.POSITIVE_INFINITY;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}
