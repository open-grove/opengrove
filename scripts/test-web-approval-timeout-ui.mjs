import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-web-approval-timeout-ui-"));
const entryPath = join(tempDir, "approval-timeout-entry.ts");
const bundlePath = join(tempDir, "approval-timeout-entry.cjs");
const require = createRequire(import.meta.url);

try {
  await writeFile(entryPath, entrySource(), "utf8");
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  const mod = require(bundlePath);
  mod.runApprovalTimeoutUiHarness();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function entrySource() {
  const activityModelPath = resolve(projectRoot, "web/src/components/chat/message-activity-model.ts");
  return `
    import assert from "node:assert/strict";
    import {
      activityItemDetailDisplay,
      activityItemTitle,
      artifactCardsFromItem,
    } from ${JSON.stringify(activityModelPath)};

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: { getItem: () => "en" },
        location: { search: "" },
        navigator: { language: "en", languages: ["en"] },
      },
    });

    const workflowInput = {
      appId: "short-drama-studio",
      title: "短剧投放复盘 · 加投建议（最近 7 天）",
      description: "只读分析 routine：分析师拉取最近 7 天 FB 广告投放报表。",
      steps: [
        { title: "拉取最近 7 天投放报表", toolId: "fb-report" },
        { title: "综合排序 · 挑加投候选", memberId: "member-analyst" },
        { title: "整理加投建议清单", memberId: "member-analyst" },
      ],
    };

    function approvalPart(status, error = "") {
      return {
        id: "part-approval",
        type: "tool",
        phase: "approval",
        toolId: "workflow.create",
        title: "Create workflow",
        input: workflowInput,
        status,
        result: undefined,
        error,
        approvalId: "approval_4",
        approvalStatus: status === "approved" ? "approved" : "rejected",
        approvalReason: "Writing should be visible to the user.",
        approvalInput: workflowInput,
        questionId: "",
        questionStatus: "",
        questionPrompt: "",
        questionInput: undefined,
      };
    }

    export function runApprovalTimeoutUiHarness() {
      const timedOut = { type: "approval", key: "timeout", part: approvalPart("rejected", "Approval request timed out: approval_4") };
      assert.equal(activityItemTitle(timedOut), "Timed out · Create workflow");
      const timeoutDetail = activityItemDetailDisplay(timedOut);
      assert.ok(timeoutDetail?.label.includes("the user did not decline it"), "timeout detail should not imply user rejection");
      assert.ok(timeoutDetail?.label.includes('Create workflow "短剧投放复盘 · 加投建议（最近 7 天）"'));
      assert.ok(timeoutDetail?.label.includes("Includes 3 steps"));

      const rejected = { type: "approval", key: "rejected", part: approvalPart("rejected") };
      assert.equal(activityItemTitle(rejected), "Declined · Create workflow");

      const failedWorkflowCreate = {
        type: "tool",
        key: "failed-workflow-create",
        call: {
          id: "part-call",
          type: "tool",
          phase: "call",
          toolId: "workflow.create",
          title: "workflow.create",
          input: workflowInput,
          status: "running",
          result: undefined,
          error: "",
          approvalId: "",
          approvalStatus: "",
          approvalReason: "",
          questionId: "",
          questionStatus: "",
          questionPrompt: "",
        },
        result: {
          id: "part-result",
          type: "tool",
          phase: "result",
          toolId: "workflow.create",
          title: "workflow.create",
          input: undefined,
          status: "failed",
          result: { ok: false, error: "approval_rejected", value: { status: "ask" } },
          error: "approval_rejected",
          approvalId: "",
          approvalStatus: "",
          approvalReason: "",
          questionId: "",
          questionStatus: "",
          questionPrompt: "",
        },
      };
      assert.deepEqual(artifactCardsFromItem(failedWorkflowCreate), []);

      const successfulWorkflowCreate = {
        type: "tool",
        key: "successful-workflow-create",
        call: {
          ...failedWorkflowCreate.call,
          status: "complete",
          input: workflowInput,
        },
        result: {
          ...failedWorkflowCreate.result,
          status: "complete",
          result: {
            knowledgeId: "know_3",
            title: workflowInput.title,
            stepCount: 3,
          },
          error: "",
        },
      };
      assert.deepEqual(artifactCardsFromItem(successfulWorkflowCreate), [{
        id: "workflow:know_3",
        title: workflowInput.title,
        kind: "Workflow",
        summary: "3 steps · 只读分析 routine：分析师拉取最近 7 天 FB 广告投放报表。",
        uri: "",
        imageUri: "",
        path: "",
        knowledgeId: "know_3",
      }]);

      console.log("web-approval-timeout-ui-harness ok");
    }
  `;
}
