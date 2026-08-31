import assert from "node:assert/strict";
import { evaluateToolPolicy } from "../core/policy.js";
import type { ToolSpec } from "../core/types.js";

function toolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    id: "demo.write",
    title: "Demo write",
    description: "A demo write tool.",
    activity: "local",
    risk: "write",
    input: {
      type: "json-schema",
      schema: { type: "object", additionalProperties: true },
    },
    permission: {
      mode: "ask",
      reason: "Writing should be visible.",
    },
    ...overrides,
  };
}

const explicitAllow = evaluateToolPolicy(
  toolSpec({
    id: "demo.allow-write",
    permission: { mode: "allow", reason: "Explicitly safe write." },
  }),
);
assert.equal(explicitAllow.mode, "allow", "explicit allow on a write tool must not fall through to default ask");
assert.equal(explicitAllow.reason, "Explicitly safe write.");

const explicitAsk = evaluateToolPolicy(
  toolSpec({
    id: "demo.ask-write",
    permission: { mode: "ask", reason: "Ask explicitly." },
  }),
);
assert.equal(explicitAsk.mode, "ask", "explicit non-allow permission should still be returned");
assert.equal(explicitAsk.reason, "Ask explicitly.");

const missingPermission = evaluateToolPolicy({
  ...toolSpec({ id: "demo.missing-permission" }),
  permission: undefined,
} as unknown as ToolSpec);
assert.equal(missingPermission.mode, "ask", "write tools without an explicit permission still default to ask");
assert.equal(missingPermission.reason, "Writing should be visible to the user.");

const ruleOverridesAllow = evaluateToolPolicy(
  toolSpec({
    id: "demo.rule-priority",
    permission: { mode: "allow", reason: "Safe by tool declaration." },
  }),
  [{ id: "policy-rule-1", toolId: "demo.rule-priority", mode: "ask", reason: "Rule still wins." }],
);
assert.equal(ruleOverridesAllow.mode, "ask", "policy rules must retain priority over tool declarations");
assert.equal(ruleOverridesAllow.reason, "Rule still wins.");
assert.equal(ruleOverridesAllow.matchedRuleId, "policy-rule-1");

console.log("policy-harness passed");
