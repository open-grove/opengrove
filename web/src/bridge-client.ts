import {
  askCancelContract,
  askCompactContract,
  askGuideContract,
  bridgeContractIssues,
  type BridgeContractRequest,
  type BridgeContractResponse,
  type BridgeJsonContract,
} from "@opengrove/agent-protocol";
import type { BridgeStreamChunk } from "./runtime/agent-events";
import { apiUrl } from "./api-base";
import { APP_BRIDGE_TOKEN_HEADER, APP_STORAGE_KEYS } from "./identity";
import type { LanguagePreference, ResolvedLanguage } from "./i18n-types";
import type {
  AskFinalPayload,
  AppStoreInstallResponse,
  AppStorePackageVisibility,
  AppStorePrepareReleaseResponse,
  AppStoreRepairResponse,
  AppStoreRelinkResponse,
  AppStoreResponse,
  AppStoreUninstallResponse,
  AppStoreUploadResponse,
  MountedAppPublishResponse,
  MountedAppReleaseDraft,
  MountedAppIdentityResponse,
  LocalAppDraftResponse,
  MountedAppVersionsResponse,
  MountedAppVersionSwitchResponse,
  BridgeAuthResponse,
  MountedAppDashboardResponse,
  MountedAppFileResponse,
  MountedAppFilesResponse,
  MountedAppFileSystemResponse,
  MountedAppFlowsResponse,
  ReasoningEffort,
  ResponseSpeed,
  RuntimeAccessMode,
  VoiceSttProviderId,
  VoiceTranscriptionResponse,
} from "./bridge-types";

export function bridgeHeaders(includeContentType = true): HeadersInit {
  const headers: Record<string, string> = {};
  if (includeContentType) {
    headers["content-type"] = "application/json";
  }
  const token = localStorage.getItem(APP_STORAGE_KEYS.bridgeToken);
  if (token) {
    headers[APP_BRIDGE_TOKEN_HEADER] = token;
  }
  return headers;
}

export async function readBridgeError(response: Response): Promise<string> {
  return (await readBridgeErrorDetails(response)).error;
}

async function readBridgeErrorDetails(response: Response): Promise<{
  error: string;
  code?: string;
  requestId?: string;
  incidentId?: string;
  traceId?: string;
  retryAfter?: number;
  payload?: Record<string, unknown>;
}> {
  return parseBridgeErrorDetails(await response.text(), response);
}

function parseBridgeErrorDetails(
  text: string,
  response: Response,
): {
  error: string;
  code?: string;
  requestId?: string;
  incidentId?: string;
  traceId?: string;
  retryAfter?: number;
  payload?: Record<string, unknown>;
} {
  try {
    const data = JSON.parse(text) as unknown;
    if (!isBridgeRecordLike(data)) {
      return {
        error: text || `request_failed:${response.status}`,
        traceId: response.headers.get("x-opengrove-trace-id") || undefined,
      };
    }
    const code = firstBridgeCode(data, [
      "error.code",
      "error.status_code",
      "error.statusCode",
      "error.error_code",
      "error.errorCode",
      "code",
      "status_code",
      "statusCode",
      "error_code",
      "errorCode",
      "data.error.code",
      "data.error.status_code",
      "data.error.statusCode",
      "data.error.error_code",
      "data.error.errorCode",
      "data.code",
      "data.status_code",
      "data.statusCode",
      "data.error_code",
      "data.errorCode",
    ]);
    return {
      error:
        firstBridgeString(data, [
          "error",
          "error.message",
          "error.error",
          "error.error_name",
          "error.errorName",
          "error.name",
          "error.code_name",
          "error.codeName",
          "message",
          "error_message",
          "errorMessage",
          "error_name",
          "errorName",
          "name",
          "code_name",
          "codeName",
          "data.error",
          "data.error.message",
          "data.error.error",
          "data.error.error_name",
          "data.error.errorName",
          "data.error.name",
          "data.error.code_name",
          "data.error.codeName",
          "data.message",
          "data.error_message",
          "data.errorMessage",
          "data.error_name",
          "data.errorName",
          "data.name",
          "data.code_name",
          "data.codeName",
        ]) ||
        code ||
        `request_failed:${response.status}`,
      code,
      requestId:
        firstBridgeString(data, [
          "requestId",
          "request_id",
          "error.requestId",
          "error.request_id",
          "data.requestId",
          "data.request_id",
          "data.error.requestId",
          "data.error.request_id",
        ]) || undefined,
      incidentId:
        firstBridgeString(data, ["incidentId", "incident_id", "error.incidentId", "error.incident_id"]) || undefined,
      traceId:
        firstBridgeString(data, ["traceId", "trace_id", "error.traceId", "error.trace_id"]) ||
        response.headers.get("x-opengrove-trace-id") ||
        undefined,
      retryAfter:
        firstBridgeNumber(data, ["retryAfter", "retry_after", "error.retryAfter", "error.retry_after"]) ?? undefined,
      payload: data as Record<string, unknown>,
    };
  } catch {
    return {
      error: text || `request_failed:${response.status}`,
      traceId: response.headers.get("x-opengrove-trace-id") || undefined,
    };
  }
}

