import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentCompactRequest } from "../core.js";
import { compactBackgroundAskSession } from "../server/ask-stream.js";
import type { BridgeState } from "../server/bridge-types.js";

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-ask-stream-actions-"));
  let saved = false;
  let compactRequest: AgentCompactRequest | undefined;
  const app = createOpenGrove({
    cwd,
    readPage: async () => ({}),
    runtime: {
      async *runTurn() {
        yield* [];
      },
      async compactSession(request) {
        compactRequest = request;
        return { ok: true, compacted: true };
      },
    },
  });
  const state = {
    app,
    store: {
      saveFrom(value: unknown) {
        assert.equal(value, app);
        saved = true;
      },
    },
  } as unknown as BridgeState;

  const result = await compactBackgroundAskSession(state, {
    threadId: "thread-compact-harness",
    reason: "harness",
  });
  assert.deepEqual(result, { ok: true, compacted: true });
  assert.equal(compactRequest?.threadId, "thread-compact-harness");
  assert.equal(compactRequest?.reason, "harness");
  assert.equal(saved, true);

  const events = app.events.list();
  assert.ok(events.some((event) => event.type === "compaction.started"));
  assert.ok(events.some((event) => event.type === "compaction.finished"));

  const failing = await compactBackgroundAskSession(state, { threadId: "" });
  assert.deepEqual(failing, { ok: false, compacted: false, error: "thread_id_required" });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
