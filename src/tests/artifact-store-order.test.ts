import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactRecord } from "../core.js";
import { ArtifactStore } from "../core/stores/artifact-store.js";

test("artifact lists use a deterministic newest-first order", () => {
  const store = new ArtifactStore();
  store.restore([
    artifact("artifact-b", "2026-08-04T00:00:00.000Z"),
    artifact("artifact-a", "2026-08-04T00:00:00.000Z"),
    artifact("artifact-new", "2026-08-05T00:00:00.000Z"),
  ]);

  assert.deepEqual(
    store.list({ limit: 2 }).map((item) => item.id),
    ["artifact-new", "artifact-b"],
  );
});

test("artifact media URI index stays current across every store mutation", () => {
  const store = new ArtifactStore();
  store.restore([artifact("restored", "2026-08-04T00:00:00.000Z", "data:image/png;base64,cmVzdG9yZWQ=")]);
  assert.equal(store.findByMediaUri("data:image/png;base64,cmVzdG9yZWQ=")?.id, "restored");

  store.update("restored", { data: { uri: "data:image/png;base64,dXBkYXRlZA==" } });
  assert.equal(store.findByMediaUri("data:image/png;base64,cmVzdG9yZWQ="), undefined);
  assert.equal(store.findByMediaUri("data:image/png;base64,dXBkYXRlZA==")?.id, "restored");

  store.delete("restored");
  assert.equal(store.findByMediaUri("data:image/png;base64,dXBkYXRlZA=="), undefined);
});

function artifact(id: string, updatedAt: string, uri?: string): ArtifactRecord {
  return {
    id,
    type: "text",
    title: id,
    tags: [],
    data: uri === undefined ? {} : { uri },
    createdAt: updatedAt,
    updatedAt,
  };
}
