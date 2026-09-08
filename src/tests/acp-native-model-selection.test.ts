import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpCliRuntime } from "../runtime/acp-cli-runtime.js";
import { SessionStore, ApprovalInbox, QuestionInbox, type AgentContext, type AgentEvent } from "../core.js";
import { writeFakeAcpServer } from "./harnesses/fake-acp-server.js";

for (const modelOptionsApi of ["config", "legacy"] as const) {
  test(`ACP uses the advertised ${modelOptionsApi} selector on new, reused and loaded sessions`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "og-acp-model-alias-"));
    const script = join(cwd, "fake-acp.mjs");
    writeFakeAcpServer(script, {
      modelOptions: [{ value: "native-alias", name: "gemini-3.8-flash" }],
      modelConfigId: "engine",
      modelOptionsApi,
    });
    const context = {
      sessionId: "model-alias-test",
      sessions: new SessionStore(),
      approvals: new ApprovalInbox(),
      questions: new QuestionInbox(),
    } as AgentContext;
    for (const turns of [2, 1]) {
      const runtime = new AcpCliRuntime({
        kernelId: "kimi",
        title: "Kimi",
        command: process.execPath,
        acpArgs: [script],
        cwd,
        configuredModel: "gemini-3.8-flash",
        setModelFailure: "error",
      });
      try {
        for (let index = 0; index < turns; index++) {
          const events: AgentEvent[] = [];
          for await (const event of runtime.runTurn({
            input: "Reply OK",
            context,
            tools: [],
            skills: [],
            packs: [],
            capabilities: [],
          }))
            events.push(event);
          assert.deepEqual(
            events.filter((e) => e.type === "error"),
            [],
          );
          assert.ok(events.some((e) => e.type === "model.response"));
        }
      } finally {
        runtime.close();
      }
    }
  });
}