function firstBridgeString(value: unknown, paths: string[]): string {
  for (const path of paths) {
    const item = bridgeValueAtPath(value, path);
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function firstBridgeCode(value: unknown, paths: string[]): string {
  for (const path of paths) {
    const item = bridgeValueAtPath(value, path);
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
  }
  return "";
}

function firstBridgeNumber(value: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const item = bridgeValueAtPath(value, path);
    if (typeof item === "number" && Number.isFinite(item)) return item;
  }
  return null;
}

function bridgeValueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isBridgeRecordLike(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isBridgeRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BridgeRequestError extends Error {
  code?: string;
  requestId?: string;
  incidentId?: string;
  traceId?: string;
  payload?: Record<string, unknown>;
}

export class BridgeAuthError extends BridgeRequestError {
  retryAfter?: number;
}

export type BridgeDownloadErrorKind = "auth" | "network" | "timeout" | "server";

export class BridgeDownloadError extends BridgeRequestError {
  readonly kind: BridgeDownloadErrorKind;
  status?: number;

  constructor(kind: BridgeDownloadErrorKind, message: string) {
    super(message);
    this.name = "BridgeDownloadError";
    this.kind = kind;
  }
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: "no-store", credentials: "include", ...init });
  if (!response.ok) {
    const details = await readBridgeErrorDetails(response);
    const error = new BridgeRequestError(details.error);
    error.code = details.code;
    error.requestId = details.requestId;
    error.incidentId = details.incidentId;
    error.traceId = details.traceId;
    error.payload = details.payload;
    throw error;
  }
  return (await response.json()) as T;
}

export class BridgeContractError extends Error {
  readonly code: "bridge_request_contract_invalid" | "bridge_response_contract_invalid";
  readonly contractId: string;
  readonly issues: ReturnType<typeof bridgeContractIssues>;

  constructor(direction: "request" | "response", contractId: string, issues: ReturnType<typeof bridgeContractIssues>) {
    const code = direction === "request" ? "bridge_request_contract_invalid" : "bridge_response_contract_invalid";
    super(`${code}:${contractId}`);
    this.name = "BridgeContractError";
    this.code = code;
    this.contractId = contractId;
    this.issues = issues;
  }
}

export async function fetchContractJson<TContract extends BridgeJsonContract>(
  contract: TContract,
  path: string,
  init?: RequestInit,
): Promise<BridgeContractResponse<TContract>> {
  const data = await fetchJson<unknown>(path, init);
  const parsed = contract.response.safeParse(data);
  if (!parsed.success) {
    throw new BridgeContractError("response", contract.id, bridgeContractIssues(parsed.error));
  }
  return parsed.data as BridgeContractResponse<TContract>;
}

export async function postContractJson<TContract extends BridgeJsonContract>(
  contract: TContract,
  path: string,
  payload: BridgeContractRequest<TContract>,
): Promise<BridgeContractResponse<TContract>> {
  if (!contract.request) {
    throw new Error(`bridge_contract_request_schema_missing:${contract.id}`);
  }
  const parsed = contract.request.safeParse(payload);
  if (!parsed.success) {
    throw new BridgeContractError("request", contract.id, bridgeContractIssues(parsed.error));
  }
  return fetchContractJson(contract, path, {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify(parsed.data),
  });
}

export async function postJson<T>(path: string, payload: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function postEmptyJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    headers: bridgeHeaders(false),
  });
}

