import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import { createHermesKernelAdapter } from "../kernel/adapters/hermes.js";
import type { BridgeState } from "../server/bridge-types.js";
import { listKnowledgeInventoryDocuments } from "../server/knowledge-files.js";
import { writeFakeHermesGateway } from "./harnesses/fake-hermes-gateway.js";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-kernel-knowledge-"));
  const fakeGateway = join(cwd, "fake-hermes-gateway.mjs");
  writeFakeHermesGateway(fakeGateway, { marker: "FAKE_HERMES_KNOWLEDGE_OK", skipBlockingPrompts: true });
  const kernel = createHermesKernelAdapter({
    command: process.execPath,
    gatewayCommand: process.execPath,
    gatewayArgs: [fakeGateway],
    cwd,
  });
  const app = createOpenGrove({
    readPage: () => ({
      title: "Bottle research",
      url: "https://example.test/bottle",
      visibleText: "A light functional water bottle with botanical cues.",
    }),
    kernel,
    cwd,
  });

  const memory = app.memory.write({
    scope: "workspace",
    kind: "product.direction",
    text: "Bottle work should prefer light, botanical, natural visual language.",
    confidence: "asserted",
    source: { kind: "user" },
    tags: ["bottle", "visual"],
  });

  const artifact = app.artifacts.create({
    type: "brief",
    title: "Bottle visual brief",
    tags: ["bottle"],
    data: {
      direction: "light botanical water",
    },
    preview: {
      text: "Light botanical bottle direction.",
    },
  });

  assert.ok(app.knowledge.get(`memory.${memory.id}`), "memory should mirror into Knowledge Library");
  assert.ok(app.knowledge.get(`artifact.${artifact.id}`), "artifact should mirror into Knowledge Library");
  assert.ok(app.knowledge.list({ type: "skill" }).length > 0, "skills should mirror into Knowledge Library");
  assert.ok(
    app.knowledge.listEvidence({ knowledgeId: `memory.${memory.id}` }).length > 0,
    "mirrored memory should keep provenance evidence",
  );
  assert.ok(
    app.knowledge.listRevisions({ knowledgeId: `artifact.${artifact.id}` }).length > 0,
    "mirrored artifact should keep revision history",
  );

  const olderVisibleDocument = app.knowledge.create({
    type: "note",
    title: "Old visible vault note",
    body: "Visible library note",
    format: "markdown",
    tags: [],
    lifecycle: "active",
    metadata: {
      vaultPath: "OpenGrove/notes/old-visible.md",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let index = 0; index < 6; index += 1) {
    app.knowledge.create({
      type: "project_doc",
      title: `Hidden project doc ${index}`,
      body: "Hidden from the primary library tree",
      format: "markdown",
      tags: [],
      lifecycle: "active",
    });
  }
  assert.ok(
    listKnowledgeInventoryDocuments({ app, settings: {} } as unknown as BridgeState, 3).some(
      (document) => document.id === olderVisibleDocument.id,
    ),
    "knowledge inventory should filter visible documents before applying the limit",
  );

  const events = [];
  for await (const event of app.runTurn("Use the bottle visual direction.")) {
    events.push(event);
  }
  await kernel.dispose();

  const assembled = events.find((event) => event.type === "context.assembled");
  assert.ok(assembled && assembled.type === "context.assembled", "turn should assemble context");
  assert.ok(
    !assembled.context.items.some((item) => item.id === `knowledge.memory.${memory.id}`),
    "generic turns should not inject resolved memory knowledge unless the user explicitly adds it",
  );
  assert.ok(
    !assembled.context.items.some((item) => Array.isArray(item.data?.tags) && item.data.tags.includes("skill-file")),
    "generic context planning should not inject skill reference files unless a skill is explicit",
  );
  assert.ok(
    !app.knowledge
      .listDeliveries({ runId: assembled.runId })
      .some((delivery) => delivery.knowledgeId === `memory.${memory.id}` && delivery.mode === "prompt_snippet"),
    "generic turns should not record memory prompt delivery when no context was explicitly added",
  );
  assert.ok(
    events.some((event) => event.type === "turn.finished"),
    "Hermes Gateway kernel should finish the turn",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
