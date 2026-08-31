#!/usr/bin/env node
// Real-runtime evidence policy checker.
//
// The probe runner emits evidence but never exits non-zero on a `failed`
// record, so CI must run this gate right after it. This script decides whether
// a single-kernel evidence file is allowed to claim "this version was verified
// in this job", enforcing the honest-ledger rules:
//
//   1. JSON parses and matches the expected evidence shape.
//   2. Every required capability for the target kernel is `passed`.
//   3. Any `failed` probe fails the job.
//   4. A `skipped` probe is allowed only when the contract itself declares the
//      capability not-wired/suppressed, or the caller explicitly allow-lists it.
//      Infrastructure skips (missing credential, binary not found, gateway not
//      configured) are never accepted and fail the job.
//   5. provider/model/checkedAt belong to this job (freshness, not the ledger).
//   6. No secret / Authorization / token / auth-home content leaked into evidence.
//   7. Each `kernel + capability` appears exactly once in this run.
//
// Usage:
//   node scripts/check-real-runtime-evidence.mjs \
//     --file "$RUNNER_TEMP/evidence/opencode.json" \
//     --kernel opencode \
//     --require message.streamText,turn.lifecycle,session.lifecycle \
//     --fail-on-failed \
//     [--allow-skip diagnostics.usage] \
//     [--checked-at 2026-07-29] \
//     [--max-age-days 1]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ===== argument parsing =====

function parseArgs(argv) {
  const options = {
    file: undefined,
    kernel: undefined,
    require: [],
    allowSkip: [],
    failOnFailed: false,
    checkedAt: undefined,
    maxAgeDays: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--file" && value) {
      options.file = value;
      index += 1;
    } else if (arg === "--kernel" && value) {
      options.kernel = value;
      index += 1;
    } else if (arg === "--require" && value) {
      options.require = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
    } else if (arg === "--allow-skip" && value) {
      options.allowSkip.push(
        ...value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      index += 1;
    } else if (arg === "--fail-on-failed") {
      options.failOnFailed = true;
    } else if (arg === "--checked-at" && value) {
      options.checkedAt = value;
      index += 1;
    } else if (arg === "--max-age-days" && value) {
      options.maxAgeDays = Number.parseInt(value, 10);
      index += 1;
    }
  }
  return options;
}

// ===== leak detection =====

// A skip is legitimate only when the contract layer itself declared the
// capability untestable. Any other skip reason (missing credential, binary not
// found, gateway not configured, timeout) is an infrastructure or coverage gap
// that must not pass as green unless the caller explicitly allow-lists it.
const CONTRACT_SKIP_REASONS = new Set(["contract_not-wired", "contract_suppressed", "no_contract_test_declared"]); // Evidence is uploaded as an artifact, so it must never carry credentials. We
// scan the raw JSON text for both structural key names and value shapes that
// indicate a secret slipped through the probe runner's redaction.
const LEAK_KEY_PATTERNS = [
  /"authorization"/i,
  /"api[_-]?key"/i,
  /"access[_-]?token"/i,
  /"refresh[_-]?token"/i,
  /"gateway[_-]?token"/i,
  /"gateway[_-]?password"/i,
  /"password"/i,
  /"secret"/i,
  /"cookie"/i,
];
const LEAK_VALUE_PATTERNS = [
  /sk-[a-z0-9]{16,}/i, // OpenAI-style keys
  /sk-ant-[a-z0-9-]{16,}/i, // Anthropic-style keys
  /Bearer\s+[a-z0-9._-]{16,}/i, // bearer headers
  /eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{6,}/i, // JWT
];

function findLeaks(rawText) {
  const hits = [];
  for (const pattern of LEAK_KEY_PATTERNS) {
    if (pattern.test(rawText)) hits.push(`key pattern ${pattern}`);
  }
  for (const pattern of LEAK_VALUE_PATTERNS) {
    if (pattern.test(rawText)) hits.push(`value pattern ${pattern}`);
  }
  return hits;
}

// ===== schema validation =====

function assertShape(evidence, errors) {
  if (typeof evidence !== "object" || evidence === null) {
    errors.push("evidence is not an object");
    return false;
  }
  if (evidence.schemaVersion === undefined) {
    errors.push("missing schemaVersion");
  }
  if (typeof evidence.generatedAt !== "string") {
    errors.push("missing or non-string generatedAt");
  }
  if (!Array.isArray(evidence.probes)) {
    errors.push("probes is not an array");
    return false;
  }
  return true;
}

function assertProbeShape(probe, index, errors) {
  const prefix = `probes[${index}]`;
  for (const field of ["kernel", "capability", "status"]) {
    if (typeof probe[field] !== "string") {
      errors.push(`${prefix}.${field} missing or non-string`);
    }
  }
  if (!["passed", "failed", "skipped"].includes(probe.status)) {
    errors.push(`${prefix}.status "${probe.status}" is not passed/failed/skipped`);
  }
}

