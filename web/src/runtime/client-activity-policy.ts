export interface ClientActivityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DesktopVersionSource {
  versions?: {
    app?: string;
    clientReleaseNumber?: number;
  };
}

export interface DesktopClientActivityReport {
  clientVersion: string;
  clientReleaseNumber?: number;
}

export interface ClientActivityDocumentState {
  visibilityState: string;
  hasFocus(): boolean;
}

export function utcActivityDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function claimDailyClientActivityAttemptForKey(
  storage: ClientActivityStorage,
  storageKeyPrefix: string,
  userId: string,
  now = new Date(),
): boolean {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId || !storageKeyPrefix) return false;
  const key = `${storageKeyPrefix}:${encodeURIComponent(normalizedUserId)}`;
  const day = utcActivityDay(now);
  try {
    if (storage.getItem(key) === day) return false;
    // Claim before the network request. A failed optional metric is cheaper and
    // safer than repeatedly retrying whenever the user focuses the window.
    storage.setItem(key, day);
    return true;
  } catch {
    // Without durable deduplication, fail closed instead of creating an
    // accidental per-focus activity endpoint.
    return false;
  }
}

export function desktopClientActivityReport(
  desktopApi: DesktopVersionSource | undefined,
): DesktopClientActivityReport | undefined {
  const clientVersion = desktopApi?.versions?.app?.trim();
  if (!clientVersion) return undefined;
  const releaseNumber = desktopApi?.versions?.clientReleaseNumber;
  return {
    clientVersion,
    ...(typeof releaseNumber === "number" && Number.isSafeInteger(releaseNumber) && releaseNumber > 0
      ? { clientReleaseNumber: releaseNumber }
      : {}),
  };
}

export function desktopClientActivityWindowIsForeground(documentState: ClientActivityDocumentState): boolean {
  return documentState.visibilityState === "visible" && documentState.hasFocus();
}

export function millisecondsUntilNextUtcDay(now = new Date()): number {
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1_000, nextDay - now.getTime() + 1_000);
}
