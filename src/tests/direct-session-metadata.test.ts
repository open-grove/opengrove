import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenGrove, type AgentTurnOptions } from "../app/create-opengrove.js";
import type { AgentEvent } from "../core.js";
import { createBridgeState } from "../server/bridge-state.js";
import { directAskExecutionStateKey } from "../server/ask-execution-state.js";
import { streamAskResponse } from "../server/ask-stream.js";
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

// Adapted from PR #126's direct-session regression; it exercises the existing streaming API.
test("direct scoped execution persists native resume metadata in the authoritative store", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengrove-direct-resume-"));
  const state = createBridgeState({
    profile: "test",
    statePath: join(root, "state.sqlite"),
  });
  state.settings = { ...state.settings, workspaceRoot: root };
  const scopedApp = createOpenGrove({
    readPage: () => ({}),
    cwd: root,
    runtime: { async *runTurn() {} },
  });
  const scoped: BridgeState = {
    ...state,
    rootState: state,
    app: scopedApp,
    kernelUnavailableReason: undefined,
  };
  scopedApp.runTurn = async function* (_input: string, options: AgentTurnOptions = {}): AsyncIterable<AgentEvent> {
    scopedApp.sessions.ensureSession({
      id: options.sessionId!,
      metadata: { acpSessionIds: { "kimi:native": "native-session-123" } },
    });
    yield {
      type: "turn.started",
      runId: options.runId!,
      at: new Date().toISOString(),
    };
    yield {
      type: "model.response",
      runId: options.runId!,
      response: { text: "Done" },
    };
    yield {
      type: "turn.finished",
      runId: options.runId!,
      at: new Date().toISOString(),
      outcome: { taskState: "TASK_STATE_COMPLETED" },
    };
  };
  state.directAskExecutionStates = new Map([
    [
      directAskExecutionStateKey({
        kernel: "kimi",
        model: "test-model",
        providerId: "$login",
        workspaceRoot: root,
      }),
      scoped,
    ],
  ]);
  const payload: BridgeAskPayload = {
    kernel: "kimi",
    model: "test-model",
    providerId: "$login",
    threadId: "product-session",
    question: "Continue",
    snapshot: {},
    computerSnapshot: {},
    allowMemory: false,
    saveCandidateNote: false,
  };
  try {
    await streamAskResponse(state, payload, new ResponseSink() as unknown as ServerResponse);
    assert.deepEqual(state.app.sessions.get(payload.threadId)?.metadata?.acpSessionIds, {
      "kimi:native": "native-session-123",
    });
    const restored = createOpenGrove({
      readPage: () => ({}),
      cwd: root,
      runtime: { async *runTurn() {} },
    });
    state.store.loadInto(restored);
    assert.deepEqual(restored.sessions.get(payload.threadId)?.metadata?.acpSessionIds, {
      "kimi:native": "native-session-123",
    });
  } finally {
    await state.store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