export async function getJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, {
    method: "GET",
    headers: bridgeHeaders(false),
  });
}

export async function downloadBridgeFile(
  url: string,
  fileName: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  return (await downloadBridgeFileWithMetadata(url, fileName, options)).fileName;
}

export interface BridgeDownloadResult {
  fileName: string;
  sizeBytes: number;
  sha256?: string;
  evidenceComplete?: boolean;
}

export async function downloadBridgeFileWithMetadata(
  url: string,
  fileName: string,
  options: { timeoutMs?: number } = {},
): Promise<BridgeDownloadResult> {
  const noProgressTimeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
  const controller = new AbortController();
  const request = downloadRequest(url);
  try {
    const response = await withDownloadNoProgressTimeout(
      fetch(request.url, {
        cache: "no-store",
        credentials: request.authenticated ? "include" : "omit",
        headers: request.authenticated ? bridgeHeaders(false) : undefined,
        signal: controller.signal,
      }),
      noProgressTimeoutMs,
      controller,
    );
    const body = await readDownloadResponseBlob(response, noProgressTimeoutMs, controller);
    if (!response.ok) {
      const details = parseBridgeErrorDetails(await body.text(), response);
      const kind = isDownloadAuthFailure(response.status, details.error) ? "auth" : "server";
      const error = new BridgeDownloadError(kind, details.error);
      error.status = response.status;
      error.requestId = details.requestId;
      error.incidentId = details.incidentId;
      error.traceId = details.traceId;
      throw error;
    }
    const downloadedFileName = downloadFileName(response.headers.get("content-disposition")) ?? fileName;
    const objectUrl = URL.createObjectURL(body);
    const anchor = document.createElement("a");
    try {
      anchor.href = objectUrl;
      anchor.download = downloadedFileName;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      window.setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      }, 1_000);
    } catch (error) {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
    return {
      fileName: downloadedFileName,
      sizeBytes: body.size,
      sha256: response.headers.get("x-opengrove-sha256")?.trim() || undefined,
      evidenceComplete: response.headers.has("x-opengrove-evidence-complete")
        ? response.headers.get("x-opengrove-evidence-complete") === "true"
        : undefined,
    };
  } catch (error) {
    if (error instanceof BridgeDownloadError) throw error;
    if (controller.signal.aborted) {
      throw new BridgeDownloadError("timeout", "download_timeout");
    }
    throw new BridgeDownloadError("network", "download_network_error");
  }
}

function downloadFileName(contentDisposition: string | null): string | undefined {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i);
  const candidate = match?.[1]?.trim();
  return candidate && /^[a-zA-Z0-9._-]+$/.test(candidate) ? candidate : undefined;
}

async function readDownloadResponseBlob(
  response: Response,
  noProgressTimeoutMs: number,
  controller: AbortController,
): Promise<Blob> {
  if (!response.body) {
    return withDownloadNoProgressTimeout(response.blob(), noProgressTimeoutMs, controller);
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  try {
    while (true) {
      const { done, value } = await withDownloadNoProgressTimeout(reader.read(), noProgressTimeoutMs, controller);
      if (done) break;
      if (value?.byteLength) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get("content-type") || undefined });
}

function withDownloadNoProgressTimeout<T>(
  operation: Promise<T>,
  noProgressTimeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BridgeDownloadError("timeout", "download_timeout"));
      controller.abort();
    }, noProgressTimeoutMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function downloadRequest(url: string): { url: string; authenticated: boolean } {
  const base = globalThis.location?.href || "http://localhost/";
  const target = new URL(url, base);
  const bridge = new URL(apiUrl("/"), base);
  return {
    url: target.href,
    authenticated: (target.protocol === "http:" || target.protocol === "https:") && target.origin === bridge.origin,
  };
}

function isDownloadAuthFailure(status: number, error: string): boolean {
  return status === 401 || status === 403 || ["session_required", "not_authenticated", "unauthorized"].includes(error);
}

export async function getAppStoreCatalog(): Promise<AppStoreResponse> {
  return getJson<AppStoreResponse>("/app-store");
}

export async function installAppStorePackage(payload: {
  packageId: string;
  backupEnabled?: boolean;
  cleanupUnverifiedRoot?: boolean;
}): Promise<AppStoreInstallResponse> {
  return postJson<AppStoreInstallResponse>("/app-store/install", payload);
}

