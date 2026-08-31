import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAskPayload } from "../server/payloads.js";

test("ask payload keeps a conversation-scoped Provider route", () => {
  const payload = normalizeAskPayload({
    question: "hello",
    model: "gpt-5.6-sol",
    kernel: "codex",
    providerId: "ww",
    threadId: "thread-provider-scope",
    snapshot: {},
    computerSnapshot: {},
  });

  assert.equal(payload.kernel, "codex");
  assert.equal(payload.providerId, "ww");
});

test("blank Provider override falls back to the model default", () => {
  const payload = normalizeAskPayload({
    question: "hello",
    model: "gpt-5.6-sol",
    providerId: "   ",
    threadId: "thread-provider-auto",
    snapshot: {},
    computerSnapshot: {},
  });

  assert.equal(payload.providerId, undefined);
});
