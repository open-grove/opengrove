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

export interface WwClientPlatformVersion {
  version: number;
  downloadUrl: string;
  updaterBaseUrl?: string;
  updaterFeedUrl?: string;
  releasedAt?: string;
  releaseNotes?: string;
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

export interface WwTeamGateStatus {
  required: boolean;
  satisfied: boolean;
}

export interface WwTeamAccount {
  email: string;
  /** Roles and status as the test database currently holds them, not a label. */
  roles: string[];
  status: string;
}

export interface WwAccountClient {
  sendEmailCode(email: string): Promise<WwEmailCodeResult>;
  login(input: WwLoginInput): Promise<WwTokenPair>;
  refresh(refreshToken: string): Promise<WwTokenPair>;
  logout(refreshToken: string): Promise<void>;
  /**
   * Reports whether this ww deployment gates sign-in behind a team token, and
   * whether the token currently configured satisfies it. Resolves to undefined
   * when the deployment has no gate at all -- a production build of ww does not
   * register the endpoint, so its absence is the answer rather than an error.
   */
  readTeamGateStatus(): Promise<WwTeamGateStatus | undefined>;
  /** The accounts a gated deployment offers the switcher. */
  listTeamAccounts(): Promise<WwTeamAccount[]>;
  /**
   * Becomes one of those accounts without a verification code. ww refuses any
   * address it does not offer, and any it offers but has never been seeded, so
   * this can never mint a session for a production identity.
   */
  signInAsTeamAccount(email: string): Promise<WwTokenPair>;
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
  // teamToken is the shared credential a test ww deployment requires in front
  // of its sign-in endpoints. It is attached to every outbound call, so no
  // individual client method has to know the gate exists.
  teamToken?: string;
}

export interface WwResponseDiagnostics {
  attempts: DiagnosticHttpResponseAttempt[];
}
