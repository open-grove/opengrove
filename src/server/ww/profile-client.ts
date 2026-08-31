import type { BridgeSessionUser } from "../bridge-session-user.js";
import { record, stringValue } from "../http-utils.js";
import type { WwTransport } from "./transport.js";
import type { WwProfileClient } from "./types.js";

export function createWwProfileClient(transport: WwTransport): WwProfileClient {
  return {
    async readCurrentUser(accessToken) {
      return mapWwUser(
        await transport.requestEnvelope<unknown>("/v1/users/me", {
          method: "GET",
          accessToken,
        }),
      );
    },
    async updateCurrentUser(accessToken, input) {
      return mapWwUser(
        await transport.requestEnvelope<unknown>("/v1/users/me", {
          method: "PATCH",
          accessToken,
          body: {
            ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
            ...(input.avatarDataUrl !== undefined ? { avatar_data_url: input.avatarDataUrl } : {}),
          },
        }),
      );
    },
  };
}

function mapWwUser(input: unknown): BridgeSessionUser {
  const object = record(input);
  const userId = stringValue(object.user_id).trim();
  const email = stringValue(object.email).trim();
  const countryCode = mappedCountryCode(stringValue(object.country_code));
  const displayName = stringValue(object.display_name).trim();
  const avatarUrl = stringValue(object.avatar_url).trim();
  const profileUpdatedAt = stringValue(object.profile_updated_at).trim();
  const profileStatus = mapProfileStatus(object.profile_status, profileUpdatedAt);
  const role = stringValue(object.role).trim() || "user";
  const roles = [
    ...new Set([
      role,
      ...(Array.isArray(object.roles) ? object.roles.map((value) => stringValue(value).trim()).filter(Boolean) : []),
    ]),
  ].sort();
  if (!userId || !email) throw new Error("ww_user_response_invalid");
  return {
    userId,
    email,
    ...(countryCode ? { countryCode } : {}),
    displayName: displayName || email,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(profileUpdatedAt ? { profileUpdatedAt } : {}),
    profileStatus,
    role,
    roles,
  };
}

function mappedCountryCode(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function mapProfileStatus(value: unknown, profileUpdatedAt: string): "available" | "missing" | "unavailable" {
  if (value === "available" || value === "missing" || value === "unavailable") return value;
  return profileUpdatedAt ? "available" : "missing";
}
