import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentTurnOptions } from "../app/create-opengrove.js";
import type { AgentEvent } from "../core.js";
import { createBridgeState } from "../server/bridge-state.js";
import { directAskExecutionStateKey } from "../server/ask-execution-state.js";
import { submitDirectRun, streamExistingAskResponse } from "../server/ask-stream.js";
import type { BridgeAskPayload, BridgeState } from "../server/bridge-types.js";

class ResponseSink extends EventEmitter {
  writeHead() {
    return this;
  }
  flushHeaders() {}
  write() {
    return true;
  }
  end() {
    return this;
  }
}

test("direct sessions persist native resume metadata across runs and state reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-session-"));
  const state = createBridgeState({ profile: "test", modules: [], statePath: join(root, "state.sqlite") });
  const scopedApp = createOpenGrove({ readPage: () => ({}), cwd: root, runtime: { async *runTurn() {} } });
  const scoped: BridgeState = { ...state, rootState: state, app: scopedApp, kernelUnavailableReason: undefined };
  scoped.settings = { ...state.settings, workspaceRoot: root };
  const seen: unknown[] = [];
  scopedApp.runTurn = async function* (_input: string, options: AgentTurnOptions = {}): AsyncIterable<AgentEvent> {
    const sessionId = options.sessionId!;
    const metadata = scopedApp.sessions.get(sessionId)?.metadata ?? {};
    seen.push(metadata.acpSessionIds);
    scopedApp.sessions.ensureSession({
      id: sessionId,
      metadata: { ...metadata, acpSessionIds: { "kimi:native": "native-session-123" } },
    });
    yield { type: "turn.started", runId: options.runId!, at: new Date().toISOString() };
    yield { type: "model.response", runId: options.runId!, response: { text: "Done" } };
    yield {
      type: "turn.finished",
      runId: options.runId!,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  state.directAskExecutionStates = new Map([
    [
      directAskExecutionStateKey({ kernel: "kimi", model: "test-model", providerId: "$login", workspaceRoot: root }),
      scoped,
    ],
  ]);
  const payload: BridgeAskPayload = {
    kernel: "kimi",
    model: "test-model",
    providerId: "$login",
    workspaceRoot: root,
    clientTools: [],
    threadId: "product-session",
    question: "Continue",
    snapshot: {},
    computerSnapshot: {},
    allowMemory: false,
    saveCandidateNote: false,
  };
  try {
    for (let turn = 0; turn < 2; turn++) {
      const run = submitDirectRun(state, payload);
      await streamExistingAskResponse(state, { runId: run.runId }, new ResponseSink() as unknown as ServerResponse);
      assert.deepEqual(state.app.sessions.get(payload.threadId)?.metadata?.acpSessionIds, {
        "kimi:native": "native-session-123",
      });
    }
    assert.deepEqual(seen, [undefined, { "kimi:native": "native-session-123" }]);
    const restored = createOpenGrove({ readPage: () => ({}), cwd: root, runtime: { async *runTurn() {} } });
    state.store.loadInto(restored);
    assert.deepEqual(restored.sessions.get(payload.threadId)?.metadata?.acpSessionIds, {
      "kimi:native": "native-session-123",
    });
    assert.ok(restored.sessions.get(payload.threadId)?.metadata?.integrationSession);
  } finally {
    await state.store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
