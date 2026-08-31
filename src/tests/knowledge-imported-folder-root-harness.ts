import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKnowledgeStore } from "../knowledge/store.js";
import type { BridgeState } from "../server/bridge-types.js";
import { syncImportedNativeFolderRoot } from "../server/knowledge-imported-folders.js";

interface TestApp {
  knowledge: ReturnType<typeof createKnowledgeStore>;
}

function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-imported-root-"));
  const firstRoot = join(cwd, "first-skills");
  const secondRoot = join(cwd, "second-skills");
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });

  const firstFile = join(firstRoot, "alpha.md");
  const secondFile = join(secondRoot, "beta.md");
  writeFileSync(firstFile, "# Alpha\n", "utf8");
  writeFileSync(secondFile, "# Beta\n", "utf8");

  const app: TestApp = { knowledge: createKnowledgeStore() };
  const state = { app } as unknown as BridgeState;

  assert.equal(syncImportedNativeFolderRoot(state, firstRoot, "Codex/skills"), true);
  assertImportedFilePresent(app, firstFile);

  assert.equal(syncImportedNativeFolderRoot(state, secondRoot, "Codex/skills"), true);
  const firstDoc = assertImportedFilePresent(app, firstFile);
  assertImportedFilePresent(app, secondFile);

  assert.equal(syncImportedNativeFolderRoot(state, firstRoot, "Codex/skills"), false);
  assertImportedFilePresent(app, firstFile);
  assertImportedFilePresent(app, secondFile);
  assert.equal(
    app.knowledge.listRevisions({ knowledgeId: firstDoc.id }).filter((revision) => revision.operation === "delete")
      .length,
    0,
    "syncing another physical root with the same vaultPath must not delete this root's documents",
  );

  console.log("knowledge-imported-folder-root-harness passed");
}

function assertImportedFilePresent(app: TestApp, filePath: string) {
  const resolved = resolve(filePath);
  const document = app.knowledge
    .list()
    .find(
      (candidate) =>
        candidate.metadata?.createdBy === "opengrove.import-folder" &&
        candidate.metadata?.sourceFileOriginPath === resolved,
    );
  assert.ok(document, `expected imported document for ${resolved}`);
  return document;
}

main();
