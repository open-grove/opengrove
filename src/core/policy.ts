import type { PolicyDecision, PolicyRule, ToolRisk, ToolSpec } from "./types.js";

const DEFAULT_POLICY_BY_RISK: Record<ToolRisk, PolicyDecision> = {
  read: { mode: "allow", reason: "Read-only tools are safe by default." },
  write: { mode: "ask", reason: "Writing should be visible to the user." },
  send: { mode: "ask", reason: "Sending external data needs approval." },
  spend: { mode: "ask", reason: "Spending money needs approval." },
  delete: { mode: "ask", reason: "Deleting data needs approval." },
};

export function evaluateToolPolicy(spec: ToolSpec, rules: PolicyRule[] = [], capabilityId?: string): PolicyDecision {
  const rule = rules.find((candidate) => {
    const toolMatches = candidate.toolId === undefined || candidate.toolId === spec.id;
    const riskMatches = candidate.risk === undefined || candidate.risk === spec.risk;
    const capabilityMatches = candidate.capabilityId === undefined || candidate.capabilityId === capabilityId;
    return toolMatches && riskMatches && capabilityMatches;
  });

  if (rule) {
    return { mode: rule.mode, reason: rule.reason, matchedRuleId: rule.id };
  }

  if (spec.permission?.mode === "allow") {
    return spec.permission;
  }

  if (spec.permission?.mode) {
    return spec.permission;
  }

  return DEFAULT_POLICY_BY_RISK[spec.risk];
}
