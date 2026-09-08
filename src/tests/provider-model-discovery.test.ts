import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllBridgeProviderProfiles } from "../server/provider-profiles.js";
import { readDiscoveredProviderModels, refreshProviderModelDiscovery } from "../server/provider-model-discovery.js";
import { withEnv } from "./env.js";

test("Google and DeepSeek discovery use their own endpoints and retain Gemini limits across cached reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrove-provider-discovery-"));
  try {
    await withEnv({ OPENGROVE_DATA_DIR: directory }, async () => {
      const profiles = getAllBridgeProviderProfiles(undefined)
        .filter((p) => p.id === "gemini" || p.id === "deepseek")
        .map((p) => ({ ...p, enabled: true, apiKey: "discovery-key" }));
      const google = profiles.find((p) => p.id === "gemini");
      const deepseek = profiles.find((p) => p.id === "deepseek");
      assert.ok(google && deepseek);
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) {
          assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "discovery-key");
          return Response.json(
            url.includes("pageToken=")
              ? { models: [{ name: "models/embedding-test", supportedGenerationMethods: ["embedContent"] }] }
              : {
                  models: [
                    {
                      name: "models/gemini-new",
                      displayName: "Gemini New",
                      inputTokenLimit: 1048576,
                      outputTokenLimit: 65536,
                      supportedGenerationMethods: ["generateContent"],
                    },
                  ],
                  nextPageToken: "next-page",
                },
          );
        }
        assert.equal(url, "https://api.deepseek.com/models");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer discovery-key");
        return Response.json({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-flash-vision-exp" }] });
      };
      await refreshProviderModelDiscovery({ profiles, fetchImpl, force: true });
      assert.equal(requests.length, 3);
      const models = readDiscoveredProviderModels(google);
      assert.equal(models?.length, 1);
      assert.equal(models?.[0]?.id, "gemini-new");
      assert.deepEqual(models?.[0]?.metadata, { contextWindow: 1048576, maxOutputTokens: 65536 });
      assert.deepEqual(
        readDiscoveredProviderModels(deepseek)?.map((m) => m.id),
        ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
