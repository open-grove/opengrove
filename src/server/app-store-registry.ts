import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appStorePublishRequestIdempotencyKey } from "../app-store-publish-idempotency.js";
import {
  appStorePackageSourceIdentity,
  normalizeAppStorePackageKey,
  normalizeAppStoreRegistryUrl,
  normalizeArchiveSha256,
} from "../app-store-package-identity.js";
import {
  type AppStoreInstalledAppRef,
  type AppStoreInstallState,
  type AppStorePackageRecord,
  importAppStorePackage,
  isValidAppStoreAppId,
} from "./app-store.js";
import type { BridgeState } from "./bridge-types.js";
import { readWwRuntimeAuth, type BridgeSecurity } from "./bridge-security.js";
import { appStorePackageRequiresHostUpdate, clientReleaseRequestHeader } from "./client-release.js";
import { readReleaseControlBaseUrl } from "./release-control-config.js";

export interface AppStoreRegistryConfig {
  baseUrl: string;
  registryToken?: string;
}

interface RegistryPackagesResponse {
  packages?: unknown[];
}

interface RegistryPackageResponse {
  package?: unknown;
}

export interface RegistryInstallPolicyApp {
  packageKey: string;
  minimumVersion: string;
  minHostReleaseNumber?: number;
}

interface RegistryVersionsResponse {
  versions?: unknown[];
}

interface RegistryVersionResponse {
  version?: unknown;
}

const MAX_FORMAL_VERSION_ARCHIVE_BYTES = 256 * 1024 * 1024;
const RELEASE_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const RELEASE_CONTROL_ARCHIVE_TRANSFER_IDLE_TIMEOUT_MS = 30_000;
const RELEASE_CONTROL_UPLOAD_TIMEOUT_MS = 12 * 60_000;

export type AppStoreFormalVersionAvailability = "available" | "host_incompatible" | "artifact_unavailable";

export interface AppStoreFormalVersion {
  packageKey: string;
  packageId: string;
  appId: string;
  title: string;
  version: string;
  publishedBy: string;
  publishedAt: string;
  releaseCommitSha: string | null;
  releaseNotes: string;
  artifactSource: "registry" | "github-release";
  archiveName: string;
  archiveSize: number;
  archiveSha256: string;
  minHostReleaseNumber: number;
  availability: AppStoreFormalVersionAvailability;
  downloadReference: string | null;
}

export interface RegistryInstallPolicyEntryIssue {
  packageKey: string;
  reason: "policy_entry_invalid" | "policy_entry_duplicate";
}

export interface RegistryInstallPolicy {
  policyKey?: string;
  assignmentSource?: string;
  apps: RegistryInstallPolicyApp[];
  entryIssues: RegistryInstallPolicyEntryIssue[];
}

export function readAppStoreRegistryConfig(state?: BridgeState): AppStoreRegistryConfig | undefined {
  const appStore = state?.settings.appStore;
  const environmentBaseUrl =
    readAppStoreEnv("OPENGROVE_APP_STORE_REGISTRY_URL") || readAppStoreEnv("APP_STORE_REGISTRY_URL");
  const baseUrl = environmentBaseUrl || appStore?.registryUrl;
  if (!baseUrl) return undefined;
  const registryToken =
    readAppStoreEnv("OPENGROVE_APP_STORE_REGISTRY_TOKEN") ||
    readAppStoreEnv("APP_STORE_REGISTRY_TOKEN") ||
    (environmentBaseUrl ? undefined : appStore?.registryToken);
  return {
    baseUrl,
    ...(registryToken ? { registryToken } : {}),
  };
}

export async function resolveAppStoreRegistryConfig(
  state: BridgeState,
  request: IncomingMessage,
  response: ServerResponse,
  security?: BridgeSecurity,
): Promise<AppStoreRegistryConfig | undefined> {
  const configured = readAppStoreRegistryConfig(state);
  if (configured?.registryToken) return configured;
  if (security?.wwBaseUrl) {
    const session = await readWwRuntimeAuth(request, response, security);
    if (session?.auth.accessToken) {
      return releaseControlRegistryConfig(session.auth.accessToken);
    }
  }
  return configured;
}

export function releaseControlRegistryConfig(accessToken: string): AppStoreRegistryConfig {
  return {
    // WW owns identity only. Catalog, artifacts, publishing, and formal
    // versions all share Release Control as their single source of truth.
    baseUrl: readReleaseControlBaseUrl(),
    registryToken: accessToken,
  };
}

export async function listRegistryAppStorePackages(
  config: AppStoreRegistryConfig,
  request: IncomingMessage,
  options: { timeoutMs?: number } = {},
): Promise<AppStorePackageRecord[]> {
  const response = await registryFetch<RegistryPackagesResponse>(config, "/v1/app-store/packages", {
    request,
    registryScoped: true,
    timeoutMs: options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS,
  });
  return Array.isArray(response.packages)
    ? response.packages
        .map((item) => normalizeRegistryAppStorePackage(item, config.baseUrl))
        .filter((item): item is AppStorePackageRecord => Boolean(item))
    : [];
}

