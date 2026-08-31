import type { JsonValue, QuestionRequest, QuestionStatus } from "../types.js";
import { PendingRequestStore } from "./pending-request-store.js";

export class QuestionInbox extends PendingRequestStore<QuestionRequest, QuestionStatus, "pending"> {
  constructor() {
    super({
      prefix: "question",
      pendingStatus: "pending",
      label: "Question request",
    });
  }

  answer(id: string, status: Exclude<QuestionStatus, "pending">, response?: JsonValue): QuestionRequest {
    return super.decide(id, status, response);
  }

  override decide(id: string, status: Exclude<QuestionStatus, "pending">, response?: JsonValue): QuestionRequest {
    return this.answer(id, status, response);
  }
}
