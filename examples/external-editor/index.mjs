import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectOpenGrove } from "@opengrove/sdk";

const workspace = resolve(process.env.EDITOR_WORKSPACE ?? "project");
await mkdir(workspace, { recursive: true });
const file = resolve(workspace, "timeline.json");
try {
  await writeFile(file, JSON.stringify({ title: "Untitled", clips: [] }, null, 2), { flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const ui = createInterface({ input: stdin, output: stdout });
try {
  const op = await connectOpenGrove({
    baseUrl: process.env.OPENGROVE_BRIDGE_URL ?? "http://127.0.0.1:37371/api",
    token: process.env.OPENGROVE_BRIDGE_TOKEN,
  });
  const session = op.session({
    sessionId: process.env.EDITOR_SESSION_ID ?? `editor-${Date.now()}`,
    kernel: "codex",
    providerId: process.env.AGENT_PROVIDER ?? "$login",
    model: process.env.AGENT_MODEL ?? "gpt-6-astra",
    workspaceRoot: workspace,
    instructions:
      "Use client.renameTimeline for timeline edits. Do not edit the timeline with shell or file tools. Report whether the user approved the change.",
    tools: [
      {
        id: "client.renameTimeline",
        description: "Rename the timeline after the editor asks its user for approval.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
        async execute(input, { callId, signal }) {
          if (typeof input.title !== "string" || !input.title.trim()) return { ok: false, error: "title_required" };
          const choice = await ui.question(`Change timeline title to ${JSON.stringify(input.title)}? [y/N] `, {
            signal,
          });
          if (choice.toLowerCase() !== "y") return { ok: false, error: "user_rejected" };
          signal.throwIfAborted();
          const timeline = JSON.parse(await readFile(file, "utf8"));
          // Real products should persist a callId receipt atomically with their mutation.
          if (timeline.lastCallId !== callId) {
            timeline.title = input.title;
            timeline.lastCallId = callId;
            await writeFile(file, JSON.stringify(timeline, null, 2));
          }
          return { ok: true, value: { title: timeline.title } };
        },
      },
    ],
  });
  for (;;) {
    const input = await ui.question("You (empty to exit): ");
    if (!input.trim()) break;
    const timeline = JSON.parse(await readFile(file, "utf8"));
    const task = await session.run(input, { timeline });
    console.log(`Task: ${task.runId}`);
    const result = await task.wait({
      async onApproval(approval) {
        const choice = await ui.question(`${approval.title}: ${approval.reason} [y/N] `);
        return { decision: choice.toLowerCase() === "y" ? "approve" : "reject" };
      },
      async onQuestion(question) {
        return ui.question(`${question.prompt}\nAnswer: `);
      },
    });
    console.log(result.run.lifecycle.taskState, result.answer);
  }
} finally {
  ui.close();
}
