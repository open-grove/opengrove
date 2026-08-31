import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_STREAM_RESPONSE_HEADERS } from "../server/ask-stream.js";

test("ask stream tells reverse proxies not to buffer or compress chunks", () => {
  assert.equal(ASK_STREAM_RESPONSE_HEADERS["x-accel-buffering"], "no");
  assert.equal(ASK_STREAM_RESPONSE_HEADERS["content-encoding"], "identity");
  assert.match(ASK_STREAM_RESPONSE_HEADERS["cache-control"], /no-transform/);
});