export async function repairAppStorePackage(payload: { packageId: string }): Promise<AppStoreRepairResponse> {
  return postJson<AppStoreRepairResponse>("/app-store/repair", payload);
}

export async function uninstallMountedApp(payload: {
  appId: string;
  allowUnverifiedTrash?: boolean;
  deleteLocalDraft?: boolean;
}): Promise<AppStoreUninstallResponse> {
  return postJson<AppStoreUninstallResponse>("/app-store/uninstall", payload);
}

export async function getMountedAppLocalDraft(appId: string): Promise<LocalAppDraftResponse> {
  return getJson<LocalAppDraftResponse>(`/apps/${encodeURIComponent(appId)}/draft`);
}

export async function prepareMountedAppLocalDraft(appId: string): Promise<AppStorePrepareReleaseResponse> {
  return getJson<AppStorePrepareReleaseResponse>(`/apps/${encodeURIComponent(appId)}/draft/prepare`);
}

export async function saveMountedAppLocalDraft(
  appId: string,
  candidate?: Pick<MountedAppReleaseDraft, "app" | "employees">,
): Promise<LocalAppDraftResponse> {
  return fetchJson<LocalAppDraftResponse>(`/apps/${encodeURIComponent(appId)}/draft`, {
    method: "PUT",
    headers: bridgeHeaders(),
    body: JSON.stringify(
      candidate
        ? {
            app: {
              ...candidate.app,
              icon: candidate.app.icon ?? "",
            },
            employees: candidate.employees,
          }
        : {},
    ),
  });
}

export async function openMountedAppLocalDraft(appId: string): Promise<LocalAppDraftResponse> {
  return postJson<LocalAppDraftResponse>(`/apps/${encodeURIComponent(appId)}/draft/open`, {});
}

export async function getMountedAppVersions(appId: string): Promise<MountedAppVersionsResponse> {
  return getJson<MountedAppVersionsResponse>(`/apps/${encodeURIComponent(appId)}/versions`);
}

export async function switchMountedAppVersion(
  appId: string,
  target:
    | {
        kind: "formal";
        version: string;
        archiveSha256: string;
      }
    | {
        kind: "local-draft";
      },
  options: {
    discardUnsavedChanges?: boolean;
    forceStop?: boolean;
  } = {},
): Promise<MountedAppVersionSwitchResponse> {
  return postJson<MountedAppVersionSwitchResponse>(`/apps/${encodeURIComponent(appId)}/versions/switch`, {
    target,
    discardUnsavedChanges: options.discardUnsavedChanges === true,
    forceStop: options.forceStop === true,
  });
}

export async function relinkAppStorePackage(payload: { packageId: string }): Promise<AppStoreRelinkResponse> {
  return postJson<AppStoreRelinkResponse>("/app-store/relink", payload);
}

export async function prepareMountedAppPublish(appId: string): Promise<AppStorePrepareReleaseResponse> {
  return getJson<AppStorePrepareReleaseResponse>(`/apps/${encodeURIComponent(appId)}/publish/prepare`);
}

export async function getMountedAppPublishProgress(appId: string): Promise<MountedAppPublishResponse> {
  return getJson<MountedAppPublishResponse>(`/apps/${encodeURIComponent(appId)}/publish`);
}

export async function refreshMountedAppPublishProgress(appId: string): Promise<MountedAppPublishResponse> {
  return getJson<MountedAppPublishResponse>(`/apps/${encodeURIComponent(appId)}/publish/status`);
}

export async function repairMountedAppBuildContract(appId: string): Promise<{ ok: boolean; error?: string }> {
  return postJson<{ ok: boolean; error?: string }>(`/apps/${encodeURIComponent(appId)}/publish/build-contract`, {});
}

export async function publishMountedApp(
  appId: string,
  release: MountedAppReleaseDraft,
  options: { applyToCurrentApp?: boolean } = {},
): Promise<MountedAppPublishResponse> {
  return postJson<MountedAppPublishResponse>(`/apps/${encodeURIComponent(appId)}/publish`, {
    applyToCurrentApp: options.applyToCurrentApp === true,
    release: {
      app: release.app,
      version: release.version,
      releaseNotes: release.releaseNotes,
      visibility: release.visibility,
      employees: release.employees,
    },
  });
}

