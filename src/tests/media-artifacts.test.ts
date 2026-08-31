import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactStore } from "../core/stores/artifact-store.js";
import { extractMediaArtifactsFromEvents } from "../server/media-artifacts.js";

test("media extraction uses the store URI index without duplicating artifacts", () => {
  const artifacts = new ArtifactStore();
  artifacts.create({
    id: "existing",
    type: "image",
    title: "Existing",
    tags: [],
    data: { uri: "data:image/png;base64,ZXhpc3Rpbmc=" },
  });
  const events = [
    {
      type: "tool.finished" as const,
      runId: "run-1",
      toolId: "image.generate",
      result: {
        ok: true as const,
        value: { imageUri: "data:image/png;base64,bmV3" },
      },
    },
  ];

  const first = extractMediaArtifactsFromEvents({ artifacts, question: "draw", events });
  const second = extractMediaArtifactsFromEvents({ artifacts, question: "draw", events });
  assert.equal(first.length, 1);
  assert.deepEqual(second, first, "a later run should resolve the freshly created artifact from the store index");
  assert.equal(artifacts.list().length, 2);
});
