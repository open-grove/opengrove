import { randomUUID } from "node:crypto";
import { booleanValue, numberValue, record, stringValue } from "../http-utils.js";
import type { WwTransport } from "./transport.js";
import type { WwAccountClient, WwEmailCodeResult, WwLoginInput, WwTokenPair } from "./types.js";

export function createWwAccountClient(transport: WwTransport): WwAccountClient {
  return {
    async sendEmailCode(email) {
      return mapEmailCodeResult(
        await transport.requestEnvelope<unknown>("/v1/auth/email-codes", {
          method: "POST",
          body: { email },
        }),
      );
    },
    async login(input) {
      return mapTokenPair(
        await transport.requestEnvelope<unknown>("/v1/auth/email-login", {
          method: "POST",
          body: loginRequestBody(input),
        }),
      );
    },
    async refresh(refreshToken) {
      return mapTokenPair(
        await transport.requestEnvelope<unknown>("/v1/auth/token/refresh", {
          method: "POST",
          body: { refresh_token: refreshToken },
        }),
      );
    },
    async logout(refreshToken) {
      await transport.requestEnvelope<unknown>("/v1/auth/logout", {
        method: "POST",
        body: { refresh_token: refreshToken },
      });
    },
  };
}

export function normalizedDeviceName(value: string | undefined): string {
  const trimmed = value?.trim() || "OpenGrove Web";
  return Array.from(trimmed).slice(0, 100).join("");
}

export function normalizedInviteCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toUpperCase();
  if (!trimmed) return undefined;
  // WW rejects invite codes over 32 characters; clamp early so a paste with
  // stray text fails as invite_code_invalid instead of a generic 400.
  return trimmed.slice(0, 32);
}

export function normalizedCountryCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

export function normalizedPlatform(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "web" || normalized === "browser") return "unknown";
  if (normalized === "darwin") return "macos";
  if (normalized === "win32") return "windows";
  if (normalized === "linux") return "linux";
  if (
    normalized === "macos" ||
    normalized === "windows" ||
    normalized === "ios" ||
    normalized === "android" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return "unknown";
}

export function createLocalSessionId(): string {
  return randomUUID();
}

function loginRequestBody(input: WwLoginInput): Record<string, unknown> {
  const inviteCode = normalizedInviteCode(input.inviteCode);
  const countryCode = normalizedCountryCode(input.countryCode);
  return {
    email: input.email,
    code: input.code,
    device_name: normalizedDeviceName(input.deviceName),
    platform: normalizedPlatform(input.platform),
    ...(inviteCode ? { invite_code: inviteCode } : {}),
    ...(countryCode ? { country_code: countryCode } : {}),
  };
}

function mapEmailCodeResult(input: unknown): WwEmailCodeResult {
  const object = record(input);
  const requiresInvite = object.requires_invite;
  const requiresCountry = object.requires_country;
  return {
    ...(typeof requiresInvite === "boolean" ? { requiresInvite } : {}),
    ...(typeof requiresCountry === "boolean" ? { requiresCountry } : {}),
  };
}

function mapTokenPair(input: unknown): WwTokenPair {
  const object = record(input);
  return {
    accessToken: stringValue(object.access_token),
    accessTokenExpiresIn: numberValue(object.access_token_expires_in) ?? 0,
    refreshToken: stringValue(object.refresh_token),
    refreshTokenExpiresIn: numberValue(object.refresh_token_expires_in) ?? 0,
    tokenType: stringValue(object.token_type) || "Bearer",
    isNewUser: booleanValue(object.is_new_user),
  };
}
