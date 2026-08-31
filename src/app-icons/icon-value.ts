import { APP_CUSTOM_ICON_DATA_URL_MAX_LENGTH, APP_CUSTOM_ICON_MAX_BYTES, isAppSystemIconToken } from "./catalog.js";

export { APP_CUSTOM_ICON_DATA_URL_MAX_LENGTH, APP_CUSTOM_ICON_MAX_BYTES };
export const APP_CUSTOM_ICON_DATA_URL_PATTERN = /^data:image\/(?:png|webp);base64,[a-z0-9+/=\s]+$/i;

export function normalizeAppIconValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const icon = value.trim();
  if (!icon) return undefined;
  if (isAppSystemIconToken(icon)) return icon.toLowerCase();
  if (icon.length > APP_CUSTOM_ICON_DATA_URL_MAX_LENGTH || !APP_CUSTOM_ICON_DATA_URL_PATTERN.test(icon)) {
    return undefined;
  }
  const bytes = decodeBase64Payload(icon);
  if (!bytes || bytes.byteLength > APP_CUSTOM_ICON_MAX_BYTES) return undefined;
  const mime = icon.slice(5, icon.indexOf(";")).toLowerCase();
  if (mime === "image/png" && hasPngSignature(bytes)) return icon;
  if (mime === "image/webp" && hasWebpSignature(bytes)) return icon;
  return undefined;
}

export function isSupportedAppIconValue(value: unknown): value is string {
  return normalizeAppIconValue(value) !== undefined;
}

function decodeBase64Payload(dataUrl: string): Uint8Array | undefined {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1).replace(/\s/g, "");
  if (!payload || payload.length % 4 !== 0) return undefined;
  try {
    return Uint8Array.from(Buffer.from(payload, "base64"));
  } catch {
    return undefined;
  }
}

function hasPngSignature(bytes: Uint8Array): boolean {
  const expected = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return expected.every((value, index) => bytes[index] === value);
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}