export async function readRegistryInstallPolicy(
  config: AppStoreRegistryConfig,
  request: IncomingMessage,
  options: { timeoutMs?: number } = {},
): Promise<RegistryInstallPolicy> {
  const response = await registryFetch<unknown>(config, "/v1/app-store/install-policy", {
    request,
    registryScoped: true,
    timeoutMs: options.timeoutMs ?? 5_000,
  });
  return normalizeRegistryInstallPolicy(response);
}

export async function listRegistryAppStoreVersions(
  config: AppStoreRegistryConfig,
  packageKey: string,
  options: { timeoutMs?: number } = {},
): Promise<AppStoreFormalVersion[]> {
  const normalizedPackageKey = normalizeAppStorePackageKey(packageKey);
  if (!normalizedPackageKey) throw new AppStoreRegistryError(400, "app_store_package_id_invalid");
  const response = await registryFetch<RegistryVersionsResponse>(
    config,
    `/v1/app-store/packages/${encodeURIComponent(normalizedPackageKey)}/versions`,
    { registryScoped: true, timeoutMs: options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS },
  );
  if (!Array.isArray(response.versions)) {
    throw new AppStoreRegistryError(502, "app_store_version_contract_invalid");
  }
  return response.versions.map((value) => {
    const normalized = normalizeRegistryFormalVersion(value);
    if (!normalized || normalized.packageKey !== normalizedPackageKey) {
      throw new AppStoreRegistryError(502, "app_store_version_contract_invalid");
    }
    return normalized;
  });
}

