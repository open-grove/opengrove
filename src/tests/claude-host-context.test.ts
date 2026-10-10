import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SDKMessage, Query } from "@anthropic-ai/claude-agent-sdk";
import { createOpenGrove } from "../app/create-opengrove.js";
import { ClaudeAgentSdkRuntime } from "../runtime/claude-agent-sdk-runtime.js";

test("changed stable rules bypass old Claude snapshots until a confirmed compact boundary", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "opengrove-claude-snapshot-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const snapshots: (boolean | undefined)[] = [];
  const prompts: string[] = [];
  let turn = 0;
  const runtime = new ClaudeAgentSdkRuntime({
    cwd,
    query: ({ prompt, options }) => {
      const current = ++turn;
      const system = options?.systemPrompt;
      snapshots.push(typeof system === "object" && !Array.isArray(system) ? system.snapshot : undefined);
      prompts.push(typeof prompt === "string" ? prompt : "");
      const sessionId = options?.resume ?? options?.sessionId ?? "fixture";
      async function* messages(): AsyncGenerator<SDKMessage> {
        if (current === 2) {
          yield {
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: "00000000-0000-5000-8000-000000000001",
            session_id: sessionId,
          };
          yield {
            type: "system",
            subtype: "status",
            status: null,
            compact_result: "failed",
            compact_error: "fixture failure",
            uuid: "00000000-0000-5000-8000-000000000002",
            session_id: sessionId,
          };
        }
        if (current === 4) {
          yield {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 100 },
            uuid: "00000000-0000-5000-8000-000000000003",
            session_id: sessionId,
          };
        }
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "ok",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            fallback_credit: { status: { type: "not_applied", reason: "not_enabled" } },
            inference_geo: "test",
            iterations: [],
            output_tokens_details: { thinking_tokens: 0 },
            server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
            service_tier: "standard",
            speed: "standard",
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-5000-8000-000000000004",
          session_id: sessionId,
        };
      }
      // Only iterator/close are used here; context-usage/model inventory are optional telemetry.
      return Object.assign(messages(), { close() {} }) as unknown as Query;
    },
  });
  const app = createOpenGrove({ cwd, runtime, readPage: async () => ({}) });
  for (const rule of ["RULE_A", "RULE_B", "RULE_B", "RULE_B", "RULE_B"]) {
    for await (const event of app.runTurn("continue", {
      sessionInstructions: rule,
      hostState: [{ id: "room", text: "ROOM_CURRENT" }],
    })) {
      if (event.type === "error") assert.fail(event.message);
    }
  }
  assert.deepEqual(snapshots, [true, false, false, false, true]);
  assert.match(prompts[0]!, /ROOM_CURRENT/);
  assert.doesNotMatch(prompts[1]!, /ROOM_CURRENT/);
  assert.match(prompts[2]!, /ROOM_CURRENT/, "failed compaction invalidates the delivery receipt");
  assert.match(prompts[4]!, /ROOM_CURRENT/, "successful compaction restores full state next turn");
});
