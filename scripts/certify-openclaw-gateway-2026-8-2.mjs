import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOpenClawGatewayProviderProfiles } from "../dist/runtime/openclaw-gateway-runtime.js";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const certifiedVersion = "2026.8.2";
const stateDir = mkdtempSync(join(tmpdir(), "opengrove-openclaw-2026-8-2-"));
const token = "opengrove-openclaw-2026-8-2-certification-local-only";
const port = await reservePort();
const gatewayUrl = `ws://127.0.0.1:${port}`;
let gateway;
let gatewayOutput = "";

try {
  const versionOutput = await runAndCollect(
    nodePackageManagerInvocation("npx", ["--yes", `openclaw@${certifiedVersion}`, "--version"]),
  );
  assert.match(versionOutput, new RegExp(`OpenClaw\\s+${certifiedVersion.replaceAll(".", "\\.")}(?:\\s|$)`));

  const invocation = nodePackageManagerInvocation("npx", [
    "--yes",
    `openclaw@${certifiedVersion}`,
    "gateway",
    "--allow-unconfigured",
    "--dev",
    "--bind",
    "loopback",
    "--port",
    String(port),
    "--token",
    token,
    "run",
  ]);
  gateway = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (chunk) => {
    gatewayOutput = appendOutput(gatewayOutput, chunk);
  });
  gateway.stderr.on("data", (chunk) => {
    gatewayOutput = appendOutput(gatewayOutput, chunk);
  });

  const providers = await waitForGateway(gatewayUrl, token, gateway);
  assert.ok(Array.isArray(providers), "OpenClaw models.list must return a model catalog array");
  process.stdout.write(
    `OpenClaw ${certifiedVersion} Gateway certification: challenge handshake, protocol v4, and models.list passed.\n`,
  );
} catch (error) {
  if (gatewayOutput.trim()) process.stderr.write(`OpenClaw Gateway output:\n${gatewayOutput}\n`);
  throw error;
} finally {
  await stopChild(gateway);
  rmSync(stateDir, { recursive: true, force: true });
}

async function waitForGateway(url, gatewayToken, child) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenClaw ${certifiedVersion} Gateway exited early with code ${child.exitCode}`);
    }
    try {
      return await discoverOpenClawGatewayProviderProfiles({ url, token: gatewayToken });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `OpenClaw ${certifiedVersion} Gateway did not pass its contract within 60 seconds: ${String(lastError)}`,
  );
}

function runAndCollect(invocation) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`OpenClaw version probe exited with code ${code}: ${output}`));
    });
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function appendOutput(current, chunk) {
  return `${current}${String(chunk)}`.slice(-12_000);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
