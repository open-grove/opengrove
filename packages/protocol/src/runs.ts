import { askCancelContract, askGuideContract, askCompactContract } from "./ask-controls.js";
import { defineHostOperation, defineHostOperationGroup, defineHostOperationResource } from "./operation.js";
import { hostRequestErrors } from "./host-errors.js";

export const cancelDirectRunOperation = defineHostOperation({
  id: "run.direct.cancel",
  summary: "Cancel a direct run",
  description:
    "Cancel an active direct streaming run by run ID or thread ID. A missing or completed run returns cancelled=false. Room message runs use room message cancel.",
  method: "POST",
  path: "/ask/cancel",
  risk: "write",
  body: askCancelContract.request,
  success: { status: 200, body: askCancelContract.response },
  errors: hostRequestErrors,
});
export type CancelDirectRunOperation = typeof cancelDirectRunOperation;
export const guideDirectRunOperation = defineHostOperation({
  id: "run.direct.guide",
  summary: "Guide an active direct run",
  description:
    "Send an instruction to an active direct streaming run. The selected Kernel determines whether steering is supported.",
  method: "POST",
  path: "/ask/guide",
  risk: "write",
  body: askGuideContract.request,
  success: { status: 200, body: askGuideContract.response },
  errors: hostRequestErrors,
});
export type GuideDirectRunOperation = typeof guideDirectRunOperation;
export const compactDirectSessionOperation = defineHostOperation({
  id: "run.direct.compact",
  summary: "Compact a direct session",
  description:
    "Ask the session's Kernel to compact its context. Kernel support and its confirmed result remain authoritative.",
  method: "POST",
  path: "/ask/compact",
  risk: "write",
  body: askCompactContract.request,
  success: { status: 200, body: askCompactContract.response },
  errors: hostRequestErrors,
});
export type CompactDirectSessionOperation = typeof compactDirectSessionOperation;
export const runOperationGroup = defineHostOperationGroup({
  id: "run",
  title: "Execution",
  description: "Run records, direct execution, and session controls.",
  resources: [
    defineHostOperationResource({
      id: "direct",
      title: "Direct sessions",
      description: "Control direct streaming execution.",
      operations: [cancelDirectRunOperation, guideDirectRunOperation, compactDirectSessionOperation] as const,
    }),
  ] as const,
});
