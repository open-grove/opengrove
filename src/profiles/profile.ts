export type OpenGroveProfile = "local" | "test";

export function normalizeOpenGroveProfile(value: unknown, fallback: OpenGroveProfile = "local"): OpenGroveProfile {
  return value === "test" || value === "local" ? value : fallback;
}