export async function reconcileMountedAppPublish(
  appId: string,
  options: { retryFailedBuild?: boolean } = {},
): Promise<MountedAppPublishResponse> {
  return postJson<MountedAppPublishResponse>(`/apps/${encodeURIComponent(appId)}/publish/reconcile`, {
    retryFailedBuild: options.retryFailedBuild === true,
  });
}

export async function keepLocalChangesAfterMountedAppPublish(appId: string): Promise<MountedAppPublishResponse> {
  return postJson<MountedAppPublishResponse>(`/apps/${encodeURIComponent(appId)}/publish/keep-local`, {});
}

export async function abandonMountedAppPublish(appId: string): Promise<MountedAppPublishResponse> {
  return postJson<MountedAppPublishResponse>(`/apps/${encodeURIComponent(appId)}/publish/abandon`, {});
}

export async function getMountedAppIdentity(appId: string): Promise<MountedAppIdentityResponse> {
  return fetchJson<MountedAppIdentityResponse>(`/apps/${encodeURIComponent(appId)}/identity`);
}

export async function updateMountedAppIdentity(
  appId: string,
  identity: { title: string; description: string; icon?: string },
): Promise<MountedAppIdentityResponse> {
  return patchJson<MountedAppIdentityResponse>(`/apps/${encodeURIComponent(appId)}/identity`, identity);
}

export async function publishRegistryAppStorePackage(
  file: File,
  visibility?: AppStorePackageVisibility,
): Promise<AppStoreUploadResponse> {
  const params = new URLSearchParams({
    fileName: file.name,
  });
  if (visibility) params.set("visibility", visibility);
  return fetchJson<AppStoreUploadResponse>(`/app-store/publish-registry?${params.toString()}`, {
    method: "POST",
    headers: {
      ...bridgeHeaders(false),
      "content-type": "application/vnd.opengrove.app-package",
    },
    body: file,
  });
}

export async function publishEmployeeToAppStore(payload: {
  memberId: string;
  title?: string;
  summary?: string;
  category?: string;
}): Promise<AppStoreUploadResponse> {
  return postJson<AppStoreUploadResponse>("/app-store/publish-employee", payload);
}

export async function sendBridgeEmailCode(payload: { email: string }): Promise<{
  ok: boolean;
  requiresInvite?: boolean;
  requiresCountry?: boolean;
}> {
  const response = await fetch(apiUrl("/auth/email-codes"), {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: bridgeHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const details = await readBridgeErrorDetails(response);
    const headerRetryAfter = Number(response.headers.get("Retry-After"));
    const authError = new BridgeAuthError(details.error);
    authError.code = details.code;
    authError.retryAfter = details.retryAfter ?? (Number.isFinite(headerRetryAfter) ? headerRetryAfter : undefined);
    authError.requestId = details.requestId;
    authError.incidentId = details.incidentId;
    authError.traceId = details.traceId;
    throw authError;
  }
  return (await response.json()) as { ok: boolean; requiresInvite?: boolean; requiresCountry?: boolean };
}

export async function loginBridgeAuth(payload: {
  email: string;
  code: string;
  inviteCode?: string;
  countryCode?: string;
  deviceName?: string;
  platform?: string;
  languagePreference: LanguagePreference;
  systemLanguage: ResolvedLanguage;
}): Promise<BridgeAuthResponse> {
  return postJson<BridgeAuthResponse>("/auth/login", payload);
}

export async function logoutBridgeAuth(): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>("/auth/logout", {});
}

export async function patchJson<T>(path: string, payload: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "PATCH",
    headers: bridgeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function deleteJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, {
    method: "DELETE",
    headers: bridgeHeaders(false),
  });
}

export async function listMountedAppFiles(appId: string, afterRevision?: string): Promise<MountedAppFilesResponse> {
  const params = new URLSearchParams();
  if (afterRevision) params.set("afterRevision", afterRevision);
  const query = params.toString();
  return getJson<MountedAppFilesResponse>(`/apps/${encodeURIComponent(appId)}/files${query ? `?${query}` : ""}`);
}