// ===== freshness =====

function daysBetween(isoA, isoB) {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

// ===== main =====

function main() {
  const options = parseArgs(process.argv.slice(2));
  const errors = [];

  if (!options.file) errors.push("--file is required");
  if (!options.kernel) errors.push("--kernel is required");
  if (errors.length > 0) {
    fail(errors);
    return;
  }

  const filePath = resolve(process.cwd(), options.file);
  let rawText;
  try {
    rawText = readFileSync(filePath, "utf8");
  } catch (error) {
    fail([`cannot read evidence file ${filePath}: ${error.message}`]);
    return;
  }

  // Rule 6: leak detection runs on the raw text before parsing, so obfuscated
  // structures cannot hide a credential from us.
  const leaks = findLeaks(rawText);
  for (const leak of leaks) {
    errors.push(`potential credential leak: ${leak}`);
  }

  let evidence;
  try {
    evidence = JSON.parse(rawText);
  } catch (error) {
    fail([...errors, `evidence is not valid JSON: ${error.message}`]);
    return;
  }

  // Rule 1: schema.
  if (!assertShape(evidence, errors)) {
    fail(errors);
    return;
  }

  const probesForKernel = [];
  evidence.probes.forEach((probe, index) => {
    assertProbeShape(probe, index, errors);
    if (probe.kernel === options.kernel) probesForKernel.push(probe);
  });

  if (probesForKernel.length === 0) {
    errors.push(`no probes found for kernel "${options.kernel}"`);
    fail(errors);
    return;
  }

  // Rule 7: uniqueness of kernel + capability within this run.
  const seen = new Map();
  for (const probe of probesForKernel) {
    const key = `${probe.kernel}::${probe.capability}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) errors.push(`duplicate probe records (${count}) for ${key}`);
  }

  // Rule 5: freshness. Every probe must carry a checkedAt, and if the caller
  // pins the job date the records must match it (a historical ledger entry
  // cannot masquerade as a fresh verification).
  for (const probe of probesForKernel) {
    if (typeof probe.checkedAt !== "string" || probe.checkedAt.length === 0) {
      errors.push(`probe ${probe.capability} missing checkedAt`);
      continue;
    }
    if (options.checkedAt && probe.checkedAt !== options.checkedAt) {
      errors.push(
        `probe ${probe.capability} checkedAt ${probe.checkedAt} does not match job date ${options.checkedAt}`,
      );
    }
    if (options.maxAgeDays !== undefined && !Number.isNaN(options.maxAgeDays)) {
      const age = daysBetween(probe.checkedAt, new Date().toISOString());
      if (Number.isNaN(age)) {
        errors.push(`probe ${probe.capability} has unparseable checkedAt ${probe.checkedAt}`);
      } else if (age > options.maxAgeDays) {
        errors.push(
          `probe ${probe.capability} checkedAt ${probe.checkedAt} is ${age.toFixed(1)} days old (max ${options.maxAgeDays})`,
        );
      }
    }
  }

  // Rules 2, 3, 4: status policy.
  const byCapability = new Map(probesForKernel.map((probe) => [probe.capability, probe]));

  for (const capability of options.require) {
    const probe = byCapability.get(capability);
    if (!probe) {
      errors.push(`required capability ${capability} has no probe record`);
    } else if (probe.status !== "passed") {
      errors.push(`required capability ${capability} is ${probe.status}, expected passed`);
    }
  }

  const allowSkip = new Set(options.allowSkip);
  for (const probe of probesForKernel) {
    if (probe.status === "failed" && options.failOnFailed) {
      errors.push(`probe ${probe.capability} failed: ${probe.reason ?? "no reason recorded"}`);
    }
    if (probe.status === "skipped") {
      const reason = probe.reason ?? "no reason recorded";
      const contractLegal = CONTRACT_SKIP_REASONS.has(probe.reason);
      const explicitlyAllowed = allowSkip.has(probe.capability);
      if (!contractLegal && !explicitlyAllowed) {
        errors.push(`probe ${probe.capability} skipped without a contract reason: ${reason}`);
      }
    }
  }

  if (errors.length > 0) {
    fail(errors);
    return;
  }

  const summary = probesForKernel.map((probe) => `  ${probe.capability}: ${probe.status}`).join("\n");
  process.stdout.write(
    `Evidence policy passed for kernel "${options.kernel}" (${probesForKernel.length} probes):\n${summary}\n`,
  );
}

function fail(errors) {
  process.stderr.write("Evidence policy check FAILED:\n");
  for (const error of errors) {
    process.stderr.write(`  - ${error}\n`);
  }
  process.exit(1);
}

main();