export async function importRegistryAppStoreVersionForInstall(
  state: BridgeState,
  formalVersion: AppStoreFormalVersion,
  catalogPackage: AppStorePackageRecord,
  config: AppStoreRegistryConfig,
  options: { timeoutMs?: number; connectTimeoutMs?: number; transferIdleTimeoutMs?: number } = {},
): Promise<AppStorePackageRecord> {
  if (
    formalVersion.availability !== "available" ||
    !formalVersion.downloadReference ||
    appStorePackageRequiresHostUpdate(formalVersion.minHostReleaseNumber)
  ) {
    throw new AppStoreRegistryError(
      409,
      formalVersion.availability === "host_incompatible" ||
        appStorePackageRequiresHostUpdate(formalVersion.minHostReleaseNumber)
        ? "app_store_host_update_required"
        : "app_store_version_artifact_unavailable",
    );
  }
  if (
    !Number.isSafeInteger(formalVersion.archiveSize) ||
    formalVersion.archiveSize <= 0 ||
    formalVersion.archiveSize > MAX_FORMAL_VERSION_ARCHIVE_BYTES
  ) {
    throw new AppStoreRegistryError(502, "app_store_archive_size_invalid");
  }
  if (
    normalizeAppStorePackageKey(catalogPackage.packageKey) !== formalVersion.packageKey ||
    catalogPackage.appId !== formalVersion.appId
  ) {
    throw new AppStoreRegistryError(409, "app_store_version_identity_mismatch");
  }
  const connectAbort = new AbortController();
  const connectTimeout = setTimeout(
    () => connectAbort.abort(),
    options.connectTimeoutMs ?? options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(withBasePath(config.baseUrl, formalVersion.downloadReference), {
      headers: {
        ...(config.registryToken ? { authorization: `Bearer ${config.registryToken}` } : {}),
        ...clientReleaseRequestHeader(),
      },
      signal: connectAbort.signal,
    });
  } finally {
    clearTimeout(connectTimeout);
  }
  if (!response.ok) {
    throw new AppStoreRegistryError(response.status, `registry_request_failed:${response.status}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength >= 0 &&
    contentLength !== formalVersion.archiveSize
  ) {
    throw new AppStoreRegistryError(502, "app_store_archive_size_mismatch");
  }
  const archiveBytes = await readExactArchiveBytes(
    response,
    formalVersion.archiveSize,
    options.transferIdleTimeoutMs ?? RELEASE_CONTROL_ARCHIVE_TRANSFER_IDLE_TIMEOUT_MS,
  );
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  if (archiveSha256 !== formalVersion.archiveSha256) {
    throw new AppStoreRegistryError(502, "app_store_archive_checksum_mismatch");
  }
  return importAppStorePackage({
    state,
    package: {
      ...catalogPackage,
      id: formalVersion.packageId || catalogPackage.id,
      packageId: formalVersion.packageId || catalogPackage.packageId,
      packageKey: formalVersion.packageKey,
      appId: formalVersion.appId,
      title: formalVersion.title || catalogPackage.title,
      version: formalVersion.version,
      publisher: formalVersion.publishedBy || catalogPackage.publisher,
      uploadedAt: formalVersion.publishedAt,
      archiveName: formalVersion.archiveName,
      archiveSize: formalVersion.archiveSize,
      archiveSha256: formalVersion.archiveSha256,
      releaseCommitSha: formalVersion.releaseCommitSha ?? undefined,
      minHostReleaseNumber: formalVersion.minHostReleaseNumber || undefined,
      source: "registry",
    },
    archiveBytes,
  });
}

async function readExactArchiveBytes(
  response: Response,
  expectedSize: number,
  transferIdleTimeoutMs: number,
): Promise<Buffer> {
  if (!response.body) {
    throw new AppStoreRegistryError(502, "app_store_archive_body_missing");
  }
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new AppStoreRegistryError(504, "app_store_archive_transfer_timeout"));
            void reader.cancel("app_store_archive_transfer_timeout");
          }, transferIdleTimeoutMs);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > expectedSize) {
        await reader.cancel();
        throw new AppStoreRegistryError(502, "app_store_archive_size_mismatch");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    if (received !== expectedSize) {
      throw new AppStoreRegistryError(502, "app_store_archive_size_mismatch");
    }
    return Buffer.concat(chunks, received);
  } finally {
    reader.releaseLock();
  }
}

export async function importRegistryAppStorePackageForInstall(
  state: BridgeState,
  request: IncomingMessage,
  packageId: string,
  config?: AppStoreRegistryConfig,
  options: { timeoutMs?: number; connectTimeoutMs?: number; transferIdleTimeoutMs?: number } = {},
): Promise<AppStorePackageRecord | undefined> {
  config = config ?? readAppStoreRegistryConfig(state);
  if (!config) throw new AppStoreRegistryError(404, "app_store_package_not_found");
  let archivePackageId = packageId;
  let normalizedPackage: AppStorePackageRecord | undefined;
  try {
    const response = await registryFetch<RegistryPackageResponse>(
      config,
      `/v1/app-store/packages/${encodeURIComponent(packageId)}`,
      { request, registryScoped: true, timeoutMs: options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS },
    );
    normalizedPackage = normalizeRegistryAppStorePackage(response.package, config.baseUrl, {
      rejectMalformedArchiveSha256: true,
    });
  } catch (error) {
    if (!(error instanceof AppStoreRegistryError) || error.status !== 404) throw error;
    const response = await registryFetch<RegistryPackagesResponse>(config, "/v1/app-store/packages", {
      request,
      registryScoped: true,
      timeoutMs: options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS,
    });
    const normalizedPackageId = normalizeAppStorePackageKey(packageId);
    const rawPackage = Array.isArray(response.packages)
      ? response.packages.find((item) => {
          const candidate = normalizeRegistryAppStorePackage(item, config.baseUrl);
          return (
            candidate?.id === packageId ||
            Boolean(normalizedPackageId && candidate?.packageKey === normalizedPackageId) ||
            candidate?.packageId === packageId
          );
        })
      : undefined;
    if (!rawPackage) throw error;
    normalizedPackage = normalizeRegistryAppStorePackage(rawPackage, config.baseUrl, {
      rejectMalformedArchiveSha256: true,
    });
    if (!normalizedPackage) throw error;
    archivePackageId = normalizedPackage.id;
  }
  if (!normalizedPackage) return undefined;
  if (normalizedPackage.hostUpdateRequired) {
    throw new AppStoreRegistryError(409, "app_store_host_update_required");
  }
  const formalVersion = await readRegistryAppStoreVersion(
    config,
    normalizedPackage.packageKey || archivePackageId,
    normalizedPackage.version,
    options.timeoutMs,
  );
  if (
    formalVersion.availability !== "available" ||
    formalVersion.packageKey !== normalizeAppStorePackageKey(normalizedPackage.packageKey) ||
    formalVersion.packageId !== normalizedPackage.packageId ||
    formalVersion.appId !== normalizedPackage.appId ||
    formalVersion.version !== normalizedPackage.version ||
    formalVersion.archiveName !== normalizedPackage.archiveName ||
    formalVersion.archiveSize !== normalizedPackage.archiveSize ||
    formalVersion.archiveSha256 !== normalizedPackage.archiveSha256
  ) {
    throw new AppStoreRegistryError(502, "app_store_version_contract_invalid");
  }
  const archiveBytes = await fetchRegistryAppStoreArchive(config, archivePackageId, formalVersion.archiveSize, options);
  validateRegistryAppStoreArchive(normalizedPackage, archiveBytes);
  return importAppStorePackage({
    state,
    package: {
      ...normalizedPackage,
      releaseCommitSha: formalVersion.releaseCommitSha ?? undefined,
    },
    archiveBytes,
  });
}

async function readRegistryAppStoreVersion(
  config: AppStoreRegistryConfig,
  packageKey: string,
  version: string,
  timeoutMs?: number,
): Promise<AppStoreFormalVersion> {
  const normalizedPackageKey = normalizeAppStorePackageKey(packageKey);
  if (!normalizedPackageKey || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new AppStoreRegistryError(502, "app_store_version_contract_invalid");
  }
  const response = await registryFetch<RegistryVersionResponse>(
    config,
    `/v1/app-store/packages/${encodeURIComponent(normalizedPackageKey)}/versions/${encodeURIComponent(version)}`,
    { registryScoped: true, timeoutMs: timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS },
  );
  const formalVersion = normalizeRegistryFormalVersion(response.version);
  if (!formalVersion || formalVersion.packageKey !== normalizedPackageKey || formalVersion.version !== version) {
    throw new AppStoreRegistryError(502, "app_store_version_contract_invalid");
  }
  return formalVersion;
}

export async function publishRegistryAppStorePackage(
  config: AppStoreRegistryConfig,
  bytes: Buffer,
  metadata: { fileName?: string; packageKey?: string; visibility?: string; idempotencyKey?: string },
): Promise<AppStorePackageRecord | undefined> {
  if (!config.registryToken) throw new AppStoreRegistryError(401, "registry_token_required");
  let upload = await uploadRegistryAppStorePackage(config, "/v1/app-store/packages", bytes, metadata, "create");
  if (
    !upload.ok &&
    upload.status === 409 &&
    registryErrorCode(upload.body) === "app_store_package_exists" &&
    metadata.packageKey?.trim()
  ) {
    upload = await uploadRegistryAppStorePackage(
      config,
      `/v1/app-store/packages/${encodeURIComponent(metadata.packageKey.trim())}/versions`,
      bytes,
      metadata,
      "version",
    );
  }
  if (!upload.ok) {
    const error = record(upload.body);
    throw new AppStoreRegistryError(
      upload.status,
      stringValue(error.error) || `registry_request_failed:${upload.status}`,
    );
  }
  return normalizeRegistryAppStorePackage(record(upload.body).package, config.baseUrl);
}

async function uploadRegistryAppStorePackage(
  config: AppStoreRegistryConfig,
  path: string,
  bytes: Buffer,
  metadata: { fileName?: string; packageKey?: string; visibility?: string; idempotencyKey?: string },
  operation: "create" | "version",
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const packageMetadata = Buffer.from(
    JSON.stringify({
      ...(metadata.fileName?.trim() ? { fileName: metadata.fileName.trim() } : {}),
      ...(metadata.packageKey?.trim() ? { packageKey: metadata.packageKey.trim() } : {}),
      ...(metadata.visibility?.trim() ? { visibility: metadata.visibility.trim() } : {}),
    }),
    "utf8",
  ).toString("base64url");
  const response = await fetch(withBasePath(config.baseUrl, path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.registryToken}`,
      "content-type": "application/vnd.opengrove.app-package",
      "x-opengrove-package-metadata": packageMetadata,
      ...clientReleaseRequestHeader(),
      ...(metadata.idempotencyKey?.trim()
        ? {
            "Idempotency-Key": appStorePublishRequestIdempotencyKey(metadata.idempotencyKey.trim(), operation),
          }
        : {}),
    },
    body: bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(RELEASE_CONTROL_UPLOAD_TIMEOUT_MS),
  });
  const text = await response.text();
  const parsed = parseRegistryResponseBody(text, response.ok);
  return { ok: response.ok, status: response.status, body: parsed };
}

