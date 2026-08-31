import assert from "node:assert/strict";
import { resolveHostRuntimeEnvironment } from "../profiles/runtime-environment.js";

const web = resolveHostRuntimeEnvironment({
  preset: "web-single",
  profile: "local",
  authMode: "session",
});
assert.deepEqual(web, {
  preset: "web-single",
  profile: "local",
  tenancy: "single-principal",
  execution: "local-process",
  workspace: "host-local",
  stateStore: "sqlite",
  blobStore: "filesystem",
  auth: "session",
});

assert.throws(
  () =>
    resolveHostRuntimeEnvironment({
      preset: "web-single",
      profile: "local",
      authMode: "bridge-token",
    }),
  /web-single requires session authentication/,
);

assert.equal(
  resolveHostRuntimeEnvironment({
    profile: "local",
    authMode: "bridge-token",
  }).preset,
  "local-single",
);

console.log("Runtime environment harness passed.");
