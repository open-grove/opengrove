import { APP_STORAGE_KEYS } from "../identity";

export type DirectKernelChatSelection = {
  kernel?: string;
  providerId?: string;
};

type StoredDirectKernelChatRuntime = {
  last?: DirectKernelChatSelection;
  threads?: Record<string, DirectKernelChatSelection>;
};

export function readDirectKernelChatSelection(threadId: string): DirectKernelChatSelection {
  const stored = readStoredRuntime();
  return stored.threads?.[threadId] ?? stored.last ?? {};
}

export function writeDirectKernelChatSelection(threadId: string, selection: DirectKernelChatSelection): void {
  if (typeof window === "undefined") return;
  const stored = readStoredRuntime();
  const next = compactSelection(selection);
  try {
    window.localStorage.setItem(
      APP_STORAGE_KEYS.directKernelChatRuntime,
      JSON.stringify({
        last: next,
        threads: {
          ...(stored.threads ?? {}),
          [threadId]: next,
        },
      } satisfies StoredDirectKernelChatRuntime),
    );
  } catch {
    // The runtime choice is a convenience preference. A blocked localStorage
    // must never prevent the conversation itself from working.
  }
}

function readStoredRuntime(): StoredDirectKernelChatRuntime {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(APP_STORAGE_KEYS.directKernelChatRuntime) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as StoredDirectKernelChatRuntime;
    return {
      last: normalizeSelection(record.last),
      threads: normalizeThreads(record.threads),
    };
  } catch {
    return {};
  }
}

function normalizeThreads(value: unknown): Record<string, DirectKernelChatSelection> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([threadId, selection]) => [threadId, normalizeSelection(selection)] as const)
    .filter((entry): entry is readonly [string, DirectKernelChatSelection] => Boolean(entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeSelection(value: unknown): DirectKernelChatSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kernel = typeof record.kernel === "string" ? record.kernel.trim() : "";
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  return compactSelection({
    ...(kernel ? { kernel } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "providerId") ? { providerId } : {}),
  });
}

function compactSelection(selection: DirectKernelChatSelection): DirectKernelChatSelection {
  const kernel = selection.kernel?.trim();
  const providerId = selection.providerId?.trim();
  return {
    ...(kernel ? { kernel } : {}),
    ...(selection.providerId !== undefined ? { providerId: providerId ?? "" } : {}),
  };
}