export function mergeAppStoreCatalogPackages(
  localPackages: AppStorePackageRecord[],
  registryPackages: AppStorePackageRecord[],
  installedEmployeePackageIdsValue: Iterable<string>,
  installedAppRefsValue: Iterable<AppStoreInstalledAppRef> = [],
): AppStorePackageRecord[] {
  const installedEmployees = new Set(installedEmployeePackageIdsValue);
  const localById = new Map<string, AppStorePackageRecord>();
  const localBySourceIdentity = new Map<string, AppStorePackageRecord>();
  const installedAppById = new Map<string, AppStoreInstalledAppRef>();
  const installedAppBySourceIdentity = new Map<string, AppStoreInstalledAppRef>();
  for (const item of localPackages) {
    localById.set(item.id, item);
    const sourceIdentity = appStorePackageSourceIdentity(item);
    if (item.source === "registry" && sourceIdentity) {
      localBySourceIdentity.set(sourceIdentity, item);
    }
  }
  for (const item of installedAppRefsValue) {
    installedAppById.set(item.appId, item);
    installedAppById.set(item.mountedAppId, item);
    const sourceIdentity = appStorePackageSourceIdentity(item);
    if (sourceIdentity) installedAppBySourceIdentity.set(sourceIdentity, item);
  }
  return registryPackages.map((registryPackage) => {
    const packageKey = normalizeAppStorePackageKey(registryPackage.packageKey);
    const sourceIdentity = appStorePackageSourceIdentity(registryPackage);
    const registryArchiveSha256 = normalizeArchiveSha256(registryPackage.archiveSha256);
    const local =
      localById.get(registryPackage.id) || (sourceIdentity ? localBySourceIdentity.get(sourceIdentity) : undefined);
    const installedApp = sourceIdentity ? installedAppBySourceIdentity.get(sourceIdentity) : undefined;
    const appIdOccupant = installedAppById.get(registryPackage.appId) || installedAppById.get(registryPackage.id);
    // Employee membership proves installation, but it does not yet carry an installed archive fingerprint.
    // Never reconstruct that fingerprint from catalog cache data.
    const installedEmployee =
      (registryPackage.publishKind ?? "app") === "employee" && installedEmployees.has(registryPackage.id);
    const installedArchiveSha256 = normalizeArchiveSha256(installedApp?.archiveSha256);
    const updateAvailable = Boolean(
      installedApp &&
        installedArchiveSha256 &&
        registryArchiveSha256 &&
        installedArchiveSha256 !== registryArchiveSha256,
    );
    const missingInstalledRoot =
      (registryPackage.publishKind ?? "app") === "app" && !installedApp && appIdOccupant?.appRootExists === false;
    const occupantSourceIdentity = appIdOccupant ? appStorePackageSourceIdentity(appIdOccupant) : undefined;
    const occupantPackageKey = normalizeAppStorePackageKey(appIdOccupant?.packageKey);
    const occupantManifestPackageKey = normalizeAppStorePackageKey(appIdOccupant?.manifestPackageKey);
    const legacyMarkerCompatible =
      !appIdOccupant?.markerSource ||
      (appIdOccupant.markerSource === "registry" && (!occupantPackageKey || occupantPackageKey === packageKey));
    const needsRelink =
      (registryPackage.publishKind ?? "app") === "app" &&
      !installedApp &&
      appIdOccupant?.appRootExists === true &&
      !occupantSourceIdentity &&
      legacyMarkerCompatible &&
      Boolean(packageKey && (occupantPackageKey === packageKey || occupantManifestPackageKey === packageKey));
    const sourceConflict =
      (registryPackage.publishKind ?? "app") === "app" &&
      !installedApp &&
      Boolean(appIdOccupant) &&
      !missingInstalledRoot &&
      !needsRelink;
    const installState = resolveAppStoreInstallState({
      installedEmployee,
      needsRelink,
      sourceConflict,
      installedApp: Boolean(installedApp || missingInstalledRoot || needsRelink),
      installedArchiveSha256,
      cloudArchiveSha256: registryArchiveSha256,
    });
    return {
      ...registryPackage,
      ...(packageKey ? { packageKey } : {}),
      ...(registryArchiveSha256 ? { archiveSha256: registryArchiveSha256 } : {}),
      installed: Boolean(installedApp || installedEmployee || missingInstalledRoot || needsRelink),
      installedAppId:
        installedApp?.mountedAppId ??
        installedApp?.appId ??
        (missingInstalledRoot || needsRelink ? appIdOccupant?.mountedAppId : undefined),
      installState,
      updateAvailable,
      ...(needsRelink ? { openIssue: "store_relink_required" as const } : {}),
      ...(sourceConflict ? { openIssue: "source_conflict" as const } : {}),
      ...(!needsRelink && !sourceConflict && installState === "legacy_unknown"
        ? { openIssue: "install_evidence_missing" as const }
        : {}),
      doctor: local?.doctor ?? registryPackage.doctor,
    };
  });
}

