import assert from "node:assert/strict";
import { persistedRoomRunParts } from "../server/room-runs/persisted-parts.js";

const parts = persistedRoomRunParts(
  [
    {
      type: "approval.requested",
      runId: "run-timeout",
      request: {
        id: "approval_4",
        toolId: "workflow.create",
        title: "Create workflow",
        status: "pending",
        reason: "Writing should be visible to the user.",
        input: {
          appId: "short-drama-studio",
          title: "短剧投放复盘 · 加投建议（最近 7 天）",
        },
      },
    },
    {
      type: "approval.resolved",
      runId: "run-timeout",
      request: {
        id: "approval_4",
        toolId: "workflow.create",
        status: "rejected",
        response: { error: "Approval request timed out: approval_4" },
      },
    },
  ] as any,
  "run-timeout",
);

const approval = parts.find((part) => part.phase === "approval");
assert.ok(approval, "approval part should be persisted");
assert.equal(approval?.approvalStatus, "rejected");
assert.equal(approval?.status, "rejected");
assert.equal(approval?.error, "Approval request timed out: approval_4");

const quietParts = persistedRoomRunParts(
  [
    {
      type: "tool.started",
      runId: "run-quiet-tool",
      toolId: "claude.tool",
      input: { content: '{"knowledgeId":"know_3"}' },
    },
    {
      type: "tool.finished",
      runId: "run-quiet-tool",
      toolId: "claude.tool",
      result: {
        ok: true,
        value: { content: '{"knowledgeId":"know_3"}', structuredContent: { knowledgeId: "know_3" } },
      },
    },
  ] as any,
  "run-quiet-tool",
);
assert.equal(
  quietParts.some((part) => part.type === "tool" && part.toolId === "claude.tool"),
  false,
);

console.log("room-run-approval-timeout-harness passed");
