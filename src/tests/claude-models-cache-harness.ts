import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readClaudeModelsCache,
  resolveClaudeEffortLevels,
  writeClaudeModelsCache,
} from "../runtime/claude-models-cache.js";
import { withEnv } from "./env.js";

const dir = mkdtempSync(resolve(tmpdir(), "og-models-cache-"));
try {
  // Regression: the SDK's supportedModels() keys each ModelInfo by `value`, NOT `id`.
  // A previous build read `model.id`, dropped every entry, and stranded the composer on
  // its static effort fallback (no reasoning picker ever appeared). This shape mirrors the
  // real Bedrock RPC capture.
  writeClaudeModelsCache(
    [
      { value: "default", displayName: "Default" },
      {
        value: "opus",
        displayName: "Opus 4.1",
        description: "Opus 4.1 · Legacy",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"],
      },
      {
        value: "us.anthropic.claude-opus-4-7",
        displayName: "Opus",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "us.anthropic.claude-sonnet-4-6",
        displayName: "Sonnet",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"],
      },
    ],
    { configHome: dir, now: "2026-06-11T00:00:00.000Z" },
  );

  const cache = readClaudeModelsCache(dir);
  assert.equal(cache.length, 4, "all four models (incl. value-keyed + legacy) must persist");

  // The legacy entry is cached (so a pinned legacy model can still resolve effort) but flagged.
  const legacy = cache.find((m) => m.id === "opus");
  assert.equal(legacy?.legacy, true, "models described as Legacy must be flagged in the cache");

  const opus = cache.find((m) => m.id === "us.anthropic.claude-opus-4-7");
  assert.ok(opus, "value field must be accepted as the model id");
  assert.deepEqual(opus?.supportedEffortLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(opus?.label, "Opus");

  // Exact match wins.
  assert.deepEqual(resolveClaudeEffortLevels(cache, "us.anthropic.claude-opus-4-7"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  // Unknown id (e.g. a custom Bedrock alias the SDK doesn't enumerate) falls back to the
  // first model that supports effort, so the picker still appears.
  const fallback = resolveClaudeEffortLevels(cache, "global.anthropic.claude-opus-4-8");
  assert.ok(fallback.length > 0, "unknown model id must fall back to any supporting model");
  assert.ok(fallback.includes("max"), "fallback effort levels must include max");

  // `id` shape (legacy) is still accepted for forward/backward compatibility.
  const legacyDir = mkdtempSync(resolve(tmpdir(), "og-models-cache-legacy-"));
  try {
    writeClaudeModelsCache([{ id: "legacy-model", supportsEffort: true, supportedEffortLevels: ["low", "high"] }], {
      configHome: legacyDir,
      now: "2026-06-11T00:00:00.000Z",
    });
    const legacy = readClaudeModelsCache(legacyDir);
    assert.equal(legacy.length, 1, "legacy id-keyed shape must still persist");
    assert.equal(legacy[0]?.id, "legacy-model");
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }

  // Missing cache → empty list (conservative, picker hidden).
  const emptyDir = mkdtempSync(resolve(tmpdir(), "og-models-cache-empty-"));
  try {
    assert.deepEqual(readClaudeModelsCache(emptyDir), []);
    assert.deepEqual(resolveClaudeEffortLevels([], "anything"), []);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  // Dropdown integration: when the SDK cache is present, the Claude native profile's model
  // list must mirror it (so the composer dropdown matches Claude Code / VS Code), with the
  // user-pinned model surfaced first. When the cache is absent, the profile falls back to the
  // legacy env-derived family aliases without going empty.
  const isolatedHome = mkdtempSync(resolve(tmpdir(), "og-models-cache-home-"));
  try {
    await withEnv({ HOME: isolatedHome }, async () => {
      const { readKernelLocalRouteProfile } = await import("../server/kernel-registry.js");

      const cachedProfile = readKernelLocalRouteProfile("claude-code", { configHome: dir });
      assert.ok(cachedProfile, "claude-code native profile must resolve");
      const cachedIds = cachedProfile.models.map((m: { id: string }) => m.id);
      assert.ok(
        cachedIds.includes("us.anthropic.claude-opus-4-7"),
        "cache-backed dropdown must surface SDK registry models",
      );
      assert.ok(
        cachedProfile.models.every((m: { id: string }) => m.id !== "default"),
        "the 'default' sentinel must not appear in the dropdown",
      );
      assert.ok(
        cachedProfile.models.every((m: { id: string }) => m.id !== "opus"),
        "legacy models (Opus 4.1 · Legacy) must be hidden from the dropdown, matching VS Code",
      );

      const fallbackDir = mkdtempSync(resolve(tmpdir(), "og-models-cache-fallback-"));
      try {
        const fallbackProfile = readKernelLocalRouteProfile("claude-code", { configHome: fallbackDir });
        assert.ok(
          (fallbackProfile?.models.length ?? 0) > 0,
          "missing cache must fall back to env-derived models, never empty",
        );
      } finally {
        rmSync(fallbackDir, { recursive: true, force: true });
      }

      // Pinned models from BOTH sources must survive even when the SDK registry doesn't enumerate
      // them. Regression: a prior build only honored env.ANTHROPIC_MODEL and silently dropped the
      // settings.json `model` field, so a user's pinned Opus 4.8[1m] vanished from the dropdown.
      const pinnedDir = mkdtempSync(resolve(tmpdir(), "og-models-cache-pinned-"));
      try {
        writeFileSync(
          resolve(pinnedDir, "settings.json"),
          JSON.stringify({
            env: { ANTHROPIC_MODEL: "global.anthropic.claude-fable-5" },
            model: "us.anthropic.claude-opus-4-8[1m]",
          }),
          "utf8",
        );
        writeClaudeModelsCache(
          [
            {
              value: "us.anthropic.claude-sonnet-4-6",
              displayName: "Sonnet",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
            },
          ],
          { configHome: pinnedDir, now: "2026-06-11T00:00:00.000Z" },
        );
        const pinnedProfile = readKernelLocalRouteProfile("claude-code", { configHome: pinnedDir, cwd: pinnedDir });
        const pinnedIds = (pinnedProfile?.models ?? []).map((m: { id: string }) => m.id);
        assert.ok(
          pinnedIds.includes("global.anthropic.claude-fable-5"),
          "env.ANTHROPIC_MODEL pin (Fable) must survive in the dropdown",
        );
        assert.ok(
          pinnedIds.includes("us.anthropic.claude-opus-4-8[1m]"),
          "settings.json model pin (Opus 4.8 1M) must survive in the dropdown",
        );
      } finally {
        rmSync(pinnedDir, { recursive: true, force: true });
      }
    });
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }

  console.log("claude-models-cache-harness ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