export async function listMountedAppFlows(appId: string, afterRevision?: string): Promise<MountedAppFlowsResponse> {
  const params = new URLSearchParams();
  if (afterRevision) params.set("afterRevision", afterRevision);
  const query = params.toString();
  return getJson<MountedAppFlowsResponse>(`/apps/${encodeURIComponent(appId)}/flows${query ? `?${query}` : ""}`);
}

export async function getMountedAppDashboard(
  appId: string,
  options: { dashboardIndex?: number } = {},
): Promise<MountedAppDashboardResponse> {
  const suffix = dashboardQuerySuffix(options);
  return getJson<MountedAppDashboardResponse>(`/apps/${encodeURIComponent(appId)}/dashboard${suffix}`);
}

export async function refreshMountedAppDashboard(
  appId: string,
  options: { dashboardIndex?: number } = {},
): Promise<MountedAppDashboardResponse> {
  const suffix = dashboardQuerySuffix(options);
  return postJson<MountedAppDashboardResponse>(`/apps/${encodeURIComponent(appId)}/dashboard/refresh${suffix}`, {});
}

function dashboardQuerySuffix(options: { dashboardIndex?: number }): string {
  const params = new URLSearchParams();
  if (options.dashboardIndex) params.set("tab", String(options.dashboardIndex));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function getMountedAppFile(
  appId: string,
  path: string,
  afterRevision?: string,
): Promise<MountedAppFileResponse> {
  const params = new URLSearchParams({ path });
  if (afterRevision) params.set("afterRevision", afterRevision);
  return getJson<MountedAppFileResponse>(`/apps/${encodeURIComponent(appId)}/file?${params.toString()}`);
}

export async function createMountedAppFileSystemEntry(
  appId: string,
  payload: {
    kind: "file" | "folder";
    parentPath: string;
    name: string;
    content?: string;
  },
): Promise<MountedAppFileSystemResponse> {
  return postJson<MountedAppFileSystemResponse>(`/apps/${encodeURIComponent(appId)}/file-system`, payload);
}

export async function moveMountedAppFileSystemEntry(
  appId: string,
  payload: {
    sourcePath: string;
    targetParentPath: string;
  },
): Promise<MountedAppFileSystemResponse> {
  return postJson<MountedAppFileSystemResponse>(`/apps/${encodeURIComponent(appId)}/file-system/move`, payload);
}

export async function renameMountedAppFileSystemEntry(
  appId: string,
  payload: {
    sourcePath: string;
    name: string;
  },
): Promise<MountedAppFileSystemResponse> {
  return postJson<MountedAppFileSystemResponse>(`/apps/${encodeURIComponent(appId)}/file-system/rename`, payload);
}

export async function deleteMountedAppFileSystemEntry(
  appId: string,
  payload: {
    sourcePath: string;
  },
): Promise<MountedAppFileSystemResponse> {
  return postJson<MountedAppFileSystemResponse>(`/apps/${encodeURIComponent(appId)}/file-system/delete`, payload);
}

export async function importMountedAppLocalFiles(
  appId: string,
  payload: {
    parentPath: string;
  },
): Promise<MountedAppFileSystemResponse> {
  return postJson<MountedAppFileSystemResponse>(
    `/apps/${encodeURIComponent(appId)}/file-system/import-local-files`,
    payload,
  );
}

export async function openMountedAppLocalFile(
  appId: string,
  payload: {
    path: string;
    target?: "finder" | "system";
  },
): Promise<{ ok: boolean; target?: string; error?: string }> {
  return postJson<{ ok: boolean; target?: string; error?: string }>(
    `/apps/${encodeURIComponent(appId)}/file-system/open-local`,
    payload,
  );
}

export async function putMountedAppRawFile(
  appId: string,
  path: string,
  body: BodyInit,
  options: { contentType?: string; unique?: boolean } = {},
): Promise<MountedAppFileSystemResponse> {
  const params = new URLSearchParams({ path });
  if (options.unique) params.set("unique", "1");
  const headers = bridgeHeaders(false) as Record<string, string>;
  if (options.contentType) {
    headers["content-type"] = options.contentType;
  }
  const response = await fetch(apiUrl(`/apps/${encodeURIComponent(appId)}/raw?${params.toString()}`), {
    method: "PUT",
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(await readBridgeError(response));
  }
  return (await response.json()) as MountedAppFileSystemResponse;
}

export async function transcribeVoiceAudio(payload: {
  audioBase64: string;
  mimeType?: string;
  filename?: string;
  language?: string;
  provider?: VoiceSttProviderId;
  sessionId?: string;
}): Promise<VoiceTranscriptionResponse> {
  return postJson<VoiceTranscriptionResponse>("/voice/transcriptions", payload);
}

export async function runAskStream(
  payload: {
    question: string;
    model: string;
    kernel?: string;
    providerId?: string;
    effort?: ReasoningEffort;
    responseSpeed?: ResponseSpeed;
    budgetLimitUsd?: number;
    accessMode?: RuntimeAccessMode;
    planMode?: boolean;
    goalMode?: boolean;
    threadId: string;
    appId?: string;
    snapshot: unknown;
    computerSnapshot: unknown;
    allowMemory: boolean;
    saveCandidateNote: boolean;
    requestedSkill?: {
      name: string;
      args?: string;
    };
  },
  onChunk: (chunk: BridgeStreamChunk) => void,
  options: { signal?: AbortSignal } = {},
): Promise<AskFinalPayload> {
  const response = await fetch(apiUrl("/ask/stream"), {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return readAskStreamResponse(response, onChunk);
}

export async function attachAskStream(
  query: { runId?: string; threadId?: string },
  onChunk: (chunk: BridgeStreamChunk) => void,
  options: { signal?: AbortSignal } = {},
): Promise<AskFinalPayload> {
  const params = new URLSearchParams();
  if (query.runId) params.set("runId", query.runId);
  if (query.threadId) params.set("threadId", query.threadId);
  const response = await fetch(apiUrl(`/ask/stream?${params.toString()}`), {
    method: "GET",
    headers: bridgeHeaders(),
    signal: options.signal,
  });
  return readAskStreamResponse(response, onChunk);
}

export async function cancelAskStream(query: {
  runId?: string;
  threadId?: string;
}): Promise<{ ok: boolean; cancelled: boolean }> {
  return postContractJson(askCancelContract, "/ask/cancel", query);
}

export async function guideAskStream(payload: {
  runId?: string;
  threadId?: string;
  instruction: string;
}): Promise<{ ok: boolean; guided: boolean; error?: string }> {
  return postContractJson(askGuideContract, "/ask/guide", payload);
}

export async function compactAskSession(payload: {
  threadId: string;
  reason?: string;
}): Promise<{ ok: boolean; compacted: boolean; error?: string }> {
  return postContractJson(askCompactContract, "/ask/compact", payload);
}

async function readAskStreamResponse(
  response: Response,
  onChunk: (chunk: BridgeStreamChunk) => void,
): Promise<AskFinalPayload> {
  if (!response.ok) {
    throw new Error(await readBridgeError(response));
  }
  if (!response.body) {
    throw new Error("stream_unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalData: AskFinalPayload | null = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const chunk = parseBridgeStreamChunk(line);
        onChunk(chunk);
        if (chunk.type === "final") {
          finalData = chunk.data as AskFinalPayload;
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    const chunk = parseBridgeStreamChunk(buffer.trim());
    onChunk(chunk);
    if (chunk.type === "final") {
      finalData = chunk.data as AskFinalPayload;
    }
  }

  if (!finalData) {
    throw new Error("stream_finished_without_final_payload");
  }
  return finalData;
}

export function parseBridgeStreamChunk(line: string): BridgeStreamChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error("bridge_stream_malformed_json", { cause: error });
  }
  if (!isBridgeRecordLike(parsed) || typeof parsed.type !== "string") {
    throw new Error("bridge_stream_invalid_chunk");
  }
  if (parsed.type === "event" && !isBridgeRecordLike(parsed.event)) {
    throw new Error("bridge_stream_invalid_event");
  }
  if (parsed.type === "final" && !isBridgeRecordLike(parsed.data)) {
    throw new Error("bridge_stream_invalid_final");
  }
  if (parsed.type === "fatal" && typeof parsed.error !== "string") {
    throw new Error("bridge_stream_invalid_fatal");
  }
  if (parsed.type !== "start" && parsed.type !== "event" && parsed.type !== "final" && parsed.type !== "fatal") {
    throw new Error(`bridge_stream_unknown_chunk:${parsed.type}`);
  }
  return parsed;
}
