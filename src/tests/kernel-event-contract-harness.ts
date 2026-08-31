import assert from "node:assert/strict";
import type { AgentEvent } from "../core.js";
import {
  hasCorrelatedToolProgress,
  hasFinishedTool,
  inspectAgentTurnEvents,
} from "./harnesses/kernel-event-contract.js";
import { providerUnavailableReason } from "./kernel-real-runtime-probe-classification.js";

const runId = "event-contract-run";
const cleanEvents: AgentEvent[] = [
  { type: "turn.started", runId, at: "2026-08-06T00:00:00.000Z" },
  { type: "assistant.delta", runId, text: "hello " },
  { type: "assistant.delta", runId, text: "world" },
  { type: "model.response", runId, response: { text: "hello world" } },
  { type: "turn.finished", runId, at: "2026-08-06T00:00:01.000Z" },
];
const clean = inspectAgentTurnEvents(cleanEvents);
assert.equal(clean.lifecycleClosedExactlyOnce, true);
assert.equal(clean.modelResponseCount, 1);
assert.equal(clean.assistantDeltaBeforeResponse, true);
assert.equal(clean.modelResponseBeforeTurnFinished, true);
assert.equal(clean.assistantTextMatchesResponse, true);

const duplicateTerminal = inspectAgentTurnEvents([
  ...cleanEvents.slice(0, -1),
  { type: "model.response", runId, response: { text: "hello world" } },
  cleanEvents.at(-1)!,
]);
assert.equal(duplicateTerminal.modelResponseCount, 2);
assert.equal(duplicateTerminal.assistantTextMatchesResponse, false);

const duplicateProjection = inspectAgentTurnEvents([
  cleanEvents[0]!,
  { type: "assistant.delta", runId, text: "hello world" },
  { type: "assistant.delta", runId, text: "hello world" },
  cleanEvents[3]!,
  cleanEvents[4]!,
]);
assert.equal(duplicateProjection.assistantTextMatchesResponse, false);

const duplicateLifecycle = inspectAgentTurnEvents([cleanEvents[0]!, cleanEvents[0]!, ...cleanEvents.slice(1)]);
assert.equal(duplicateLifecycle.lifecycleClosedExactlyOnce, false);

const terminalAfterFinish = inspectAgentTurnEvents([
  ...cleanEvents.slice(0, -2),
  cleanEvents.at(-1)!,
  cleanEvents.at(-2)!,
]);
assert.equal(terminalAfterFinish.modelResponseBeforeTurnFinished, false);

const streamBeforeStart = inspectAgentTurnEvents([cleanEvents[1]!, cleanEvents[0]!, ...cleanEvents.slice(2)]);
assert.equal(streamBeforeStart.assistantDeltaBeforeResponse, false);

const toolEvents: AgentEvent[] = [
  { type: "tool.started", runId, toolId: "native.read", callId: "call-1", input: {} },
  { type: "tool.progress", runId, toolId: "native.read", callId: "call-1", update: { phase: "halfway" } },
  { type: "tool.finished", runId, toolId: "native.read", callId: "call-1", result: { ok: true } },
];
assert.equal(hasFinishedTool(toolEvents, "native.read"), true);
assert.equal(
  hasCorrelatedToolProgress(toolEvents, (toolId) => toolId === "native.read"),
  true,
);
assert.equal(
  hasCorrelatedToolProgress(
    [
      toolEvents[0]!,
      { type: "tool.progress", runId, toolId: "native.read", callId: "different-call", update: { phase: "halfway" } },
      toolEvents[2]!,
    ],
    (toolId) => toolId === "native.read",
  ),
  false,
);
assert.equal(
  hasCorrelatedToolProgress([toolEvents[1]!], () => true),
  false,
);

assert.equal(
  providerUnavailableReason("API Error: 400 The provided model identifier is invalid."),
  undefined,
  "Adapter/model mapping failures must fail the probe instead of being reclassified as provider skips",
);
assert.equal(providerUnavailableReason("unknown model id sent by adapter"), undefined);
assert.match(
  providerUnavailableReason(
    "Your account does not have a valid CodingPlan subscription, or your subscription has expired.",
  ) ?? "",
  /CodingPlan subscription/i,
);
assert.equal(providerUnavailableReason("tool_progress_lifecycle_not_observed"), undefined);
assert.match(providerUnavailableReason("Provider is not configured: opengrove-google") ?? "", /not configured/i);

console.log("✓ normalized Kernel events enforce one terminal response and correlated tool progress");
