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

type FixtureProgress = Record<string, unknown> & { state: string; remoteStatus?: string; phase: string };

function progressFor(appId: string, overrides: Partial<FixtureProgress> = {}): FixtureProgress {
  return {
    localAppId: appId,
    appId,
    packageKey: `opengrove.${appId}`,
    version: "1.2.3",
    title: "Release Fixture App",
    visibility: "restricted",
    phase: "remote_pending",
    remoteIntentId: `${appId}-release-1`,
    remoteStatus: "building",
    allowedActions: [],
    applyToCurrentApp: true,
    state: "publishing",
    retryable: true,
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Each fixture App replays a different Release Control story so the CLI wait
 * loop can be exercised deterministically:
 * - release-fixture-app: building → artifact_accepted → (reconcile) → published
 * - blocked-app: the trusted build failed and Release Control waits for a human
 * - stuck-app: artifact_accepted never leaves that state even after reconcile
 * - unidentified-app: artifact_accepted has no remote intent identity yet
 * - slow-app: keeps building forever
 */
const statusPolls = new Map<string, number>();
function currentProgress(appId: string, action: "publish" | "status" | "reconcile"): FixtureProgress {
  if (appId === "blocked-app") {
    return progressFor(appId, {
      phase: "remote_blocked",
      remoteStatus: "trusted_build_failed",
      state: "blocked",
      retryable: false,
      allowedActions: ["retry_build", "abandon"],
      buildFailure: { stage: "trusted_build", code: "npm_build_failed", retryable: true, workflowRunId: "run-1" },
    });
  }
  if (appId === "stuck-app") {
    return progressFor(appId, { remoteStatus: "artifact_accepted" });
  }
  if (appId === "unidentified-app") {
    return progressFor(appId, { remoteIntentId: undefined, remoteStatus: "artifact_accepted" });
  }
  if (appId === "slow-app") {
    return progressFor(appId);
  }
  if (action === "reconcile") {
    return progressFor(appId, { phase: "local_finalized", remoteStatus: "published", state: "published" });
  }
  if (action === "status") {
    const polls = (statusPolls.get(appId) ?? 0) + 1;
    statusPolls.set(appId, polls);
    return progressFor(appId, polls >= 2 ? { remoteStatus: "artifact_accepted" } : {});
  }
  return progressFor(appId);
}

const bridge = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/opengrove-probe") {
    sendJson(response, 200, { ok: true, product: "OpenGrove", stateId: "release-cli-fixture" });
    return;
  }
  void readJsonBody(request).then((body) => {
    requests.push({ method: request.method ?? "GET", path: url.pathname, ...(body === undefined ? {} : { body }) });
    const appId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    if (request.method === "GET" && url.pathname.endsWith("/publish/prepare")) {
      sendJson(response, 200, { ok: true, release });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/publish")) {
      sendJson(response, 200, { ok: true, progress: currentProgress(appId, "publish") });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/publish/status")) {
      sendJson(response, 200, { ok: true, progress: currentProgress(appId, "status") });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/publish/reconcile")) {
      sendJson(response, 200, { ok: true, progress: currentProgress(appId, "reconcile") });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/publish")) {
      sendJson(response, 202, { ok: true, progress: currentProgress(appId, "publish") });
      return;
    }
    if (request.method === "POST" && url.pathname.includes("/publish")) {
      sendJson(response, url.pathname.endsWith("/keep-local") ? 200 : 202, {
        ok: true,
        progress: currentProgress(appId, "publish"),
      });
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
  const publishCommand = (appId: string) => [
    "app",
    "release",
    "publish",
    "--app-id",
    appId,
    "--version",
    "1.2.3",
    "--release-notes",
    "First release",
    "--visibility",
    "restricted",
    "--poll-interval",
    "0",
    ...common,
  ];

  const prepared = await runCli(["app", "release", "prepare", "--app-id", "release-fixture-app", ...common]);
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.equal(field(prepared.stdoutJson, "operation"), "app.release.prepare");
  assert.equal(field(prepared.stdoutJson, "data", "release", "version"), "1.2.3");

  // --- Dry run, confirmation gate, and the applyToCurrentApp default.
  const command = publishCommand("release-fixture-app");
  const beforeDryRun = requests.length;
  const dryRun = await runCli([...command, "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(requests.length, beforeDryRun, "dry-run must not send a release request");
  assert.equal(field(dryRun.stdoutJson, "request", "body", "applyToCurrentApp"), true);

  const keepLocalDryRun = await runCli([...command, "--no-apply-to-current-app", "--dry-run"]);
  assert.equal(keepLocalDryRun.code, 0, keepLocalDryRun.stderr);
  assert.equal(field(keepLocalDryRun.stdoutJson, "request", "body", "applyToCurrentApp"), false);

  const unconfirmed = await runCli(command);
  assert.equal(unconfirmed.code, 10);
  assert.equal(field(unconfirmed.stderrJson, "error", "subtype"), "confirmation_required");
  assert.equal(requests.length, beforeDryRun, "confirmation gate must not send a release request");

  // --- Default: publish drives the release to a terminal state like the UI does.
  const publishedFrom = requests.length;
  const published = await runCli([...command, "--yes"]);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(field(published.stdoutJson, "operation"), "app.release.publish");
  assert.equal(field(published.stdoutJson, "data", "progress", "state"), "published");
  assert.equal(field(published.stdoutJson, "wait", "reconciles"), 1);
  const publishRequests = requests.slice(publishedFrom);
  assert.deepEqual(
    publishRequests.map((request) => `${request.method} ${request.path.split("/").slice(4).join("/")}`),
    ["POST publish", "GET publish/status", "GET publish/status", "POST publish/reconcile"],
  );
  assert.deepEqual(publishRequests[0]?.body, {
    version: "1.2.3",
    releaseNotes: "First release",
    visibility: "restricted",
    applyToCurrentApp: true,
  });
  assert.deepEqual(publishRequests.at(-1)?.body, { retryFailedBuild: false });

  // --- --no-wait returns the first snapshot and sends nothing else.
  const noWaitFrom = requests.length;
  const noWait = await runCli([...command, "--yes", "--no-wait"]);
  assert.equal(noWait.code, 0, noWait.stderr);
  assert.equal(field(noWait.stdoutJson, "data", "progress", "remoteStatus"), "building");
  assert.equal(field(noWait.stdoutJson, "wait"), undefined);
  assert.equal(requests.length - noWaitFrom, 1);

  // --- A blocked release exits non-zero with the progress an agent needs to act.
  const blocked = await runCli([...publishCommand("blocked-app"), "--yes"]);
  assert.equal(blocked.code, 1);
  assert.equal(field(blocked.stderrJson, "error", "subtype"), "app_release_blocked");
  assert.equal(field(blocked.stderrJson, "progress", "buildFailure", "code"), "npm_build_failed");
  assert.deepEqual(field(blocked.stderrJson, "progress", "allowedActions"), ["retry_build", "abandon"]);

  // --- Automatic recovery has the same budget as the UI (two tries at artifact_accepted).
  const stuckFrom = requests.length;
  const stuck = await runCli([...publishCommand("stuck-app"), "--yes"]);
  assert.equal(stuck.code, 1);
  assert.equal(field(stuck.stderrJson, "error", "subtype"), "app_release_recovery_exhausted");
  assert.equal(requests.slice(stuckFrom).filter((request) => request.path.endsWith("/publish/reconcile")).length, 2);

  // --- Without a remote intent identity, keep polling instead of spending an unkeyed recovery budget.
  const unidentifiedFrom = requests.length;
  const unidentified = await runCli([...publishCommand("unidentified-app"), "--yes", "--wait-timeout", "0"]);
  assert.equal(unidentified.code, 1);
  assert.equal(field(unidentified.stderrJson, "error", "subtype"), "app_release_wait_timeout");
  assert.equal(
    requests.slice(unidentifiedFrom).filter((request) => request.path.endsWith("/publish/reconcile")).length,
    0,
  );

  // --- A never-finishing remote build times out with guidance instead of hanging.
  const slow = await runCli([...publishCommand("slow-app"), "--yes", "--wait-timeout", "0"]);
  assert.equal(slow.code, 1);
  assert.equal(field(slow.stderrJson, "error", "subtype"), "app_release_wait_timeout");
  assert.equal(field(slow.stderrJson, "progress", "remoteStatus"), "building");

  const help = await runCli(["app", "release", "publish", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--no-wait/u);
  assert.match(help.stdout, /--apply-to-current-app/u);

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
  const text = value.trim();
  if (!text.startsWith("{")) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