function resolveAppStoreInstallState(input: {
  installedEmployee: boolean;
  needsRelink: boolean;
  sourceConflict: boolean;
  installedApp: boolean;
  installedArchiveSha256?: string;
  cloudArchiveSha256?: string;
}): AppStoreInstallState {
  if (input.installedEmployee) return "installed_current";
  if (input.needsRelink) return "needs_relink";
  if (input.sourceConflict) return "source_conflict";
  if (!input.installedApp) return "not_installed";
  if (!input.installedArchiveSha256 || !input.cloudArchiveSha256) return "legacy_unknown";
  return input.installedArchiveSha256 === input.cloudArchiveSha256 ? "installed_current" : "update_available";
}

export function appStoreRegistryErrorStatus(error: unknown): number {
  if (error instanceof AppStoreRegistryError && error.status === 401) return 401;
  if (error instanceof AppStoreRegistryError && error.status === 404) return 404;
  if (error instanceof AppStoreRegistryError && error.status === 409) return 409;
  return 502;
}

export function registryPublishErrorStatus(error: unknown): number {
  if (error instanceof Error && error.message === "app_store_upload_too_large") return 413;
  if (
    error instanceof Error &&
    new Set(["app_store_publish_target_changed", "app_store_publish_intent_changed"]).has(error.message)
  )
    return 409;
  if (error instanceof Error && error.message.startsWith("app_store_publish_recovery_")) return 500;
  if (error instanceof AppStoreRegistryError && error.status >= 400 && error.status < 500) return error.status;
  return 502;
}

