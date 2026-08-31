import type { ApprovalRequest, ApprovalStatus, JsonValue } from "../types.js";
import { PendingRequestStore } from "./pending-request-store.js";

export class ApprovalInbox extends PendingRequestStore<ApprovalRequest, ApprovalStatus, "pending"> {
  constructor() {
    super({
      prefix: "approval",
      pendingStatus: "pending",
      label: "Approval request",
    });
  }

  override decide(id: string, status: Exclude<ApprovalStatus, "pending">, response?: JsonValue): ApprovalRequest {
    return super.decide(id, status, response);
  }
}
