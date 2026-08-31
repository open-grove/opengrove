import assert from "node:assert/strict";
import test from "node:test";
import { presentArtifactSummary } from "../server/artifact-presentation.js";

test("artifact lists omit embedded payloads while preserving display metadata", () => {
  const summary = presentArtifactSummary({
    id: "artifact-1",
    type: "image",
    title: "Result",
    tags: [],
    data: {
      fileName: "result.png",
      imageUri: "data:image/png;base64,c21hbGw=",
      privatePayload: "x".repeat(1_000_000),
    },
    assets: [{ kind: "image", uri: `data:image/png;base64,${"a".repeat(1_000_000)}`, title: "result.png" }],
    preview: { title: "Result", imageUri: `data:image/png;base64,${"b".repeat(1_000_000)}` },
    provenance: {
      createdBy: "test",
      credential: "should-not-leak",
      signature: "should-not-leak",
    },
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  });

  assert.equal(summary.data.fileName, "result.png");
  assert.equal(summary.data.imageUri, undefined);
  assert.equal(summary.data.privatePayload, undefined);
  assert.equal(summary.assets?.[0]?.uri, undefined);
  assert.equal(summary.preview?.imageUri, undefined);
  assert.equal(summary.provenance?.credential, "[redacted]");
  assert.equal(summary.provenance?.signature, "[redacted]");
  assert.doesNotMatch(JSON.stringify(summary), /should-not-leak/);
  assert.ok(JSON.stringify(summary).length < 5_000);
});
