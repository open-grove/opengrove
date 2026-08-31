import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistAskMediaArtifacts, rewriteMediaReferences } from "../server/ask-stream.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";

test("streamed answers replace embedded media bytes with an on-demand artifact URL", () => {
  const dataUri = `data:image/png;base64,${"a".repeat(2_000_000)}`;
  const rewritten = rewriteMediaReferences(
    `Generated image: ![result](${dataUri})`,
    new Map([[dataUri, "artifact 1"]]),
  );

  assert.equal(rewritten, "Generated image: ![result](/artifacts/artifact%201/content)");
  assert.ok(rewritten.length < 100);
});

test("Ask media artifacts are committed to root state before a rebuild", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-ask-media-root-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  const dataUri = "data:image/png;base64,cm9vdC1kdXJhYmxl";
  try {
    const artifactIds = persistAskMediaArtifacts(state, "draw", {
      type: "tool.finished",
      runId: "run-scoped-media",
      toolId: "image.generate",
      result: { ok: true, value: { imageUri: dataUri } },
    });
    assert.equal(artifactIds.length, 1);
    assert.equal(state.app.artifacts.get(artifactIds[0]!)?.data.uri, dataUri);

    recreateBridgeApp(state);
    assert.equal(
      state.app.artifacts.get(artifactIds[0]!)?.data.uri,
      dataUri,
      "a root rebuild must not lose a media artifact returned by a scoped Ask",
    );
  } finally {
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
