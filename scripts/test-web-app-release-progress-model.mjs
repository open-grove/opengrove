import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-release-progress-model-"));
const entryPath = join(tempDir, "entry.ts");
const bundlePath = join(tempDir, "entry.mjs");

try {
  await writeFile(
    entryPath,
    `
import assert from "node:assert/strict";
import { BridgeRequestError } from ${JSON.stringify(join(projectRoot, "web/src/bridge-client.ts"))};
import { publishProgressFromError } from ${JSON.stringify(join(projectRoot, "web/src/components/network/app-store-publish-model.ts"))};

const blockedRelease = {
  id: "blocked-release",
  status: "trusted_build_failed",
  packageKey: "opengrove.release-app",
  version: "1.0.0",
  sourceSha256: "a".repeat(64),
  createdAt: "2026-08-27T00:00:00.000Z",
  allowedActions: ["retry_build", "abandon"],
  matchesCurrentSource: true,
  matchesCurrentRequest: true,
};
const progress = {
  localAppId: "release-app-mount",
  appId: "release-app",
  packageKey: "opengrove.release-app",
  version: "1.0.0",
  title: "Release App",
  visibility: "restricted",
  phase: "remote_blocked",
  remoteIntentId: "blocked-release",
  remoteStatus: "trusted_build_failed",
  allowedActions: ["retry_build", "abandon"],
  blockedRelease,
  applyToCurrentApp: false,
  state: "blocked",
  retryable: false,
  updatedAt: "2026-08-27T00:00:00.000Z",
};

function parse(candidate) {
  const error = new BridgeRequestError("app_release_in_progress");
  error.payload = { progress: { ...progress, blockedRelease: candidate } };
  return publishProgressFromError(error);
}

assert.ok(parse(blockedRelease), "a complete same-request blocked release must be accepted");
assert.equal(parse({
  ...blockedRelease,
  matchesCurrentSource: false,
}), undefined, "a request match cannot be true when its source does not match");
assert.equal(parse({
  ...blockedRelease,
  matchesCurrentRequest: false,
}), undefined, "retry actions cannot cross a mismatched release request");
assert.ok(parse({
  ...blockedRelease,
  allowedActions: ["abandon"],
  matchesCurrentRequest: false,
}), "a mismatched request may retain only the explicit end action");

process.stdout.write("web App release progress model harness passed\\n");
`,
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundlePath,
    nodePaths: [join(projectRoot, "node_modules")],
  });
  await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
