import { get } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import golden from "./fixtures/app-website-static-v1.json" with { type: "json" };
import { startAppWebsitePreview } from "../app-builder/website-cli.js";
const fixtures: string[] = [];
after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});
import {
  inspectAppWebsite,
  prepareAppWebsite,
  createAppWebsiteArtifact,
  recordAppWebsiteReview,
  readReviewedAppWebsiteArtifact,
} from "../app-builder/website.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opengrove-website-"));
  fixtures.push(root);
  mkdirSync(join(root, "ui"));
  mkdirSync(join(root, "workspace"));
  writeFileSync(
    join(root, "opengrove.app.json"),
    JSON.stringify({
      id: "example",
      title: "Example",
      workspace: { path: "workspace" },
      ui: { surface: "view", view: { protocol: "mcp-app", entry: "ui/index.html", tools: [] } },
    }),
  );
  writeFileSync(join(root, "ui/index.html"), "<!doctype html><title>Example</title><h1>Hello</h1>");
  return root;
}

test("static preparation preserves files and produces repeatable reviewed bytes", () => {
  const root = fixture();
  assert.equal(prepareAppWebsite(root).status, "prepared");
  assert.equal(inspectAppWebsite(root).ready, true);
  const first = createAppWebsiteArtifact(root);
  assert.deepEqual(createAppWebsiteArtifact(root), first);
  assert.throws(() => readReviewedAppWebsiteArtifact(root), /website_review_required/);
  recordAppWebsiteReview(root, {
    artifactSha256: first.sha256,
    summary: "Opened the independent page; the heading renders.",
    checks: ["Independent browser page opens", "Included functionality reviewed"],
  });
  assert.equal(readReviewedAppWebsiteArtifact(root).artifactSha256, first.sha256);
  writeFileSync(join(root, "ui/index.html"), "<h1>Changed</h1>");
  assert.throws(() => readReviewedAppWebsiteArtifact(root), /website_review_stale/);
});

test("MCP commands require an explicit browser adaptation", () => {
  const root = fixture();
  writeFileSync(join(root, "ui/index.html"), "<script>parent.postMessage({method:'tools/call'}, '*')</script>");
  const result = prepareAppWebsite(root);
  assert.equal(result.status, "needs-adaptation");
  assert.equal(inspectAppWebsite(root).ready, false);
});

test("workspace output and symlinked assets are rejected", () => {
  const root = fixture();
  prepareAppWebsite(root);
  symlinkSync(join(root, "workspace"), join(root, "ui/private"));
  assert.equal(inspectAppWebsite(root).ready, false);
  assert.throws(() => createAppWebsiteArtifact(root), /website_checks_failed/);
});

test("config changes invalidate a previous review", () => {
  const root = fixture();
  prepareAppWebsite(root);
  const artifact = createAppWebsiteArtifact(root);
  recordAppWebsiteReview(root, {
    artifactSha256: artifact.sha256,
    summary: "Browser behavior and access reviewed.",
    checks: ["Browser opened"],
  });
  const config = JSON.parse(artifact.bytes.toString("utf8")).config;
  writeFileSync(
    join(root, "opengrove.web.json"),
    JSON.stringify({
      ...config,
      output: "ui",
      audience: { mode: "roles", roles: ["admin"] },
    }),
  );
  assert.throws(() => readReviewedAppWebsiteArtifact(root), /website_review_stale/);
});

test("independent preview serves the declared HTML entry and denies Host APIs", async () => {
  const root = fixture();
  writeFileSync(join(root, "ui/view.html"), "<!doctype html><title>Standalone</title><h1>Browser only</h1>");
  const manifest = {
    id: "example",
    title: "Example",
    ui: { view: { protocol: "mcp-app", entry: "ui/view.html", tools: [] } },
  };
  writeFileSync(join(root, "opengrove.app.json"), JSON.stringify(manifest));
  assert.equal(prepareAppWebsite(root).status, "prepared");
  const server = await startAppWebsitePreview(root);
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(base);
    assert.match(await page.text(), /Browser only/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(base + "/workspace/private.json")).status, 404);
    assert.equal((await fetch(base + "/_og/api/v1/users/me")).status, 501);
    const sdk = await fetch(base + "/_og/sdk.js");
    assert.equal(sdk.headers.get("content-type"), "text/javascript");
    assert.match(await sdk.text(), /export function draftsFor/);
    const status = await new Promise<number | undefined>((done, reject) => {
      get(base, { headers: { Host: "attacker.example.test" } }, (result) => {
        result.resume();
        done(result.statusCode);
      }).once("error", reject);
    });
    assert.equal(status, 403);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("review cannot overwrite a symlink and output cannot include reserved service paths", () => {
  const root = fixture();
  prepareAppWebsite(root);
  const artifact = createAppWebsiteArtifact(root);
  symlinkSync(join(root, "ui/index.html"), join(root, ".opengrove-web-review.json"));
  assert.throws(
    () =>
      recordAppWebsiteReview(root, {
        artifactSha256: artifact.sha256,
        summary: "Checked standalone browser output",
        checks: ["Browser opened"],
      }),
    /website_file_invalid/,
  );
  mkdirSync(join(root, "ui/_og"));
  writeFileSync(join(root, "ui/_og/sdk.js"), "malicious()");
  assert.equal(inspectAppWebsite(root).ready, false);
});

test("nested preview entry preserves the document base and query", async () => {
  const root = fixture();
  prepareAppWebsite(root);
  const config = inspectAppWebsite(root).config!;
  mkdirSync(join(root, "ui/pages"));
  writeFileSync(join(root, "ui/pages/view.html"), '<script src="./view.js"></script>');
  writeFileSync(join(root, "ui/pages/view.js"), 'document.title = "Nested";');
  writeFileSync(join(root, "opengrove.web.json"), JSON.stringify({ ...config, entry: "pages/view.html" }));
  const server = await startAppWebsitePreview(root);
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const redirect = await fetch(base + "/?view=seed%20one", { redirect: "manual" });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), "/pages/view.html?view=seed%20one");
    const page = await fetch(base + "/");
    const scriptURL = new URL("./view.js", page.url);
    assert.equal((await fetch(scriptURL)).status, 200);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("the Go publication service consumes the same fixed version 1 artifact bytes", () => {
  const root = fixture();
  writeFileSync(join(root, "ui/index.html"), "<h1>Hello</h1>");
  prepareAppWebsite(root);
  const config = inspectAppWebsite(root).config!;
  writeFileSync(join(root, "opengrove.web.json"), JSON.stringify({ ...config, audience: { mode: "public" } }));
  const artifact = createAppWebsiteArtifact(root);
  assert.equal(artifact.sha256, "7d69e30ba7a6076c40a44fc5587655aeaad41b16d5afde9749f84a9d75627471");
  assert.equal(artifact.bytes.toString("base64"), golden.artifact);
  assert.equal(artifact.sha256, golden.artifactSha256);
});
