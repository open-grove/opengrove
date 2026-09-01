import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KernelCapabilityId, KernelContractTestEvidence } from "./types.js";
import { STANDARD_KERNEL_CAPABILITY_IDS } from "./types.js";

export const REAL_RUNTIME_EVIDENCE_PATH = "data/kernel-capability-real-runtime-evidence.json";

export type KernelRuntimeProbeStatus = "passed" | "failed" | "skipped";

export interface KernelRuntimeProbeEventSummary {
  turnStarted: boolean;
  turnFinished: boolean;
  turnStartedCount?: number;
  turnFinishedCount?: number;
  assistantDelta: boolean;
  assistantDeltaCount?: number;
  modelResponse: boolean;
  modelResponseCount?: number;
  lifecycleClosedExactlyOnce?: boolean;
  assistantDeltaBeforeResponse?: boolean;
  modelResponseBeforeTurnFinished?: boolean;
  assistantTextMatchesResponse?: boolean;
  assistantTextLength?: number;
  responseTextLength?: number;
  assistantTextTrimmedMatchesResponse?: boolean;
  assistantTextCommonPrefixLength?: number;
  planningUpdated: boolean;
  questionRequested: boolean;
  questionAnswered: boolean;
  toolStarted: boolean;
  toolProgress?: boolean;
  toolProgressCorrelated?: boolean;
  toolFinished: boolean;
  approvalRequested: boolean;
  approvalResolved: boolean;
  error: boolean;
  compactionStarted?: boolean;
  compactionFinished?: boolean;
  runtimeDiagnostic?: boolean;
  modelUsage?: boolean;
  usageDiagnostic?: boolean;
  reasoningDiagnostic?: boolean;
  reasoningNativeText?: boolean;
  reasoningSummary?: boolean;
  sessionTrace?: boolean;
  nativeToolStarted?: boolean;
  nativeToolFinished?: boolean;
  artifactResult?: boolean;
  authRefreshRequested?: boolean;
  sandboxPolicyConfigured?: boolean;
  budgetLimitConfigured?: boolean;
  budgetLimitUsd?: number;
  responseSpeedConfigured?: boolean;
  responseSpeed?: string;
  serviceTier?: string;
  mediaInputConfigured?: boolean;
  imageInputCount?: number;
  mentionInputCount?: number;
  structuredOutputConfigured?: boolean;
  steerAttempted?: boolean;
  steerAccepted?: boolean;
  steerError?: string;
  compactAttempted?: boolean;
  compactAccepted?: boolean;
  compactError?: string;
  goalConfigured?: boolean;
  goalStatus?: string;
  toolIds?: string[];
  diagnosticNames?: string[];
  codexServerRequestMethods?: string[];
  sandboxPolicies?: string[];
  approvalPolicies?: string[];
}

export interface KernelRuntimeProbeRecord {
  id: string;
  kernel: string;
  capability: KernelCapabilityId;
  testId: string;
  status: KernelRuntimeProbeStatus;
  verification: "real_runtime";
  checkedAt: string;
  hostVersion?: string;
  kernelVersion?: string;
  runtimeMode?: string;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  marker?: string;
  provider?: {
    kind: "native" | "openai-compatible" | "anthropic-compatible" | "gemini-compatible" | "unknown";
    baseUrl?: string;
    model?: string;
  };
  command?: string;
  events?: KernelRuntimeProbeEventSummary;
  responsePreview?: string;
  reason?: string;
  error?: string;
}

export interface KernelRealRuntimeEvidenceFile {
  schemaVersion: 1;
  generatedAt: string;
  source: "kernel-capability-real-runtime-probe-runner";
  probes: KernelRuntimeProbeRecord[];
  contractTests: KernelContractTestEvidence[];
}

const CAPABILITY_IDS = new Set<string>(STANDARD_KERNEL_CAPABILITY_IDS);

export function readRealRuntimeKernelContractTests(
  path = resolve(process.cwd(), REAL_RUNTIME_EVIDENCE_PATH),
): KernelContractTestEvidence[] {
  const file = readRealRuntimeEvidenceFile(path);
  if (!file) return [];
  return file.contractTests.filter(isCertifiedRealRuntimeEvidence);
}

export function readRealRuntimeEvidenceFile(
  path = resolve(process.cwd(), REAL_RUNTIME_EVIDENCE_PATH),
): KernelRealRuntimeEvidenceFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isJsonObject(parsed)) return undefined;
    if (parsed.schemaVersion !== 1) return undefined;
    if (parsed.source !== "kernel-capability-real-runtime-probe-runner") return undefined;
    const contractTests = Array.isArray(parsed.contractTests)
      ? parsed.contractTests.filter(isCertifiedRealRuntimeEvidence)
      : [];
    const probes = Array.isArray(parsed.probes) ? parsed.probes.filter(isProbeRecord) : [];
    return {
      schemaVersion: 1,
      generatedAt: readString(parsed.generatedAt) ?? "",
      source: "kernel-capability-real-runtime-probe-runner",
      probes,
      contractTests,
    };
  } catch {
    return undefined;
  }
}

function isCertifiedRealRuntimeEvidence(value: unknown): value is KernelContractTestEvidence {
  if (!isJsonObject(value)) return false;
  return (
    readString(value.kernel) !== undefined &&
    readCapability(value.capability) !== undefined &&
    readString(value.testId) !== undefined &&
    value.passed === true &&
    readString(value.checkedAt) !== undefined &&
    value.verification === "real_runtime"
  );
}

function isProbeRecord(value: unknown): value is KernelRuntimeProbeRecord {
  if (!isJsonObject(value)) return false;
  const status = readString(value.status);
  return (
    readString(value.id) !== undefined &&
    readString(value.kernel) !== undefined &&
    readCapability(value.capability) !== undefined &&
    readString(value.testId) !== undefined &&
    (status === "passed" || status === "failed" || status === "skipped") &&
    value.verification === "real_runtime" &&
    readString(value.checkedAt) !== undefined
  );
}

function readCapability(value: unknown): KernelCapabilityId | undefined {
  return typeof value === "string" && CAPABILITY_IDS.has(value) ? (value as KernelCapabilityId) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
