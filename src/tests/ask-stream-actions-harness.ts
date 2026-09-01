import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGrove } from "../app/create-opengrove.js";
import type { AgentCompactRequest, AgentEvent } from "../core.js";
import { appEnvName } from "../identity.js";
import { compactBackgroundAskSession, streamAskResponse } from "../server/ask-stream.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { LOGIN_PROVIDER_BINDING_ID, type BridgeAskPayload, type BridgeState } from "../server/bridge-types.js";
import { createWwRetryClaudeCliFixture, createWwRetryFixture } from "./harnesses/ww-retry-fixture.js";

async function main() {
  await assertAskProductionOrchestrationPersistsEachEventOnce();
  await assertAskProductionOrchestrationRecoversWwCredential();

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

async function assertAskProductionOrchestrationRecoversWwCredential(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-ask-production-ww-retry-"));
  const state = createBridgeState({ statePath: join(cwd, "state.sqlite") });
  const ww = await createWwRetryFixture();
  const cli = createWwRetryClaudeCliFixture(cwd);
  const model = "claude-opus-4-8";
  const runtimeModeEnv = appEnvName("CLAUDE_CODE_RUNTIME");
  const previousRuntimeMode = process.env[runtimeModeEnv];

  try {
    process.env[runtimeModeEnv] = "cli";
    state.kernel = "claude-code";
    state.model = model;
    state.settings = {
      ...state.settings,
      kernel: "claude-code",
      customProviders: [ww.provider(model)],
      modelProviderBindings: [{ modelId: model, providerId: "ww" }],
      kernelPathOverrides: {
        ...state.settings.kernelPathOverrides,
        "claude-code": { binaryPath: cli.path },
      },
    };
    state.kernelProviderId = "ww";
    state.kernelUnavailableReason = undefined;
    recreateBridgeApp(state);
    state.kernel = "claude-code";
    state.model = model;
    state.kernelProviderId = "ww";
    state.kernelUnavailableReason = undefined;

    const response = new HarnessServerResponse();
    await streamAskResponse(
      state,
      {
        question: "Recover the WW credential through the production Ask stream",
        model,
        kernel: "claude-code",
        providerId: "ww",
        threadId: "thread-production-ww-retry",
        snapshot: {},
        computerSnapshot: {},
        allowMemory: false,
        saveCandidateNote: false,
      },
      response as unknown as ServerResponse,
      { wwAuth: ww.auth },
    );

    const start = response.chunks
      .map((line) => JSON.parse(line) as { type?: string; runId?: string })
      .find((chunk) => chunk.type === "start");
    assert.ok(start?.runId);
    const events = state.app.events.list().filter((event) => event.runId === start.runId);
    assert.equal(
      cli.calls(),
      2,
      `the production Ask loop must retry after a safe WW key repair: ${JSON.stringify({
        ww: ww.counts(),
        chunks: response.chunks,
      })}`,
    );
    assert.deepEqual(ww.counts(), { list: 1, create: 1 });
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "turn.finished" && event.outcome.taskState === "TASK_STATE_FAILED"),
      false,
    );
    assert.equal(state.app.sessions.getRun(start.runId)?.lifecycle.taskState, "TASK_STATE_COMPLETED");
    assert.ok(events.some((event) => event.type === "runtime.diagnostic" && event.name === "ww.api_key.repaired"));
  } finally {
    if (previousRuntimeMode === undefined) delete process.env[runtimeModeEnv];
    else process.env[runtimeModeEnv] = previousRuntimeMode;
    await ww.close();
    await state.store.close?.();
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function assertAskProductionOrchestrationPersistsEachEventOnce(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-ask-production-persistence-"));
  const state = createBridgeState({ statePath: join(cwd, "state.sqlite") });
  try {
    const adapter = state.kernelAdapter;
    assert.ok(adapter, "the production Ask harness requires the selected Kernel adapter");
    state.kernelUnavailableReason = undefined;
    state.kernelProviderId = LOGIN_PROVIDER_BINDING_ID;
    state.settings.modelProviderBindings = [{ modelId: state.model, providerId: LOGIN_PROVIDER_BINDING_ID }];
    adapter.runTurn = async function* runHarnessTurn(request): AsyncIterable<AgentEvent> {
      const runId = request.runId ?? "missing-run-id";
      yield { type: "turn.started", runId, at: new Date().toISOString() };
      yield { type: "assistant.delta", runId, text: "production Ask answer" };
      yield { type: "model.response", runId, response: { text: "production Ask answer" } };
      yield {
        type: "turn.finished",
        runId,
        at: new Date().toISOString(),
        outcome: { taskState: "TASK_STATE_COMPLETED" },
      };
    };

    const response = new HarnessServerResponse();
    const payload: BridgeAskPayload = {
      question: "Run through the production Ask stream",
      model: state.model,
      kernel: state.kernel,
      providerId: state.kernelProviderId,
      threadId: "thread-production-persistence",
      snapshot: {},
      computerSnapshot: {},
      allowMemory: false,
      saveCandidateNote: false,
    };
    await streamAskResponse(state, payload, response as unknown as ServerResponse);
    const startChunk = response.chunks
      .map((line) => JSON.parse(line) as { type?: string; runId?: string })
      .find((chunk) => chunk.type === "start");
    assert.ok(startChunk?.runId, "the public Ask stream must expose its Run identity");
    const persisted = state.app.events.list().filter((event) => event.runId === startChunk.runId);
    assert.equal(
      persisted.filter((event) => event.type === "turn.started").length,
      1,
      "the production Ask owner must persist turn.started exactly once",
    );
    assert.equal(
      persisted.filter((event) => event.type === "turn.finished").length,
      1,
      "the production Ask owner must persist turn.finished exactly once",
    );
  } finally {
    await state.store.close?.();
    rmSync(cwd, { recursive: true, force: true });
  }
}

class HarnessServerResponse extends EventEmitter {
  readonly chunks: string[] = [];

  writeHead(): this {
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk.trim());
    return true;
  }

  end(): this {
    return this;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
