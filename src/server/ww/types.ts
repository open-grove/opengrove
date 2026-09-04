import type { DiagnosticHttpResponseAttempt } from "../../diagnostics/problem-schema.js";
import type { BridgeSessionUser } from "../bridge-session-user.js";

export interface WwTokenPair {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
  tokenType: "Bearer" | string;
  /** True only on the email-login response that registered the account. */
  isNewUser: boolean;
}

export interface WwApiError extends Error {
  status: number;
  code?: number;
  publicCode: string;
  requestId?: string;
  retryAfter?: number;
}

export interface WwResponseMappingError extends Error {
  validationCode: string;
  missingFields?: string[];
}

export interface WwLoginInput {
  email: string;
  code: string;
  deviceName?: string;
  platform?: string;
  /** Required by WW for first-time emails when invite gating is enabled. */
  inviteCode?: string;
  /** Required by WW only when the email creates a new account. */
  countryCode?: string;
}

export interface WwEmailCodeResult {
  requiresInvite?: boolean;
  requiresCountry?: boolean;
}

export interface WwUpdateProfileInput {
  displayName?: string | null;
  avatarDataUrl?: string | null;
}

export interface WwClientActivityInput {
  surface: "desktop" | "web";
  operatingSystem: "macos" | "windows" | "linux" | "unknown";
  architecture: "arm64" | "x64" | "unknown";
  clientVersion: string;
  clientReleaseNumber?: number;
  bridgeVersion: string;
  bridgeReleaseNumber?: number;
  releaseChannel: "stable" | "dev";
}

export interface WwClientActivityResult {
  day: string;
}

export interface WwApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  expiresAt?: string;
  createdAt?: string;
}

export interface WwCreatedApiKey extends WwApiKeySummary {
  apiKey: string;
}

export interface WwApiKeyRequestOptions {
  timeoutMs?: number;
}

export interface WwCreateApiKeyOptions extends WwApiKeyRequestOptions {
  idempotencyKey: string;
}

export interface WwLocalizedReleaseNotes {
  en?: string;
  "zh-CN"?: string;
}

export interface WwClientPlatformVersion {
  version: number;
  downloadUrl: string;
  updaterBaseUrl?: string;
  updaterFeedUrl?: string;
  releasedAt?: string;
  releaseNotes?: string;
  releaseNotesByLocale?: WwLocalizedReleaseNotes;
}

export interface WwLatestClientVersion {
  mac?: WwClientPlatformVersion;
  macArm64?: WwClientPlatformVersion;
  macX64?: WwClientPlatformVersion;
  windows?: WwClientPlatformVersion;
  windowsX64?: WwClientPlatformVersion;
  linux?: WwClientPlatformVersion;
  linuxX64?: WwClientPlatformVersion;
  linuxArm64?: WwClientPlatformVersion;
}

export interface WwAccountClient {
  sendEmailCode(email: string): Promise<WwEmailCodeResult>;
  login(input: WwLoginInput): Promise<WwTokenPair>;
  refresh(refreshToken: string): Promise<WwTokenPair>;
  logout(refreshToken: string): Promise<void>;
}

export interface WwProfileClient {
  readCurrentUser(accessToken: string): Promise<BridgeSessionUser>;
  updateCurrentUser(accessToken: string, input: WwUpdateProfileInput): Promise<BridgeSessionUser>;
}

export interface WwClientActivityClient {
  recordClientActivity(accessToken: string, input: WwClientActivityInput): Promise<WwClientActivityResult>;
}

export interface WwProviderCredentialsClient {
  createApiKey(accessToken: string, name: string, options: WwCreateApiKeyOptions): Promise<WwCreatedApiKey>;
  listApiKeys(accessToken: string, options?: WwApiKeyRequestOptions): Promise<WwApiKeySummary[]>;
}

export interface WwClientUpdateClient {
  readPublicLatestClientVersion(): Promise<WwLatestClientVersion>;
  readLatestClientVersion(accessToken: string): Promise<WwLatestClientVersion>;
}

export interface WwHostedServices {
  account: WwAccountClient;
  profile: WwProfileClient;
  clientActivity: WwClientActivityClient;
  providerCredentials: WwProviderCredentialsClient;
  clientUpdates: WwClientUpdateClient;
}

export interface WwHostedServicesOptions {
  requestTimeoutMs?: number;
}

export interface WwResponseDiagnostics {
  attempts: DiagnosticHttpResponseAttempt[];
}
