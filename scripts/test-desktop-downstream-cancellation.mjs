import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-downstream-cancellation-"));
const bundlePath = join(tempDir, "downstream-cancellation.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "downstream-cancellation.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundlePath,
  });
  const { createDownstreamCancellation } = await import(pathToFileURL(bundlePath).href);

  // 下游放弃请求的两个出口都要中止上游：request.signal（规范里的那条，Electron 实测不触发）
  // 与响应体被取消（Chromium 实际走的那条）。漏掉任何一条，被放弃的请求都会一直占着主进程
  // 到 Bridge 的连接不归还，同源满 6 条之后所有新请求都发不出去。
  const abandonedUpstream = new AbortController();
  const viaRequestSignal = createDownstreamCancellation(abandonedUpstream.signal);
  assert.equal(viaRequestSignal.signal.aborted, false);
  abandonedUpstream.abort(new Error("renderer abandoned the request"));
  assert.equal(
    viaRequestSignal.signal.aborted,
    true,
    "upstream must become aborted synchronously once the downstream signal aborts",
  );
  assert.equal(viaRequestSignal.signal.reason.message, "renderer abandoned the request");

  const viaBodyCancel = createDownstreamCancellation(new AbortController().signal);
  const endless = viaBodyCancel.cancelable(
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
      { status: 206 },
    ),
  );
  assert.equal(viaBodyCancel.signal.aborted, false);
  await endless.body.cancel();
  assert.equal(
    viaBodyCancel.signal.aborted,
    true,
    "upstream must be aborted after the downstream stops reading the response body",
  );

  // 已经放弃的请求不许再发出一条拉不回来的上游请求。
  assert.equal(createDownstreamCancellation(AbortSignal.abort(new Error("already gone"))).signal.aborted, true);

  // 包一层不许改变响应内容与状态。
  const passthrough = createDownstreamCancellation(new AbortController().signal);
  const passthroughHeaders = new Headers({
    "content-range": "bytes 10-19/36",
    "content-type": "video/mp4",
  });
  passthroughHeaders.append("set-cookie", "opengrove_auth_access=fresh; Path=/; HttpOnly");
  passthroughHeaders.append("set-cookie", "opengrove_auth_refresh=saved; Path=/; HttpOnly");
  const streamed = passthrough.cancelable(
    new Response("bridge-first|bridge-second:完成", {
      status: 206,
      statusText: "Partial Content",
      headers: passthroughHeaders,
    }),
  );
  assert.equal(streamed.status, 206);
  assert.equal(streamed.statusText, "Partial Content");
  assert.equal(streamed.headers.get("content-range"), "bytes 10-19/36");
  assert.equal(streamed.headers.get("content-type"), "video/mp4");
  assert.deepEqual(
    streamed.headers.getSetCookie(),
    ["opengrove_auth_access=fresh; Path=/; HttpOnly", "opengrove_auth_refresh=saved; Path=/; HttpOnly"],
    "response rewrapping must not merge or drop multiple Set-Cookie headers",
  );
  assert.equal(await streamed.text(), "bridge-first|bridge-second:完成");

  // 背压要留给上游：下游只读一块，不许把整段响应先抽进主进程内存。
  const chunkCount = 5;
  let pulled = 0;
  const lazy = createDownstreamCancellation(new AbortController().signal);
  const throttled = lazy.cancelable(
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          if (pulled >= chunkCount) controller.close();
          else controller.enqueue(new Uint8Array([pulled]));
        },
      }),
    ),
  );
  const firstChunk = await throttled.body.getReader().read();
  assert.deepEqual(Array.from(firstChunk.value), [1]);
  assert.ok(
    pulled < chunkCount,
    `reading one chunk pulled ${pulled}/${chunkCount} chunks; backpressure was not propagated upstream`,
  );

  // 这些状态码不允许带 body，原样交回去；拿它们去构造带 body 的 Response 会直接抛错。
  for (const status of [204, 304]) {
    const emptied = createDownstreamCancellation(new AbortController().signal);
    const upstream = new Response(null, { status });
    assert.equal(emptied.cancelable(upstream), upstream, `${status} responses must be returned as-is`);
  }

  console.log("desktop-downstream-cancellation harness ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
