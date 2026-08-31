import assert from "node:assert/strict";
import type { AgentEvent, JsonValue } from "../core.js";
import { ArtifactStore } from "../core/stores/artifact-store.js";
import { toSafeJsonValue, visitSafeJsonValues } from "../core/safe-json.js";
import { asJsonValue as toCodexJsonValue } from "../runtime/codex/json.js";
import { toJsonValue as toHermesJsonValue } from "../runtime/hermes/json.js";
import { stripUndefined } from "../server/kernel-utils.js";
import { extractMediaArtifactsFromEvents } from "../server/media-artifacts.js";

const CIRCULAR_MARKER = "[omitted circular reference]";
const DEPTH_MARKER = "[omitted beyond depth limit]";
const NODE_MARKER = "[omitted after node limit]";

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

assert.deepEqual(toCodexJsonValue(cyclic), { self: CIRCULAR_MARKER });
assert.deepEqual(toHermesJsonValue(cyclic), { self: CIRCULAR_MARKER });
assert.deepEqual(stripUndefined(cyclic), { self: CIRCULAR_MARKER });
assert.deepEqual(toCodexJsonValue({ missing: undefined }), { missing: null });
assert.deepEqual(toHermesJsonValue({ missing: undefined }), {});
assert.deepEqual(stripUndefined({ missing: undefined }), {});
assert.equal(JSON.stringify(stripUndefined({ items: [undefined] })), '{"items":[null]}');
assert.deepEqual(toCodexJsonValue([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]), [
  null,
  null,
  null,
]);

const invalidLengthArray = new Proxy([], {
  get(target, key, receiver) {
    if (key === "length") return -1;
    return Reflect.get(target, key, receiver);
  },
});
assert.equal(toSafeJsonValue(invalidLengthArray), "[omitted unreadable property]");

const throwingStringValue = Object.assign(() => undefined, {
  [Symbol.toPrimitive]() {
    throw new Error("string conversion exploded");
  },
});
assert.equal(toHermesJsonValue(throwingStringValue), "[omitted unreadable property]");

const throwingGetter = Object.defineProperty({}, "secret", {
  enumerable: true,
  get() {
    throw new Error("getter exploded");
  },
});
assert.deepEqual(toSafeJsonValue(throwingGetter), {
  secret: "[omitted unreadable property]",
});
assert.doesNotThrow(() => {
  visitSafeJsonValues(throwingGetter, ({ value }) => {
    if (value && typeof value === "object") {
      void (value as Record<string, unknown>).secret;
    }
  });
});

const throwingEnumerator = new Proxy(
  {},
  {
    ownKeys() {
      throw new Error("enumeration exploded");
    },
  },
);
assert.equal(toSafeJsonValue(throwingEnumerator), "[omitted unreadable property]");
assert.doesNotThrow(() => visitSafeJsonValues(throwingEnumerator, () => undefined));

const shared = { value: 1 };
assert.deepEqual(toCodexJsonValue({ left: shared, right: shared }), {
  left: { value: 1 },
  right: { value: 1 },
});

let deeplyNested: Record<string, unknown> = { value: "unreachable" };
for (let index = 0; index < 80; index += 1) {
  deeplyNested = { child: deeplyNested };
}
assert.match(JSON.stringify(toCodexJsonValue(deeplyNested)), /\[omitted beyond depth limit\]/);

const wide = toCodexJsonValue(Array.from({ length: 10_100 }, (_, index) => index));
assert.ok(Array.isArray(wide));
assert.equal(wide.length, 10_100);
assert.equal(wide.at(-1), 10_099);

const explicitlyLimitedWide = toSafeJsonValue(
  Array.from({ length: 10_100 }, (_, index) => index),
  { maxNodes: 10_000 },
);
assert.ok(Array.isArray(explicitlyLimitedWide));
assert.equal(explicitlyLimitedWide.length, 10_000);
assert.equal(explicitlyLimitedWide.at(-1), NODE_MARKER);

let visitedNodes = 0;
visitSafeJsonValues(
  Array.from({ length: 20_000 }, (_, index) => index),
  () => {
    visitedNodes += 1;
  },
);
assert.equal(visitedNodes, 20_001);

let explicitlyLimitedNodes = 0;
visitSafeJsonValues(
  Array.from({ length: 20_000 }, (_, index) => index),
  () => {
    explicitlyLimitedNodes += 1;
  },
  { maxNodes: 10_000 },
);
assert.equal(explicitlyLimitedNodes, 10_000);

const events = [
  {
    type: "tool.finished",
    runId: "safe-json-run",
    toolId: "safe-json-tool",
    result: { ok: true, value: cyclic as JsonValue },
  },
] as AgentEvent[];
assert.deepEqual(
  extractMediaArtifactsFromEvents({
    artifacts: new ArtifactStore(),
    question: "",
    events,
  }),
  [],
);

const largeResultArtifacts = new ArtifactStore();
const largeResultEvents = [
  {
    type: "tool.finished",
    runId: "large-result-run",
    toolId: "room.ledger.read",
    result: {
      ok: true,
      value: [...Array.from({ length: 10_050 }, () => null), { path: "/tmp/after-legacy-node-limit/image.png" }],
    },
  },
] as AgentEvent[];
assert.equal(
  extractMediaArtifactsFromEvents({
    artifacts: largeResultArtifacts,
    question: "",
    events: largeResultEvents,
  }).length,
  1,
);
assert.equal(largeResultArtifacts.list()[0]?.data?.uri, "/tmp/after-legacy-node-limit/image.png");
assert.equal(
  largeResultArtifacts.list()[0]?.title,
  "image.png",
  "generated media uses the source filename instead of an unreachable language-specific kind fallback",
);

assert.equal(JSON.stringify(toHermesJsonValue(deeplyNested)).includes(DEPTH_MARKER), true);

console.log("safe-json-harness ok");
