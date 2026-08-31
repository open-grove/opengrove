import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const typesPath = resolve(projectRoot, "src/kernel/capabilities/types.ts");
const policyPath = resolve(projectRoot, "web/src/runtime/kernel-capability-ui-policy.ts");
const docsPath = resolve(projectRoot, "docs/reference/kernel-capability-ui-references/README.md");

const standardCapabilities = readStandardCapabilityIds(typesPath);
const policies = readUiPolicies(policyPath);

const policyCapabilities = policies.map((policy) => policy.capability);
assert.deepEqual(
  [...new Set(policyCapabilities)].sort(),
  policyCapabilities.sort(),
  "UI policies must not declare duplicate capabilities",
);
assert.deepEqual(
  policyCapabilities.sort(),
  standardCapabilities.sort(),
  "Every standard kernel capability must have exactly one UI policy",
);

const byCapability = new Map(policies.map((policy) => [policy.capability, policy]));

assertPolicy("planning.plan", {
  normalUserFacing: true,
  treatment: "composer-control",
  implemented: true,
  gatedByCapabilityReport: true,
});
assertPolicy("interaction.askUser", {
  normalUserFacing: true,
  treatment: "message-surface",
  implemented: true,
  gatedByCapabilityReport: true,
});
assertPolicy("control.steer", {
  normalUserFacing: true,
  treatment: "composer-control",
  implemented: true,
  gatedByCapabilityReport: true,
});
assertPolicy("budget.limit", {
  normalUserFacing: true,
  treatment: "composer-control",
  implemented: true,
  gatedByCapabilityReport: true,
});
assertPolicy("tools.mcpServers", {
  normalUserFacing: true,
  treatment: "management-surface",
  implemented: true,
  gatedByCapabilityReport: true,
});
assertPolicy("diagnostics.usage", {
  normalUserFacing: false,
  treatment: "ops-only",
  gatedByCapabilityReport: false,
});
assertPolicy("output.structured", {
  normalUserFacing: false,
  treatment: "internal-only",
  implemented: true,
});
assertPolicy("output.artifacts", {
  normalUserFacing: true,
  implemented: true,
  gatedByCapabilityReport: true,
});
assertPolicy("media.input", {
  normalUserFacing: true,
  treatment: "composer-control",
  implemented: true,
  gatedByCapabilityReport: true,
});

for (const policy of policies) {
  assert.ok(policy.productRule.trim().length > 20, `${policy.capability} must explain the product rule`);
  assert.ok(policy.surfaces.length > 0, `${policy.capability} must name at least one surface`);
  if (policy.gatedByCapabilityReport) {
    assert.notEqual(
      policy.treatment,
      "background",
      `${policy.capability} cannot be both capability-gated product UI and background-only`,
    );
  }
}

const docs = readFileSync(docsPath, "utf8");
assert.ok(
  docs.includes("web/src/runtime/kernel-capability-ui-policy.ts"),
  "UI reference docs must point to the machine-checkable UI policy",
);

console.log("✓ kernel capability UI policies cover every standard capability");

function assertPolicy(capability, expected) {
  const policy = byCapability.get(capability);
  assert.ok(policy, `${capability} must have a UI policy`);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(policy[key], value, `${capability}.${key}`);
  }
}

function readStandardCapabilityIds(path) {
  const source = readFileSync(path, "utf8");
  const match = source.match(/STANDARD_KERNEL_CAPABILITY_IDS\s*=\s*\[([\s\S]*?)\]\s+as const/);
  assert.ok(match, "Could not find STANDARD_KERNEL_CAPABILITY_IDS");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function readUiPolicies(path) {
  const source = readFileSync(path, "utf8");
  const policyMatches = [...source.matchAll(/\{\s*capability:\s*"([^"]+)",([\s\S]*?)\n\s*\}/g)];
  assert.ok(policyMatches.length > 0, "Could not find UI policies");
  return policyMatches.map((match) => {
    const body = match[2];
    return {
      capability: match[1],
      normalUserFacing: readBoolean(body, "normalUserFacing"),
      treatment: readString(body, "treatment"),
      implemented: readBoolean(body, "implemented"),
      gatedByCapabilityReport: readBoolean(body, "gatedByCapabilityReport"),
      surfaces: readStringArray(body, "surfaces"),
      productRule: readString(body, "productRule"),
    };
  });
}

function readString(body, key) {
  const match = body.match(new RegExp(`${key}:\\s*"([^"]*)"`));
  assert.ok(match, `Missing string field ${key}`);
  return match[1];
}

function readBoolean(body, key) {
  const match = body.match(new RegExp(`${key}:\\s*(true|false)`));
  assert.ok(match, `Missing boolean field ${key}`);
  return match[1] === "true";
}

function readStringArray(body, key) {
  const match = body.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  assert.ok(match, `Missing array field ${key}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}
