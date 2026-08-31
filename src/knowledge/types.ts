import type { JsonObject, SourceRef } from "../core.js";

export type KnowledgeDocumentType =
  | "skill"
  | "memory"
  | "note"
  | "project_doc"
  | "artifact_ref"
  | "routine"
  | "profile"
  | "source";

export type KnowledgeFormat = "markdown" | "json" | "plain";
export type KnowledgeScope = "global" | "project" | "workspace" | "session" | "user" | "page";
export type KnowledgeLifecycle = "draft" | "active" | "archived";
export type KnowledgeEvidenceKind =
  | "user_assertion"
  | "tool_observation"
  | "artifact_asset"
  | "skill_manifest"
  | "runtime_event"
  | "external_source"
  | "system";
export type KnowledgeRevisionOperation = "create" | "update" | "archive" | "delete" | "sync";
export type KnowledgeDeliveryMode =
  | "prompt_snippet"
  | "skill_tool_hint"
  | "native_skill"
  | "loaded_skill"
  | "artifact_handle"
  | "suppressed_duplicate";
export type KnowledgeFeedbackSignal = "useful" | "ignored" | "corrected" | "stale" | "promoted" | "demoted";

export interface KnowledgeLink {
  targetId: string;
  relation: string;
  title?: string;
}

export interface KnowledgeDocument {
  id: string;
  slug: string;
  type: KnowledgeDocumentType;
  title: string;
  body: string;
  format: KnowledgeFormat;
  tags: string[];
  links: KnowledgeLink[];
  backlinks: KnowledgeLink[];
  sourceRefs: SourceRef[];
  scope: KnowledgeScope;
  confidence?: number;
  lifecycle: KnowledgeLifecycle;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export type KnowledgeObject = KnowledgeDocument;

export interface KnowledgeDocumentInput {
  id?: string;
  slug?: string;
  type: KnowledgeDocumentType;
  title: string;
  body: string;
  format?: KnowledgeFormat;
  tags?: string[];
  links?: KnowledgeLink[];
  sourceRefs?: SourceRef[];
  scope?: KnowledgeScope;
  confidence?: number;
  lifecycle?: KnowledgeLifecycle;
  metadata?: JsonObject;
}

export interface KnowledgeDocumentPatch {
  slug?: string;
  type?: KnowledgeDocumentType;
  title?: string;
  body?: string;
  format?: KnowledgeFormat;
  tags?: string[];
  links?: KnowledgeLink[];
  sourceRefs?: SourceRef[];
  scope?: KnowledgeScope;
  confidence?: number;
  lifecycle?: KnowledgeLifecycle;
  metadata?: JsonObject;
}

export interface KnowledgeFilter {
  ids?: string[];
  type?: KnowledgeDocumentType;
  types?: KnowledgeDocumentType[];
  tags?: string[];
  scope?: KnowledgeScope;
  lifecycle?: KnowledgeLifecycle;
  limit?: number;
}

export interface KnowledgeSearchOptions extends KnowledgeFilter {
  query?: string;
}

export interface KnowledgeEvidenceRecord {
  id: string;
  knowledgeId: string;
  kind: KnowledgeEvidenceKind;
  summary: string;
  sourceRefs: SourceRef[];
  confidence?: number;
  observedAt?: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface KnowledgeEvidenceInput {
  id?: string;
  knowledgeId: string;
  kind: KnowledgeEvidenceKind;
  summary: string;
  sourceRefs?: SourceRef[];
  confidence?: number;
  observedAt?: string;
  metadata?: JsonObject;
}

export interface KnowledgeRevision {
  id: string;
  knowledgeId: string;
  operation: KnowledgeRevisionOperation;
  title: string;
  bodyPreview: string;
  evidenceIds: string[];
  createdAt: string;
  metadata: JsonObject;
}

export interface KnowledgeRevisionInput {
  id?: string;
  knowledgeId: string;
  operation: KnowledgeRevisionOperation;
  title: string;
  bodyPreview?: string;
  evidenceIds?: string[];
  metadata?: JsonObject;
}

export interface KnowledgeDeliveryDecision {
  knowledgeId: string;
  knowledgeType: KnowledgeDocumentType;
  title: string;
  mode: KnowledgeDeliveryMode;
  reason: string;
  score: number;
  includeInPrompt: boolean;
  contextItemId?: string;
  characterCount?: number;
  metadata: JsonObject;
}

export interface ContextDeliveryPlan {
  id: string;
  runId?: string;
  sessionId?: string;
  kernelId?: string;
  createdAt: string;
  query: string;
  decisions: KnowledgeDeliveryDecision[];
  metadata: JsonObject;
}

export interface KnowledgeDeliveryRecord extends KnowledgeDeliveryDecision {
  id: string;
  planId: string;
  runId?: string;
  sessionId?: string;
  kernelId?: string;
  createdAt: string;
}

export interface KnowledgeFeedbackEvent {
  id: string;
  knowledgeId: string;
  deliveryId?: string;
  runId?: string;
  signal: KnowledgeFeedbackSignal;
  scoreDelta?: number;
  note?: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface KnowledgeFeedbackInput {
  id?: string;
  knowledgeId: string;
  deliveryId?: string;
  runId?: string;
  signal: KnowledgeFeedbackSignal;
  scoreDelta?: number;
  note?: string;
  metadata?: JsonObject;
}

export interface KnowledgeLedgerSnapshot {
  evidence: KnowledgeEvidenceRecord[];
  revisions: KnowledgeRevision[];
  deliveries: KnowledgeDeliveryRecord[];
  feedback: KnowledgeFeedbackEvent[];
}

export interface KnowledgeStoreSnapshot extends KnowledgeLedgerSnapshot {
  documents: KnowledgeDocument[];
}