async function fetchRegistryAppStoreArchive(
  config: AppStoreRegistryConfig,
  packageId: string,
  expectedSize: number,
  options: { timeoutMs?: number; connectTimeoutMs?: number; transferIdleTimeoutMs?: number },
): Promise<Buffer | undefined> {
  if (!config.registryToken) throw new AppStoreRegistryError(401, "registry_token_required");
  const download = await registryFetch<{
    url: string;
  }>(config, `/v1/app-store/packages/${encodeURIComponent(packageId)}/download-url`, {
    registryScoped: true,
    timeoutMs: options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS,
  });
  const downloadUrl = resolveRegistryDownloadUrl(config.baseUrl, download.url);
  const connectAbort = new AbortController();
  const connectTimeout = setTimeout(
    () => connectAbort.abort(),
    options.connectTimeoutMs ?? options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(downloadUrl, {
      headers: {
        ...(registryDownloadNeedsAuthorization(config, downloadUrl) && config.registryToken
          ? { authorization: `Bearer ${config.registryToken}` }
          : {}),
        ...clientReleaseRequestHeader(),
      },
      signal: connectAbort.signal,
    });
  } finally {
    clearTimeout(connectTimeout);
  }
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new AppStoreRegistryError(response.status, `registry_request_failed:${response.status}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength >= 0 &&
    contentLength !== expectedSize
  ) {
    throw new AppStoreRegistryError(502, "app_store_archive_size_mismatch");
  }
  return readExactArchiveBytes(
    response,
    expectedSize,
    options.transferIdleTimeoutMs ?? RELEASE_CONTROL_ARCHIVE_TRANSFER_IDLE_TIMEOUT_MS,
  );
}

export function resolveRegistryDownloadUrl(baseUrl: string, reference: string): string {
  const value = reference.trim();
  try {
    const absolute = new URL(value);
    if (absolute.protocol === "http:" || absolute.protocol === "https:") {
      return absolute.toString();
    }
  } catch {
    // non-critical-fallback: A non-absolute reference is validated and resolved through the configured ingress prefix below.
  }
  if (!value.startsWith("/")) {
    throw new AppStoreRegistryError(502, "app_store_download_url_invalid");
  }
  return withBasePath(baseUrl, value);
}

function registryDownloadNeedsAuthorization(config: AppStoreRegistryConfig, downloadUrl: string): boolean {
  try {
    return new URL(downloadUrl).origin === new URL(config.baseUrl).origin;
  } catch {
    // non-critical-fallback: Malformed URLs must never receive the Registry authorization header.
    return false;
  }
}

function validateRegistryAppStoreArchive(record: AppStorePackageRecord, archiveBytes: Buffer | undefined): void {
  if (record.archiveSha256 === undefined) return;
  const expectedSha256 = record.archiveSha256?.trim().toLowerCase();
  if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new AppStoreRegistryError(502, "app_store_archive_checksum_invalid");
  }
  if (!archiveBytes) {
    throw new AppStoreRegistryError(502, "app_store_archive_missing");
  }
  const actualSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new AppStoreRegistryError(502, "app_store_archive_checksum_mismatch");
  }
}

function normalizeRegistryAppStorePackage(
  value: unknown,
  registryUrl: string,
  options: { rejectMalformedArchiveSha256?: boolean } = {},
): AppStorePackageRecord | undefined {
  const raw = record(value);
  const packageKey = normalizeAppStorePackageKey(raw.packageKey);
  const packageId = stringValue(raw.packageId) || packageKey;
  const id = stringValue(raw.id) || packageKey || packageId;
  const appId = stringValue(raw.appId) || packageId || id;
  if (!id || !appId || !isValidAppStoreAppId(id) || !isValidAppStoreAppId(appId)) return undefined;
  const employee = normalizeRegistryAgentSummary(raw.employee);
  const employeeName = stringValue(employee?.name);
  const title = stringValue(raw.title) || stringValue(raw.name) || employeeName || id;
  const requirementsRecord = record(raw.requirements);
  const requirements = [
    ...stringArray(requirementsRecord.providers).map((item) => `provider:${item}`),
    ...stringArray(requirementsRecord.env).map((item) => `env:${item}`),
    ...stringArray(requirementsRecord.system).map((item) => `system:${item}`),
  ];
  const archiveSha256 = normalizeArchiveSha256(raw.archiveSha256);
  const minHostReleaseNumber =
    typeof raw.minHostReleaseNumber === "number" &&
    Number.isInteger(raw.minHostReleaseNumber) &&
    raw.minHostReleaseNumber > 0
      ? raw.minHostReleaseNumber
      : undefined;
  if (options.rejectMalformedArchiveSha256 && raw.archiveSha256 !== undefined && !archiveSha256) {
    throw new AppStoreRegistryError(502, "app_store_archive_checksum_invalid");
  }
  return {
    id,
    packageId,
    title,
    summary: stringValue(raw.summary) || stringValue(raw.description) || stringValue(employee?.publicDescription),
    icon: stringValue(raw.icon) || undefined,
    employee,
    category: stringValue(raw.category) || (raw.publishKind === "employee" ? "employee" : "workspace"),
    publishKind: raw.publishKind === "employee" ? "employee" : "app",
    installMode: raw.installMode === "contacts" ? "contacts" : "workspace",
    appId,
    workspaceName: stringValue(raw.workspaceName) || title,
    requirements,
    capabilities: stringArray(raw.capabilities),
    backupScopes: stringArray(raw.backupScopes),
    status: raw.status === "preview" ? "preview" : "available",
    visibility: raw.visibility === "public" ? "public" : raw.visibility === "restricted" ? "restricted" : undefined,
    publisher: stringValue(raw.publisher) || "OpenGrove User",
    usageCount: Number.isFinite(raw.usageCount) ? Number(raw.usageCount) : 0,
    source: "registry",
    defaultLocale: stringValue(raw.defaultLocale) || undefined,
    ...(Object.keys(record(raw.locales)).length ? { locales: record(raw.locales) } : {}),
    version: stringValue(raw.version) || "0.1.0",
    minHostReleaseNumber,
    ...(appStorePackageRequiresHostUpdate(minHostReleaseNumber) ? { hostUpdateRequired: true } : {}),
    uploadedAt: stringValue(raw.publishedAt) || undefined,
    packageKey,
    packageRef: packageKey
      ? `${normalizeAppStoreRegistryUrl(registryUrl) ?? registryUrl.replace(/\/+$/g, "")}#${packageKey}`
      : undefined,
    archiveName: stringValue(raw.fileName) || stringValue(raw.archiveName),
    archiveSize: Number.isFinite(raw.archiveSize) ? Number(raw.archiveSize) : undefined,
    archiveSha256,
  };
}

