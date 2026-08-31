import type { JsonObject, SourceRef } from "../core.js";
import type { KnowledgeStore } from "./store.js";
import type {
  KnowledgeDocument,
  KnowledgeDocumentInput,
  KnowledgeDocumentPatch,
  KnowledgeDocumentType,
  KnowledgeEvidenceKind,
  KnowledgeEvidenceRecord,
} from "./types.js";

export type KnowledgeOrganizationAction = "add" | "update" | "archive" | "none";

export interface KnowledgeRawEvidenceInput {
  title: string;
  body: string;
  summary?: string;
  kind?: KnowledgeEvidenceKind;
  sourceRefs?: SourceRef[];
  confidence?: number;
  metadata?: JsonObject;
}

export interface KnowledgeOrganizationProposal {
  id?: string;
  action: KnowledgeOrganizationAction;
  title: string;
  reason: string;
  targetKnowledgeId?: string;
  document?: KnowledgeDocumentInput;
  patch?: KnowledgeDocumentPatch;
  evidenceIds?: string[];
  confidence?: number;
  metadata?: JsonObject;
}

export interface KnowledgeOrganizationCommit {
  proposal: KnowledgeOrganizationProposal;
  document?: KnowledgeDocument;
  skipped: boolean;
  reason: string;
}

export interface KnowledgeOrganizerModelInput {
  evidence: KnowledgeEvidenceRecord[];
  existing: KnowledgeDocument[];
  preferredTypes?: KnowledgeDocumentType[];
}

export interface KnowledgeOrganizerModel {
  propose(input: KnowledgeOrganizerModelInput): Promise<KnowledgeOrganizationProposal[]>;
}

export interface KnowledgeOrganizerOptions {
  store: KnowledgeStore;
  model?: KnowledgeOrganizerModel;
}

export class KnowledgeOrganizer {
  constructor(private readonly options: KnowledgeOrganizerOptions) {}

  captureRawEvidence(input: KnowledgeRawEvidenceInput): KnowledgeEvidenceRecord {
    const source = this.options.store.create({
      id: `source.${stableId(input.title, input.body)}`,
      slug: `source-${stableId(input.title, input.body)}`,
      type: "source",
      title: input.title,
      body: input.body,
      format: "markdown",
      tags: ["raw-evidence"],
      sourceRefs: input.sourceRefs ?? [],
      scope: "session",
      confidence: input.confidence,
      lifecycle: "active",
      metadata: {
        ...(input.metadata ?? {}),
        organizerRole: "raw_evidence",
      },
    });
    return this.options.store.recordEvidence({
      knowledgeId: source.id,
      kind: input.kind ?? "runtime_event",
      summary: input.summary ?? input.title,
      sourceRefs: input.sourceRefs,
      confidence: input.confidence,
      observedAt: new Date().toISOString(),
      metadata: {
        ...(input.metadata ?? {}),
        rawSourceKnowledgeId: source.id,
      },
    });
  }

  async proposeFromEvidence(input: KnowledgeOrganizerModelInput): Promise<KnowledgeOrganizationProposal[]> {
    if (this.options.model) {
      return this.options.model.propose(input);
    }
    return defaultProposals(input);
  }

  commitProposal(proposal: KnowledgeOrganizationProposal): KnowledgeOrganizationCommit {
    if (proposal.action === "none") {
      return {
        proposal,
        skipped: true,
        reason: proposal.reason || "proposal_requested_no_write",
      };
    }

    if (proposal.action === "add") {
      if (!proposal.document) {
        return {
          proposal,
          skipped: true,
          reason: "add_proposal_missing_document",
        };
      }
      const document = this.options.store.create({
        ...proposal.document,
        confidence: proposal.confidence ?? proposal.document.confidence,
        metadata: {
          ...(proposal.document.metadata ?? {}),
          organizerProposalId: proposal.id ?? "",
          organizerReason: proposal.reason,
          evidenceIds: (proposal.evidenceIds ?? []).join(","),
        },
      });
      return {
        proposal,
        document,
        skipped: false,
        reason: "document_added",
      };
    }

    if (!proposal.targetKnowledgeId) {
      return {
        proposal,
        skipped: true,
        reason: "proposal_missing_target_knowledge_id",
      };
    }

    if (proposal.action === "archive") {
      const document = this.options.store.archive(proposal.targetKnowledgeId);
      return {
        proposal,
        document,
        skipped: false,
        reason: "document_archived",
      };
    }

    if (!proposal.patch) {
      return {
        proposal,
        skipped: true,
        reason: "update_proposal_missing_patch",
      };
    }
    const document = this.options.store.update(proposal.targetKnowledgeId, {
      ...proposal.patch,
      confidence: proposal.confidence ?? proposal.patch.confidence,
      metadata: {
        ...(proposal.patch.metadata ?? {}),
        organizerProposalId: proposal.id ?? "",
        organizerReason: proposal.reason,
        evidenceIds: (proposal.evidenceIds ?? []).join(","),
      },
    });
    return {
      proposal,
      document,
      skipped: false,
      reason: "document_updated",
    };
  }

  async organizeEvidence(
    evidence: KnowledgeEvidenceRecord[],
    options: { commit?: boolean; preferredTypes?: KnowledgeDocumentType[] } = {},
  ): Promise<KnowledgeOrganizationCommit[]> {
    const proposals = await this.proposeFromEvidence({
      evidence,
      existing: this.options.store.list({ lifecycle: "active", limit: 20 }),
      preferredTypes: options.preferredTypes,
    });
    if (options.commit === false) {
      return proposals.map((proposal) => ({
        proposal,
        skipped: true,
        reason: "commit_disabled",
      }));
    }
    return proposals.map((proposal) => this.commitProposal(proposal));
  }
}

export function createKnowledgeOrganizer(options: KnowledgeOrganizerOptions): KnowledgeOrganizer {
  return new KnowledgeOrganizer(options);
}

function defaultProposals(input: KnowledgeOrganizerModelInput): KnowledgeOrganizationProposal[] {
  const proposals: KnowledgeOrganizationProposal[] = [];
  for (const evidence of input.evidence) {
    const text = evidence.summary.trim();
    const match = text.match(/^(?:remember|记住|长期记忆)[:：]\s*(.+)$/i);
    if (!match) {
      proposals.push({
        id: `proposal.${evidence.id}.none`,
        action: "none",
        title: "No durable knowledge proposed",
        reason: "no_explicit_durable_memory_marker",
        evidenceIds: [evidence.id],
      });
      continue;
    }
    const body = (match[1] ?? "").trim();
    proposals.push({
      id: `proposal.${evidence.id}.add`,
      action: "add",
      title: body.slice(0, 80),
      reason: "explicit_durable_memory_marker",
      evidenceIds: [evidence.id],
      document: {
        type: "memory",
        title: body.slice(0, 80),
        body,
        format: "plain",
        tags: ["organized", "explicit"],
        sourceRefs: evidence.sourceRefs,
        scope: "user",
        confidence: evidence.confidence ?? 0.75,
        metadata: {
          organizerEvidenceId: evidence.id,
        },
      },
    });
  }
  return proposals;
}

function stableId(title: string, body: string): string {
  const text = `${title}\n${body}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
