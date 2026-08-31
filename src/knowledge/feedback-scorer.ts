import type { KnowledgeStore } from "./store.js";
import type { KnowledgeFeedbackEvent, KnowledgeFeedbackInput, KnowledgeFeedbackSignal } from "./types.js";

export interface KnowledgeFeedbackScorerOptions {
  store: KnowledgeStore;
}

export interface ApplyKnowledgeFeedbackInput extends KnowledgeFeedbackInput {
  applyToConfidence?: boolean;
}

export interface KnowledgeFeedbackScoreResult {
  event: KnowledgeFeedbackEvent;
  previousConfidence?: number;
  nextConfidence?: number;
  applied: boolean;
  reason: string;
}

const DEFAULT_SIGNAL_DELTAS: Record<KnowledgeFeedbackSignal, number> = {
  useful: 0.08,
  ignored: -0.02,
  corrected: -0.18,
  stale: -0.12,
  promoted: 0.16,
  demoted: -0.16,
};

export class KnowledgeFeedbackScorer {
  constructor(private readonly options: KnowledgeFeedbackScorerOptions) {}

  apply(input: ApplyKnowledgeFeedbackInput): KnowledgeFeedbackScoreResult {
    const scoreDelta = input.scoreDelta ?? DEFAULT_SIGNAL_DELTAS[input.signal];
    const event = this.options.store.recordFeedback({
      ...input,
      scoreDelta,
      metadata: {
        ...(input.metadata ?? {}),
        scorer: "default_signal_delta",
      },
    });

    if (input.applyToConfidence === false) {
      return {
        event,
        applied: false,
        reason: "confidence_update_disabled",
      };
    }

    const document = this.options.store.get(input.knowledgeId);
    if (!document) {
      return {
        event,
        applied: false,
        reason: "knowledge_document_not_found",
      };
    }

    const previousConfidence = document.confidence ?? 0.5;
    const nextConfidence = clamp(previousConfidence + scoreDelta, 0, 1);
    if (nextConfidence === previousConfidence) {
      return {
        event,
        previousConfidence,
        nextConfidence,
        applied: false,
        reason: "confidence_unchanged",
      };
    }

    this.options.store.update(document.id, {
      confidence: nextConfidence,
      metadata: {
        ...document.metadata,
        lastFeedbackSignal: input.signal,
        lastFeedbackId: event.id,
        lastFeedbackScoreDelta: scoreDelta,
      },
    });

    return {
      event,
      previousConfidence,
      nextConfidence,
      applied: true,
      reason: "confidence_updated",
    };
  }
}

export function createKnowledgeFeedbackScorer(options: KnowledgeFeedbackScorerOptions): KnowledgeFeedbackScorer {
  return new KnowledgeFeedbackScorer(options);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number(value.toFixed(4))));
}
