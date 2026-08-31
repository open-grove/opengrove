import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pendingActionEventMarker } from "../web/src/runtime/bridge-sync-policy.ts";

assert.equal(pendingActionEventMarker([]), undefined);
assert.equal(
  pendingActionEventMarker([{ type: "assistant.delta", at: "2026-08-05T00:00:00.000Z" }]),
  undefined,
  "ordinary run events must not refresh pending actions",
);

const approvalRequested = {
  type: "approval.requested",
  at: "2026-08-05T00:00:01.000Z",
  request: { id: "approval-1", status: "pending", updatedAt: "2026-08-05T00:00:01.000Z" },
};
const approvalMarker = pendingActionEventMarker([approvalRequested]);
assert.ok(approvalMarker);
assert.equal(
  pendingActionEventMarker([approvalRequested, { type: "tool.finished", at: "2026-08-05T00:00:02.000Z" }]),
  approvalMarker,
  "unrelated events must not wake approvals and questions queries",
);
assert.notEqual(
  pendingActionEventMarker([
    approvalRequested,
    {
      type: "approval.resolved",
      at: "2026-08-05T00:00:03.000Z",
      request: { id: "approval-1", status: "approved", updatedAt: "2026-08-05T00:00:03.000Z" },
    },
  ]),
  approvalMarker,
  "approval resolution must refresh pending actions",
);

assert.notEqual(
  pendingActionEventMarker([
    approvalRequested,
    {
      type: "question.requested",
      at: "2026-08-05T00:00:04.000Z",
      question: { id: "question-1", status: "pending", updatedAt: "2026-08-05T00:00:04.000Z" },
    },
  ]),
  approvalMarker,
  "a new question must refresh pending actions",
);

const projectRoot = resolve(import.meta.dirname, "..");
const eventQuerySource = readFileSync(resolve(projectRoot, "web/src/runtime/use-agent-events-query.ts"), "utf8");
const flowPreviewSource = readFileSync(resolve(projectRoot, "web/src/components/shared/flow-preview.tsx"), "utf8");
const bridgeQueriesSource = readFileSync(resolve(projectRoot, "web/src/runtime/use-bridge-queries.ts"), "utf8");

assert.match(eventQuerySource, /input\.longPoll === true/);
assert.doesNotMatch(
  eventQuerySource,
  /input\.refetchInterval !== false/,
  "a refresh cadence must not implicitly opt a query into a 25-second long poll",
);
assert.match(eventQuerySource, /params\.append\("runId", runId\)/);
assert.equal(
  (flowPreviewSource.match(/useAgentEventsQuery\(/g) ?? []).length,
  1,
  "a Flow preview must aggregate all step runIds into one event query",
);
assert.match(flowPreviewSource, /runIds: activityRunIds/);
assert.match(bridgeQueriesSource, /longPoll: true/);

console.log("web-bridge-sync-policy ok");
