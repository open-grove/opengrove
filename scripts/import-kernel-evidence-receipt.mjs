#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const sourcePath = resolve(process.cwd(), options.from);
const targetPath = resolve(process.cwd(), options.to);
const raw = readFileSync(sourcePath, "utf8");
assertNoSecrets(raw);
const source = JSON.parse(raw);
assert(source?.schemaVersion === 1, "source evidence schemaVersion must be 1");
assert(source?.source === "kernel-capability-real-runtime-probe-runner", "source is not a real-runtime probe receipt");
const capabilities = new Set(options.capabilities);
const probes = source.probes.filter((probe) => probe?.kernel === options.kernel && capabilities.has(probe.capability));
const contractTests = source.contractTests
  .filter((evidence) => evidence?.kernel === options.kernel && capabilities.has(evidence.capability))
  .map(({ source: _source, sourcePath: _sourcePath, ...evidence }) => evidence);
assert(probes.length === capabilities.size, "receipt must contain one selected probe per capability");
assert(contractTests.length === capabilities.size, "receipt must contain one selected contract test per capability");
for (const probe of probes) {
  assert(probe.status === "passed", `${probe.kernel}.${probe.capability} did not pass`);
  for (const field of ["hostVersion", "kernelVersion", "runtimeMode"]) {
    assert(typeof probe[field] === "string" && probe[field], `${probe.kernel}.${probe.capability} missing ${field}`);
  }
}
for (const evidence of contractTests) {
  assert(evidence.passed === true, `${evidence.kernel}.${evidence.capability} did not pass`);
  assert(evidence.verification === "real_runtime", `${evidence.kernel}.${evidence.capability} is not real_runtime`);
  for (const field of ["hostVersion", "kernelVersion", "runtimeMode"]) {
    assert(
      typeof evidence[field] === "string" && evidence[field],
      `${evidence.kernel}.${evidence.capability} missing ${field}`,
    );
  }
}
const current = existsSync(targetPath)
  ? JSON.parse(readFileSync(targetPath, "utf8"))
  : { schemaVersion: 1, source: "import-kernel-evidence-receipt", batches: [] };
assert(current?.schemaVersion === 1, "target imports schemaVersion must be 1");
assert(current?.source === "import-kernel-evidence-receipt", "target is not a certified imports file");
assert(Array.isArray(current.batches), "target imports batches must be an array");
const selectedKeys = new Set(contractTests.map((evidence) => `${evidence.kernel}::${evidence.capability}`));
const batches = current.batches
  .map((batch) => ({
    ...batch,
    certifications: Array.isArray(batch.certifications)
      ? batch.certifications.filter((evidence) => !selectedKeys.has(`${evidence?.kernel}::${evidence?.capability}`))
      : [],
  }))
  .filter((batch) => batch.certifications.length > 0);
batches.push({
  kernel: options.kernel,
  receiptSha256: createHash("sha256").update(raw).digest("hex"),
  certifications: contractTests,
});
batches.sort((left, right) =>
  `${left.kernel}:${left.receiptSha256}`.localeCompare(`${right.kernel}:${right.receiptSha256}`),
);
const imports = {
  schemaVersion: 1,
  source: "import-kernel-evidence-receipt",
  batches,
};
mkdirSync(dirname(targetPath), { recursive: true });
const temporaryPath = `${targetPath}.${process.pid}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(imports, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
renameSync(temporaryPath, targetPath);
console.log(`imported ${contractTests.length} certification rows to ${targetPath}; raw receipt remains local`);

function parseArgs(args) {
  const options = { from: "", to: "", kernel: "", capabilities: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--from" && value) options.from = value;
    else if (argument === "--to" && value) options.to = value;
    else if (argument === "--kernel" && value) options.kernel = value;
    else if (argument === "--capabilities" && value) options.capabilities = value.split(",").filter(Boolean);
    else throw new Error(`unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  assert(
    options.from && options.to && options.kernel && options.capabilities.length,
    "--from, --to, --kernel and --capabilities are required",
  );
  return options;
}

function assertNoSecrets(raw) {
  for (const pattern of [
    /"authorization"/i,
    /"api[_-]?key"/i,
    /"(?:access|refresh)[_-]?token"/i,
    /Bearer\s+[a-z0-9._-]{16,}/i,
    /sk-(?:ant-)?[a-z0-9-]{16,}/i,
  ])
    assert(!pattern.test(raw), `possible credential leak ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
