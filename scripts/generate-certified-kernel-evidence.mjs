#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const baselinePath = join(projectRoot, "src/kernel/capabilities/certified-contract-test-evidence.baseline.json");
const importsPath = join(projectRoot, "src/kernel/capabilities/certified-contract-test-evidence.imports.json");
const outputPath = join(projectRoot, "src/kernel/capabilities/certified-contract-test-evidence.generated.json");
const mode = process.argv.includes("--write") ? "write" : "check";
const lockedLegacyBaselineSha256 = "897472724ac3fb01c7ceeeba7ba621d5ce59fac9dce6fdb58295415d1fa9a7d1";

const baselineRaw = readFileSync(baselinePath, "utf8");
assert(
  createHash("sha256").update(baselineRaw).digest("hex") === lockedLegacyBaselineSha256,
  "legacy certified baseline changed; new or refreshed evidence must be imported from a real-runtime receipt",
);
const baseline = JSON.parse(baselineRaw);
assert(baseline?.schemaVersion === 1, "baseline schemaVersion must be 1");
assert(Array.isArray(baseline.contractTests), "baseline contractTests must be an array");
assert(
  stringValue(baseline.legacyHostVersion),
  "baseline legacyHostVersion must record the Host version that produced the imported evidence",
);

const replacements = new Map();
const importsRaw = readFileSync(importsPath, "utf8");
assertNoSecrets(importsRaw, importsPath);
const imported = JSON.parse(importsRaw);
assert(imported?.schemaVersion === 1, "certified imports schemaVersion must be 1");
assert(imported?.source === "import-kernel-evidence-receipt", "certified imports have an unknown source");
assert(Array.isArray(imported.batches), "certified imports batches must be an array");
for (const batch of imported.batches) {
  assert(stringValue(batch?.kernel), "certified import batch is missing kernel");
  assert(/^[a-f0-9]{64}$/.test(batch?.receiptSha256 ?? ""), `${batch.kernel}: invalid receipt SHA-256`);
  assert(Array.isArray(batch.certifications), `${batch.kernel}: certifications must be an array`);
  for (const evidence of batch.certifications) {
    const key = evidenceKey(evidence);
    assert(evidence.kernel === batch.kernel, `${key}: certification does not match its import batch`);
    for (const field of ["hostVersion", "kernelVersion", "runtimeMode"]) {
      assert(typeof evidence[field] === "string" && evidence[field], `${key}: missing ${field}`);
    }
    assert(evidence.passed === true, `${key}: certification is not passing`);
    assert(evidence.verification === "real_runtime", `${key}: certification is not real_runtime`);
    assert(!replacements.has(key), `duplicate imported certification for ${key}`);
    replacements.set(key, publishEvidence(evidence));
  }
}

const generated = [];
const seen = new Set();
for (const evidence of baseline.contractTests) {
  const key = evidenceKey(evidence);
  assert(!seen.has(key), `baseline contains duplicate ${key}`);
  seen.add(key);
  generated.push(replacements.get(key) ?? publishEvidence(evidence, { legacyHostVersion: baseline.legacyHostVersion }));
  replacements.delete(key);
}
for (const [key, evidence] of [...replacements].sort(([left], [right]) => left.localeCompare(right))) {
  assert(!seen.has(key), `generated evidence contains duplicate ${key}`);
  generated.push(evidence);
}

const text = `${JSON.stringify(generated, null, 2)}\n`;
if (mode === "write") {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, outputPath);
  console.log(`generated ${generated.length} certified Kernel evidence rows from ${imported.batches.length} imports`);
} else {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  assert(current === text, "certified Kernel evidence is stale or hand-edited; run `npm run generate:kernel-evidence`");
  console.log(
    `certified Kernel evidence is reproducible (${generated.length} rows, ${imported.batches.length} imports)`,
  );
}

function publishEvidence(evidence, options = {}) {
  const published = {
    kernel: requiredString(evidence.kernel, "kernel"),
    capability: requiredString(evidence.capability, "capability"),
    testId: requiredString(evidence.testId, "testId"),
    passed: evidence.passed === true,
    checkedAt: requiredString(evidence.checkedAt, "checkedAt"),
    ...(stringValue(evidence.hostVersion) ? { hostVersion: evidence.hostVersion } : {}),
    ...(stringValue(evidence.kernelVersion) ? { kernelVersion: evidence.kernelVersion } : {}),
    ...(stringValue(evidence.runtimeMode) ? { runtimeMode: evidence.runtimeMode } : {}),
    ...(stringValue(options.legacyHostVersion) ? { legacyHostVersion: options.legacyHostVersion } : {}),
    ...(evidence.provider && typeof evidence.provider === "object" ? { provider: evidence.provider } : {}),
    verification: evidence.verification,
  };
  assert(published.passed, `${published.testId}: only passing evidence can be published`);
  assert(published.verification === "real_runtime", `${published.testId}: only real_runtime evidence can be published`);
  return published;
}

function evidenceKey(evidence) {
  return `${requiredString(evidence?.kernel, "kernel")}::${requiredString(evidence?.capability, "capability")}`;
}

function requiredString(value, field) {
  assert(stringValue(value), `${field} must be a non-empty string`);
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNoSecrets(raw, path) {
  const patterns = [
    /"authorization"/i,
    /"api[_-]?key"/i,
    /"(?:access|refresh)[_-]?token"/i,
    /Bearer\s+[a-z0-9._-]{16,}/i,
    /sk-(?:ant-)?[a-z0-9-]{16,}/i,
  ];
  for (const pattern of patterns) assert(!pattern.test(raw), `${path}: possible credential leak ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
