import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
const requests: Array<{ method: string; path: string; body?: unknown }> = [];
const release = {
  identity: {
    appId: "release-fixture-app",
    source: "mounted",
    appRoot: "/fixture/app",
    workspaceRoot: "/fixture/app/workspace",
  },
  app: { title: "Release Fixture App", description: "CLI fixture" },
  version: "1.2.3",
  releaseNotes: "",
  visibility: "restricted",
  minHostReleaseNumber: 0,
  employees: [],
  checks: [],
};
const progress = {
  localAppId: "release-fixture-app",
  appId: "release-fixture-app",
  packageKey: "opengrove.release-fixture-app",
  version: "1.2.3",
  title: "Release Fixture App",
  visibility: "restricted",
  phase: "remote_pending",
  remoteIntentId: "release-1",
  remoteStatus: "building",
  allowedActions: [],
  applyToCurrentApp: false,
  state: "publishing",
  retryable: true,
  updatedAt: "2026-09-03T00:00:00.000Z",
};

const bridge = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/opengrove-probe") {
    sendJson(response, 200, { ok: true, product: "OpenGrove", stateId: "release-cli-fixture" });
    return;
  }
  void readJsonBody(request).then((body) => {
    requests.push({ method: request.method ?? "GET", path: url.pathname, ...(body === undefined ? {} : { body }) });
    if (request.method === "GET" && url.pathname.endsWith("/publish/prepare")) {
      sendJson(response, 200, { ok: true, release });
      return;
    }
    if (request.method === "GET" && (url.pathname.endsWith("/publish") || url.pathname.endsWith("/publish/status"))) {
      sendJson(response, 200, { ok: true, progress });
      return;
    }
    if (request.method === "POST" && url.pathname.includes("/publish")) {
      sendJson(response, url.pathname.endsWith("/keep-local") ? 200 : 202, { ok: true, progress });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  });
});

try {
  bridge.listen(0, "127.0.0.1");
  await once(bridge, "listening");
  const origin = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;
  const common = ["--base-url", `${origin}/api`, "--token", "fixture-token"];

  const prepared = await runCli(["app", "release", "prepare", "--app-id", "release-fixture-app", ...common]);
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.equal(field(prepared.stdoutJson, "operation"), "app.release.prepare");
  assert.equal(field(prepared.stdoutJson, "data", "release", "version"), "1.2.3");

  const command = [
    "app",
    "release",
    "publish",
    "--app-id",
    "release-fixture-app",
    "--version",
    "1.2.3",
    "--release-notes",
    "First release",
    "--visibility",
    "restricted",
    ...common,
  ];
  const beforeDryRun = requests.length;
  const dryRun = await runCli([...command, "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(requests.length, beforeDryRun, "dry-run must not send a release request");
  assert.equal(field(dryRun.stdoutJson, "request", "body", "applyToCurrentApp"), false);

  const unconfirmed = await runCli(command);
  assert.equal(unconfirmed.code, 10);
  assert.equal(field(unconfirmed.stderrJson, "error", "subtype"), "confirmation_required");

  const published = await runCli([...command, "--yes"]);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(field(published.stdoutJson, "operation"), "app.release.publish");
  const publishRequest = requests.find((request) => request.method === "POST" && request.path.endsWith("/publish"));
  assert.deepEqual(publishRequest?.body, {
    version: "1.2.3",
    releaseNotes: "First release",
    visibility: "restricted",
    applyToCurrentApp: false,
  });

  for (const [method, flags, needsYes] of [
    ["status", [], false],
    ["progress", [], false],
    ["reconcile", ["--retry-failed-build"], false],
    ["abandon", [], true],
    ["keep-local", [], true],
  ] as const) {
    const result = await runCli([
      "app",
      "release",
      method,
      "--app-id",
      "release-fixture-app",
      ...flags,
      ...common,
      ...(needsYes ? ["--yes"] : []),
    ]);
    assert.equal(result.code, 0, `${method}: ${result.stderr}`);
    assert.equal(field(result.stdoutJson, "operation"), `app.release.${method}`);
  }

  console.log("release-cli-harness ok");
} finally {
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
}

async function runCli(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutJson: Record<string, unknown>;
  stderrJson: Record<string, unknown>;
}> {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr, stdoutJson: parseJson(stdout), stderrJson: parseJson(stderr) };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : undefined;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function parseJson(value: string): Record<string, unknown> {
  return value.trim() ? (JSON.parse(value) as Record<string, unknown>) : {};
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