function normalizeRegistryAgentSummary(value: unknown): AppStorePackageRecord["employee"] {
  const raw = record(value);
  const id = stringValue(raw.id);
  const name = stringValue(raw.name) || stringValue(raw.title);
  if (!id && !name) return undefined;
  return {
    id: id || name,
    name: name || id,
    role: stringValue(raw.role) || undefined,
    kernel: stringValue(raw.kernel) || undefined,
    model: stringValue(raw.model) || undefined,
    skills: stringArray(raw.skills),
    visibility: raw.visibility === "public" ? "public" : raw.visibility === "private" ? "private" : undefined,
    publicDescription: stringValue(raw.publicDescription) || undefined,
    publicSkills: stringArray(raw.publicSkills),
    inputSpec: stringValue(raw.inputSpec) || undefined,
    outputSpec: stringValue(raw.outputSpec) || undefined,
  };
}

function normalizeRegistryFormalVersion(value: unknown): AppStoreFormalVersion | undefined {
  const raw = record(value);
  const packageKey = normalizeAppStorePackageKey(raw.packageKey);
  const packageId = stringValue(raw.packageId);
  const appId = stringValue(raw.appId);
  const title = stringValue(raw.title);
  const version = stringValue(raw.version);
  const archiveSha256 = normalizeArchiveSha256(raw.archiveSha256);
  const archiveSize = Number(raw.archiveSize);
  const minHostReleaseNumber = Number(raw.minHostReleaseNumber ?? 0);
  const availability = raw.availability;
  const artifactSource = raw.artifactSource;
  const releaseCommitSha = raw.releaseCommitSha === null ? null : stringValue(raw.releaseCommitSha);
  const downloadReference = raw.downloadReference === null ? null : stringValue(raw.downloadReference);
  if (
    !packageKey ||
    !packageId ||
    !appId ||
    !title ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !Number.isSafeInteger(archiveSize) ||
    archiveSize < 0 ||
    !Number.isSafeInteger(minHostReleaseNumber) ||
    minHostReleaseNumber < 0 ||
    !new Set(["available", "host_incompatible", "artifact_unavailable"]).has(String(availability)) ||
    !new Set(["registry", "github-release"]).has(String(artifactSource)) ||
    (releaseCommitSha !== null && !/^[a-f0-9]{40}$/.test(releaseCommitSha)) ||
    (downloadReference !== null && !downloadReference.startsWith("/")) ||
    (availability === "available" && (!downloadReference || !archiveSha256 || archiveSize <= 0)) ||
    (availability !== "available" && downloadReference !== null)
  ) {
    return undefined;
  }
  return {
    packageKey,
    packageId,
    appId,
    title,
    version,
    publishedBy: stringValue(raw.publishedBy),
    publishedAt: stringValue(raw.publishedAt),
    releaseCommitSha,
    releaseNotes: stringValue(raw.releaseNotes),
    artifactSource: artifactSource as AppStoreFormalVersion["artifactSource"],
    archiveName: stringValue(raw.archiveName),
    archiveSize,
    archiveSha256: archiveSha256 ?? "",
    minHostReleaseNumber,
    availability: availability as AppStoreFormalVersionAvailability,
    downloadReference,
  };
}

