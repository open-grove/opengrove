export const REDACTED_WIRE_VALUE = "[redacted]";

export function isSensitiveWireKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("bearer") ||
    normalized.includes("signature") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("token") ||
    normalized.includes("privatekey")
  );
}
