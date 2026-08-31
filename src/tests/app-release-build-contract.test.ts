import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalPortableRelativePath } from "../app-builder/portable-path.js";
import { readAppReleaseBuildContract, validateAppReleaseBuildContract } from "../server/app-release-build-contract.js";

test("build contract reader distinguishes a missing recipe from an invalid one", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-build-contract-missing-"));
  try {
    assert.deepEqual(readAppReleaseBuildContract(appRoot), { status: "missing" });
    assert.deepEqual(validateAppReleaseBuildContract(appRoot), {
      ok: false,
      detail: "build_contract_missing",
    });
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("build contract reader reports an existing malformed recipe as invalid", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-build-contract-invalid-"));
  try {
    writeFileSync(join(appRoot, ".opengrove-build.json"), "{not json}\n", "utf8");

    assert.deepEqual(readAppReleaseBuildContract(appRoot), { status: "invalid" });
    assert.deepEqual(validateAppReleaseBuildContract(appRoot), {
      ok: false,
      detail: "build_contract_invalid",
    });
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("build contract reader returns the parsed valid recipe", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-build-contract-valid-"));
  try {
    mkdirSync(join(appRoot, "web"));
    mkdirSync(join(appRoot, "ui"));
    writeFileSync(join(appRoot, "build.mjs"), "// build\n", "utf8");
    const recipe = {
      schemaVersion: 1,
      workingDirectory: ".",
      inputs: ["web", "build.mjs"],
      outputs: ["ui"],
      commands: [["node", "build.mjs"]],
    } as const;
    writeFileSync(join(appRoot, ".opengrove-build.json"), `${JSON.stringify(recipe)}\n`, "utf8");

    assert.deepEqual(readAppReleaseBuildContract(appRoot), {
      status: "valid",
      recipe,
    });
    assert.deepEqual(validateAppReleaseBuildContract(appRoot), {
      ok: true,
      detail: "build_contract_valid",
    });
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("build contract rejects case-folded input and output overlap", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-build-contract-casefold-"));
  try {
    mkdirSync(join(appRoot, "Web"));
    mkdirSync(join(appRoot, "Web", "Source"));
    mkdirSync(join(appRoot, "web", "source", "dist"), { recursive: true });
    writeFileSync(join(appRoot, "build.mjs"), "// build\n", "utf8");
    writeFileSync(
      join(appRoot, ".opengrove-build.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        workingDirectory: ".",
        inputs: ["Web/Source"],
        outputs: ["web/source/dist"],
        commands: [["node", "build.mjs"]],
      })}\n`,
      "utf8",
    );

    assert.deepEqual(readAppReleaseBuildContract(appRoot), { status: "invalid" });
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("build contract canonicalizes harmless dot aliases before overlap checks", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-build-contract-dot-alias-"));
  try {
    mkdirSync(join(appRoot, "web", "src"), { recursive: true });
    mkdirSync(join(appRoot, "ui"));
    writeFileSync(join(appRoot, "build.mjs"), "// build\n", "utf8");
    writeFileSync(
      join(appRoot, ".opengrove-build.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        workingDirectory: "././",
        inputs: ["web/./src"],
        outputs: ["web//src/dist"],
        commands: [["node", "build.mjs"]],
      })}\n`,
      "utf8",
    );

    assert.deepEqual(readAppReleaseBuildContract(appRoot), { status: "invalid" });
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("build contract rejects Windows trailing aliases and duplicate outputs", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-build-contract-portable-alias-"));
  try {
    mkdirSync(join(appRoot, "web"));
    mkdirSync(join(appRoot, "ui"));
    writeFileSync(join(appRoot, "build.mjs"), "// build\n", "utf8");
    const base = {
      schemaVersion: 1,
      workingDirectory: ".",
      inputs: ["web"],
      commands: [["node", "build.mjs"]],
    };
    for (const outputs of [["opengrove.app.json."], ["workspace "], ["ui", "././ui"]]) {
      writeFileSync(
        join(appRoot, ".opengrove-build.json"),
        `${JSON.stringify({
          ...base,
          outputs,
        })}\n`,
        "utf8",
      );
      assert.deepEqual(readAppReleaseBuildContract(appRoot), { status: "invalid" });
    }
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

test("portable paths reject Windows-invalid names and normalize Unicode spelling", () => {
  for (const path of ["ui/bad?.txt", "ui/bad|name.txt", "ui/bad\u0001name.txt", "ui/CON.txt"]) {
    assert.equal(canonicalPortableRelativePath(path), undefined);
  }
  assert.equal(canonicalPortableRelativePath("ui/e\u0301.txt"), "ui/é.txt");
});

test("build contract bounds commands, argv, and retained build logs", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-build-contract-command-budget-"));
  try {
    mkdirSync(join(appRoot, "web"));
    mkdirSync(join(appRoot, "ui"));
    writeFileSync(join(appRoot, "build.mjs"), "// build\n", "utf8");
    const base = {
      schemaVersion: 1,
      workingDirectory: ".",
      inputs: ["web", "build.mjs"],
      outputs: ["ui"],
    };
    for (const commands of [
      Array.from({ length: 17 }, () => ["node", "build.mjs"]),
      [["node", ...Array.from({ length: 64 }, () => "x")]],
      [["node", "x".repeat(8 * 1024)]],
    ]) {
      writeFileSync(
        join(appRoot, ".opengrove-build.json"),
        `${JSON.stringify({
          ...base,
          commands,
        })}\n`,
        "utf8",
      );
      assert.deepEqual(readAppReleaseBuildContract(appRoot), { status: "invalid" });
    }
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});
