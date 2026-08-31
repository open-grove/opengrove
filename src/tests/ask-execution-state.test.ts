import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAskExecutionState } from "../server/ask-execution-state.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { disposeBridgeKernelWorkers } from "../server/kernel-lifecycle.js";
import { resolveKernelProviderSelection } from "../server/kernel-utils.js";

test("direct Ask uses explicit runtime overrides without mutating settings and reuses its execution state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-direct-ask-runtime-"));
  const state = createBridgeState({ statePath: join(directory, "state.sqlite") });
  try {
    state.settings.workspaceRoot = directory;
    state.settings.kernelPathOverrides.hermes = { binaryPath: process.execPath };
    state.settings.customProviders = [
      {
        id: "model-default",
        name: "Model default",
        protocol: "openai-compatible",
        openaiBaseUrl: "https://model-default.example/v1",
        apiKey: "test-model-default-key",
        credentialKind: "api-key",
        modelsPinned: false,
        models: [{ id: "runtime-model", label: "Runtime model" }],
      },
      {
        id: "conversation-provider",
        name: "Conversation Provider",
        protocol: "openai-compatible",
        openaiBaseUrl: "https://conversation-provider.example/v1",
        apiKey: "test-conversation-provider-key",
        credentialKind: "api-key",
        modelsPinned: false,
        models: [{ id: "runtime-model", label: "Runtime model" }],
      },
    ];
    state.settings.modelProviderBindings = [
      {
        modelId: "runtime-model",
        providerId: "model-default",
      },
    ];
    const originalKernelSetting = state.settings.kernel;
    const originalModelBindings = structuredClone(state.settings.modelProviderBindings);
    const request = {
      kernel: "hermes" as const,
      model: "runtime-model",
      providerId: "conversation-provider",
    };

    const first = resolveAskExecutionState(state, request);
    const second = resolveAskExecutionState(state, request);

    assert.equal(second, first, "the same direct runtime boundary should reuse its App and adapter");
    assert.equal(state.directAskExecutionStates?.size, 1);
    assert.deepEqual(first.runtimeOverride, {
      kernel: "hermes",
      model: "runtime-model",
      providerOverride: { providerId: "conversation-provider" },
    });
    assert.equal(first.kernelAdapter, second.kernelAdapter);
    assert.equal(resolveKernelProviderSelection(first, "hermes").route.source, "runtime");
    assert.equal(resolveKernelProviderSelection(first, "hermes").route.providerId, "conversation-provider");
    assert.equal(state.settings.kernel, originalKernelSetting);
    assert.deepEqual(state.settings.modelProviderBindings, originalModelBindings);

    const modelDefault = resolveAskExecutionState(state, {
      kernel: "hermes",
      model: "runtime-model",
    });
    assert.notEqual(modelDefault, first, "a different Provider boundary must not share execution state");
    assert.equal(resolveKernelProviderSelection(modelDefault, "hermes").route.source, "model");
    assert.equal(state.directAskExecutionStates?.size, 2);

    recreateBridgeApp(state);
    assert.equal(state.directAskExecutionStates?.size, 0, "settings rebuilds must invalidate direct runtime states");
  } finally {
    await disposeBridgeKernelWorkers(state);
    await state.store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
