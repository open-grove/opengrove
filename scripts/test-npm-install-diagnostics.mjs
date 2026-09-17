import assert from "node:assert/strict";
import { summarizeNpmDiagnostics } from "./npm-install-diagnostics.mjs";
const raw = `1 http fetch GET 200 https://registry.npmjs.org/example/-/example-1.0.0.tgz?token=private-token 900ms (cache miss)
2 timing reifyNode:node_modules/example Completed in 950ms
3 info run example@1.0.0 postinstall node_modules/example node install.js
4 http fetch GET 401 https://person:private-password@private.example/pkg 300ms
5 verbose config apiKey=private-key
6 timing config:load:file:/private/home/.npmrc Completed in 1ms`;
const result = summarizeNpmDiagnostics(
  [raw],
  [
    JSON.stringify({
      timers: { "reify:loadTrees": 70 },
      unfinishedTimers: { "reifyNode:node_modules/native-addon": [100, 300] },
      metadata: { token: "private-metadata" },
    }),
    "incomplete JSON",
  ],
);
assert.equal(result.events[0].resource, "/example/-/example-1.0.0.tgz");
assert.equal(result.events[0].durationMs, 900);
assert.equal(result.events[1].name, "reifyNode:node_modules/example");
assert.equal(result.events[2].package, "example@1.0.0");
assert.equal(result.events[3].resource, "external-registry");
assert.equal(result.incompleteTimingReports, 1);
assert.deepEqual(result.unfinishedTimers, ["reifyNode:node_modules/native-addon"]);
assert.ok(!JSON.stringify(result).includes("private"));
assert.ok(!JSON.stringify(result).includes("token"));
console.log("npm install diagnostics preserve phases without raw credentials or paths");
