import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalRequest, WorkingStateRecord } from "../core.js";
import { presentApprovalSummaries, presentWorkingState } from "../server/state-presentation.js";

test("browser working state omits loaded skill bodies and unrelated schema caches", () => {
  const state: WorkingStateRecord = {
    pinnedArtifactIds: [],
    workingArtifactIds: [],
    pendingApprovalIds: [],
    pendingQuestionIds: [],
    activeToolCallIds: [],
    discoveredSkillIds: [],
    discoveredSkillNames: [],
    expandedSkillIds: [],
    loadedNestedMemoryPaths: [],
    invokedSkills: [
      {
        skillId: "skill.large",
        skillName: "large",
        title: "Large",
        content: "x".repeat(1_000_000),
        contentPreview: "preview",
        sourcePath: "/tmp/SKILL.md",
        source: "user",
        trust: "trusted",
        context: "inline",
        allowedTools: [],
        invokedAt: "2026-08-04T00:00:00.000Z",
        origin: "user",
      },
    ],
    toolSchemaCache: {
      "claude.slashCommands": "[]",
      "large.private.cache": "y".repeat(1_000_000),
    },
    updatedAt: "2026-08-04T00:00:00.000Z",
  };

  const presented = presentWorkingState(state);
  assert.equal(presented.invokedSkills[0]?.content, "");
  assert.equal(presented.invokedSkills[0]?.contentPreview, "preview");
  assert.deepEqual(presented.toolSchemaCache, { "claude.slashCommands": "[]" });
  assert.ok(JSON.stringify(presented).length < 5_000);
});

test("pending action polling bounds tool inputs and excludes private resume state", () => {
  const approval: ApprovalRequest = {
    id: "approval-1",
    kind: "tool",
    title: "Run tool",
    reason: "Needs approval",
    status: "pending",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    input: { payload: "x".repeat(1_000_000) },
    resume: {
      type: "routine.step",
      routineId: "routine-1",
      stepId: "step-1",
      runId: "run-1",
      stepOutputs: { secret: "y".repeat(1_000_000) },
    },
  };

  const presented = presentApprovalSummaries([approval])[0]!;
  assert.equal(presented.resume, undefined);
  assert.ok(JSON.stringify(presented).length < 20_000);
});