function registryErrorCode(value: unknown): string {
  return stringValue(record(value).error);
}

async function registryFetch<T>(
  config: AppStoreRegistryConfig,
  path: string,
  options: {
    method?: string;
    request?: IncomingMessage;
    body?: unknown;
    registryScoped?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  if (options.registryScoped && !config.registryToken) {
    throw new AppStoreRegistryError(401, "registry_token_required");
  }
  const response = await fetch(withBasePath(config.baseUrl, path), {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.registryScoped && config.registryToken ? { authorization: `Bearer ${config.registryToken}` } : {}),
      ...clientReleaseRequestHeader(),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? RELEASE_CONTROL_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const parsed = parseRegistryResponseBody(text, response.ok);
  if (!response.ok) {
    const error = record(parsed);
    throw new AppStoreRegistryError(
      response.status,
      stringValue(error.error) || `registry_request_failed:${response.status}`,
    );
  }
  return parsed as T;
}

function parseRegistryResponseBody(text: string, ok: boolean): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (ok) {
      console.warn("app_store_registry_response_invalid", {
        responsePreview: text.slice(0, 1_024),
        parseError: error instanceof Error ? error.message : String(error),
      });
      throw new AppStoreRegistryError(502, "registry_response_invalid");
    }
    return { error: text, parseError: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeRegistryInstallPolicy(value: unknown): RegistryInstallPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppStoreRegistryError(502, "app_store_install_policy_invalid");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.apps)) {
    throw new AppStoreRegistryError(502, "app_store_install_policy_invalid");
  }
  const policyKey = optionalDiagnosticString(raw.policyKey, 128);
  const assignmentSource = optionalDiagnosticString(raw.assignmentSource, 128);
  const apps: RegistryInstallPolicyApp[] = [];
  const entryIssues: RegistryInstallPolicyEntryIssue[] = [];
  const seenPackageKeys = new Set<string>();
  for (const value of raw.apps) {
    const app = normalizeRegistryInstallPolicyApp(value);
    if (!app) {
      entryIssues.push({
        packageKey: installPolicyDiagnosticPackageKey(value),
        reason: "policy_entry_invalid",
      });
      continue;
    }
    if (seenPackageKeys.has(app.packageKey)) {
      entryIssues.push({
        packageKey: app.packageKey,
        reason: "policy_entry_duplicate",
      });
      continue;
    }
    seenPackageKeys.add(app.packageKey);
    apps.push(app);
  }
  return {
    ...(policyKey ? { policyKey } : {}),
    ...(assignmentSource ? { assignmentSource } : {}),
    apps,
    entryIssues,
  };
}

function normalizeRegistryInstallPolicyApp(value: unknown): RegistryInstallPolicyApp | undefined {
  const raw = record(value);
  const packageKey = normalizeAppStorePackageKey(raw.packageKey);
  const minimumVersion = stringValue(raw.minimumVersion);
  if (!packageKey || minimumVersion.length > 64) return undefined;
  const minHostReleaseNumber =
    typeof raw.minHostReleaseNumber === "number" &&
    Number.isSafeInteger(raw.minHostReleaseNumber) &&
    raw.minHostReleaseNumber > 0
      ? raw.minHostReleaseNumber
      : undefined;
  return { packageKey, minimumVersion, minHostReleaseNumber };
}

function optionalDiagnosticString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function installPolicyDiagnosticPackageKey(value: unknown): string {
  const rawPackageKey = record(value).packageKey;
  if (typeof rawPackageKey !== "string") return "*";
  return rawPackageKey.trim().slice(0, 128) || "*";
}

export class AppStoreRegistryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readAppStoreEnv(name: string): string {
  return process.env[name]?.trim() || "";
}

function withBasePath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const [pathname, search = ""] = path.split("?");
  url.pathname = `${url.pathname.replace(/\/$/, "")}${pathname}`;
  url.search = search ? `?${search}` : "";
  url.hash = "";
  return url.toString();
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value].filter(Boolean);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
