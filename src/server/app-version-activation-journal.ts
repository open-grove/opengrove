import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type PersistedAgentState } from "../storage/json-state-store.js";
import type { BridgeMountedAppSettings } from "./bridge-types.js";
import type { MountedAppVersionState } from "./app-version-state.js";
import { writePrivateFileAtomically } from "../storage/private-file.js";
import { normalizeActivationJournalAgentState } from "./app-version-activation-journal.compat.js";

const APP_VERSION_ACTIVATION_JOURNAL_SCHEMA_VERSION = 1;

export interface AppVersionActivationJournalRecord {
  schemaVersion: 1;
  phase: "activating" | "committed";
  kind: "formal" | "local-draft";
  localAppId: string;
  appRoot: string;
  previousMountedApps: BridgeMountedAppSettings[];
  previousUninstalledStoreAppIds: string[];
  previousAgentState: PersistedAgentState;
  previousVersionState?: MountedAppVersionState;
}

export interface AppVersionActivationJournal {
  path: string;
  record: AppVersionActivationJournalRecord;
}

export interface AppVersionActivationJournalReadFailure {
  path: string;
  journalKey?: string;
  error: string;
}

export interface AppVersionActivationJournalScan {
  journals: AppVersionActivationJournal[];
  failures: AppVersionActivationJournalReadFailure[];
}

export function appVersionActivationJournalRoot(appStoreRoot: string): string {
  return join(appStoreRoot, "version-activation-recovery");
}

export function appVersionActivationJournalKey(localAppId: string): string {
  return createHash("sha256").update(localAppId, "utf8").digest("hex");
}

export function beginAppVersionActivationJournal(input: {
  root: string;
  kind: AppVersionActivationJournalRecord["kind"];
  localAppId: string;
  appRoot: string;
  previousMountedApps: BridgeMountedAppSettings[];
  previousUninstalledStoreAppIds: string[];
  previousAgentState: PersistedAgentState;
  previousVersionState?: MountedAppVersionState;
}): AppVersionActivationJournal {
  const existing = listAppVersionActivationJournals(input.root);
  if (existing.length) throw new Error("app_version_activation_busy");
  mkdirSync(input.root, { recursive: true });
  const path = join(input.root, `${appVersionActivationJournalKey(input.localAppId)}.json`);
  const record: AppVersionActivationJournalRecord = {
    schemaVersion: APP_VERSION_ACTIVATION_JOURNAL_SCHEMA_VERSION,
    phase: "activating",
    kind: input.kind,
    localAppId: input.localAppId,
    appRoot: resolve(input.appRoot),
    previousMountedApps: structuredClone(input.previousMountedApps),
    previousUninstalledStoreAppIds: [...input.previousUninstalledStoreAppIds],
    previousAgentState: structuredClone(input.previousAgentState),
    ...(input.previousVersionState ? { previousVersionState: structuredClone(input.previousVersionState) } : {}),
  };
  writeJournal(path, record);
  return { path, record: structuredClone(record) };
}

export function commitAppVersionActivationJournal(journal: AppVersionActivationJournal): AppVersionActivationJournal {
  const record: AppVersionActivationJournalRecord = {
    ...journal.record,
    phase: "committed",
  };
  writeJournal(journal.path, record);
  return { path: journal.path, record: structuredClone(record) };
}

export function removeAppVersionActivationJournal(journal: AppVersionActivationJournal): void {
  rmSync(journal.path, { force: true });
}

export function listAppVersionActivationJournals(root: string): AppVersionActivationJournal[] {
  const scan = scanAppVersionActivationJournals(root);
  if (scan.failures.length) throw new Error(scan.failures[0]!.error);
  return scan.journals;
}

export function scanAppVersionActivationJournals(root: string): AppVersionActivationJournalScan {
  if (!existsSync(root)) return { journals: [], failures: [] };
  const journals: AppVersionActivationJournal[] = [];
  const failures: AppVersionActivationJournalReadFailure[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"),
  )) {
    const path = join(root, entry.name);
    try {
      journals.push({ path, record: readJournal(path) });
    } catch (error) {
      failures.push({
        path,
        ...(/^[a-f0-9]{64}\.json$/.test(entry.name) ? { journalKey: entry.name.slice(0, -".json".length) } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { journals, failures };
}

function readJournal(path: string): AppVersionActivationJournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("app_version_activation_journal_corrupted");
  }
  if (!isJournalRecord(value)) {
    throw new Error("app_version_activation_journal_corrupted");
  }
  return {
    ...structuredClone(value),
    previousAgentState: normalizeActivationJournalAgentState(value.previousAgentState),
  };
}

function writeJournal(path: string, record: AppVersionActivationJournalRecord): void {
  writePrivateFileAtomically(path, `${JSON.stringify(record)}\n`);
}

function isJournalRecord(value: unknown): value is AppVersionActivationJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AppVersionActivationJournalRecord>;
  return (
    record.schemaVersion === APP_VERSION_ACTIVATION_JOURNAL_SCHEMA_VERSION &&
    (record.phase === "activating" || record.phase === "committed") &&
    (record.kind === "formal" || record.kind === "local-draft") &&
    typeof record.localAppId === "string" &&
    Boolean(record.localAppId) &&
    typeof record.appRoot === "string" &&
    Boolean(record.appRoot) &&
    Array.isArray(record.previousMountedApps) &&
    Array.isArray(record.previousUninstalledStoreAppIds) &&
    Boolean(record.previousAgentState) &&
    typeof record.previousAgentState === "object"
  );
}
