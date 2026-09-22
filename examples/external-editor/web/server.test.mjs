import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "./server.mjs";

test("editor protects the local companion and persists idempotent product actions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "opengrove-editor-"));
  let project,
    calls = 0;
  const host = createServer((request, response) => {
    assert.equal(request.headers["x-opengrove-token"], "private-host-token");
    calls++;
    response.setHeader("content-type", "application/json");
    if (request.url.endsWith("/tool-calls"))
      response.end(
        JSON.stringify({
          calls: [
            {
              id: "call-1",
              toolId: "client.renameTimeline",
              input: { title: "Summer" },
              status: "pending",
              deadlineAt: new Date(Date.now() + 10000).toISOString(),
            },
          ],
        }),
      );
    else response.end(JSON.stringify({ run: { sessionId: project.sessionId }, finalized: false }));
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const editor = await startEditor({
    port: 0,
    token: "private-host-token",
    workspace,
    hostUrl: `http://127.0.0.1:${host.address().port}/api`,
  });
  try {
    const headers = { "x-editor-client": "1", "content-type": "application/json" };
    assert.equal((await fetch(`${editor.url}/product/project`)).status, 403);
    assert.equal(
      (await fetch(`${editor.url}/product/project`, { headers: { ...headers, origin: "https://untrusted.example" } }))
        .status,
      403,
    );
    assert.equal((await fetch(`${editor.url}/api/settings`, { headers })).status, 404);
    assert.ok(!(await (await fetch(editor.url)).text()).includes("private-host-token"));
    project = await (await fetch(`${editor.url}/product/project`, { headers })).json();
    const submit = (title) =>
      fetch(`${editor.url}/product/rename`, {
        method: "POST",
        headers,
        body: JSON.stringify({ runId: "run-1", callId: "call-1", title }),
      });
    const results = await Promise.all([submit("Summer"), submit("Summer")]);
    assert.deepEqual(await Promise.all(results.map((result) => result.json())), [
      { ok: true, value: { title: "Summer" } },
      { ok: true, value: { title: "Summer" } },
    ]);
    assert.equal(calls, 2, "same call is verified and applied only once");
    assert.equal((await submit("Different")).status, 400);
    const saved = JSON.parse(await readFile(join(workspace, "timeline.json"), "utf8"));
    assert.equal(saved.title, "Summer");
    assert.equal(Object.keys(saved.receipts).length, 1);
    await new Promise((resolve) => editor.server.close(resolve));
    const reopened = await startEditor({ port: 0, workspace, hostUrl: `http://127.0.0.1:${host.address().port}/api` });
    try {
      const restored = await (await fetch(`${reopened.url}/product/project`, { headers })).json();
      assert.equal(restored.title, "Summer");
      assert.equal(restored.sessionId, project.sessionId);
    } finally {
      await new Promise((resolve) => reopened.server.close(resolve));
    }
  } finally {
    if (editor.server.listening) await new Promise((resolve) => editor.server.close(resolve));
    await new Promise((resolve) => host.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
