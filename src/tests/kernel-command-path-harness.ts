import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createCodexKernelAdapter,
  createCodexKernelAdapterFromOptions,
  discoverCodexKernel,
} from "../kernel/adapters/codex.js";
import {
  createClaudeCodeKernelAdapter,
  createClaudeCodeKernelAdapterFromOptions,
  discoverClaudeCodeKernel,
} from "../kernel/adapters/claude-code.js";
import { createHermesKernelAdapterFromOptions, discoverHermesKernel } from "../kernel/adapters/hermes.js";
import { discoverOpenClawKernel, resolveOpenClawCommand } from "../kernel/adapters/openclaw.js";
import { discoverPiKernel, resolvePiCommand } from "../kernel/adapters/pi.js";
import { createKimiKernelAdapter, discoverKimiKernel, resolveKimiCommand } from "../kernel/adapters/kimi.js";
import {
  createOpenCodeKernelAdapter,
  discoverOpenCodeKernel,
  resolveOpenCodeCommand,
} from "../kernel/adapters/opencode.js";
import { appEnvName } from "../identity.js";
import { commandVersion, resolveCommandPath } from "../kernel/discovery.js";
import { resolveCodexCommandPath } from "../runtime/codex/command-path.js";
import { resolveHermesCommandPath } from "../runtime/hermes/command.js";
import { resolveKernelCommandPath } from "../server/kernel-selection.js";
import { kernelInstallCommandInvocation } from "../server/routes/settings.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-kernel-command-path-"));
const homeDir = join(tempRoot, "home");
const pathDir = join(tempRoot, "path");
const applicationsDir = join(tempRoot, "Applications");
const originalCodexBin = process.env.OPENGROVE_CODEX_BIN;
const originalPath = process.env.PATH;
const explicitBinNames = ["OPENCODE_BIN", "KIMI_BIN", "PI_BIN", "OPENCLAW_BIN", "HERMES_BIN"] as const;
const originalExplicitBins = new Map(explicitBinNames.map((name) => [name, process.env[appEnvName(name)]]));

try {
  for (const name of explicitBinNames) delete process.env[appEnvName(name)];
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  mkdirSync(join(pathDir, "codex"), { recursive: true });
  assert.equal(
    resolveCommandPath("codex", { path: pathDir, platform: "darwin" }),
    undefined,
    "PATH discovery must not treat a directory named like a command as an executable",
  );

  rmSync(join(pathDir, "codex"), { recursive: true, force: true });
  const pathCodex = writeCommand(join(pathDir, "codex"), false, "darwin");
  if (process.platform !== "win32") {
    assert.equal(
      resolveCommandPath("codex", { path: pathDir, platform: "darwin" }),
      undefined,
      "PATH discovery must ignore non-executable files on POSIX",
    );
  }
  chmodSync(pathCodex, 0o755);
  assert.equal(
    resolveCommandPath("codex", { path: pathDir, platform: "darwin" }),
    pathCodex,
    "PATH discovery must resolve an executable file",
  );

  const windowsBin = join(tempRoot, "windows-bin");
  const windowsCommand = writeCommand(join(windowsBin, "codex.cmd"), false, "win32");
  assert.equal(
    resolveCommandPath("codex", { path: windowsBin, platform: "win32" }),
    windowsCommand,
    "Windows discovery must resolve PATHEXT commands without POSIX executable bits",
  );
  assert.deepEqual(
    kernelInstallCommandInvocation(["npm", "install", "-g", "@openai/codex"], {
      platform: "win32",
      environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "install", "-g", "@openai/codex"],
    },
    "bare package-manager commands must resolve through the Windows command processor",
  );

  rmSync(pathCodex, { force: true });
  const finderLikeProbe = {
    platform: "darwin" as const,
    homeDir,
    applicationDirs: [applicationsDir],
    envPath: "",
    commandPath: { path: pathDir, platform: "darwin" as const },
  };
  const chatGptCodex = writeCommand(
    join(applicationsDir, "ChatGPT.app", "Contents", "Resources", "codex"),
    true,
    "darwin",
  );
  assert.equal(
    resolveCodexCommandPath(finderLikeProbe),
    chatGptCodex,
    "Finder-like product discovery must resolve the Codex executable bundled with ChatGPT.app",
  );

  rmSync(join(applicationsDir, "ChatGPT.app"), { recursive: true, force: true });
  const legacyCodexApp = writeCommand(
    join(applicationsDir, "Codex.app", "Contents", "Resources", "codex"),
    true,
    "darwin",
  );
  assert.equal(
    resolveCodexCommandPath(finderLikeProbe),
    legacyCodexApp,
    "Product discovery must retain the legacy Codex.app fallback",
  );

  rmSync(join(applicationsDir, "Codex.app"), { recursive: true, force: true });
  const localCodex = writeCommand(join(homeDir, ".local", "bin", "codex"), true, "darwin");
  assert.equal(
    resolveCodexCommandPath(finderLikeProbe),
    localCodex,
    "Product discovery must retain the user-local Codex fallback",
  );

  const nonExecutableOverride = writeCommand(join(tempRoot, "non-executable-codex"), false, "darwin");
  if (process.platform !== "win32") {
    assert.equal(
      resolveCodexCommandPath({ ...finderLikeProbe, envPath: nonExecutableOverride }),
      undefined,
      "An invalid configured Codex path must fail closed instead of silently selecting another binary",
    );
  }

  const explicitCodex = writeCommand(join(tempRoot, "explicit-codex"), true);
  process.env.OPENGROVE_CODEX_BIN = explicitCodex;
  assert.equal(
    resolveKernelCommandPath(undefined, "codex"),
    explicitCodex,
    "The server product chain must use the same Codex resolver",
  );
  const discovery = discoverCodexKernel();
  assert.equal(discovery.available, true, "The adapter product chain must use the same Codex resolver");
  assert.equal(discovery.binaryPath, explicitCodex);

  const missingCodexOverride = join(tempRoot, "configured", "missing-codex");
  const missingCodexDiscovery = discoverCodexKernel({ command: missingCodexOverride });
  assert.deepEqual(
    missingCodexDiscovery.executableProbe,
    {
      role: "runtime-required",
      status: "missing",
      requestedCommand: missingCodexOverride,
      source: "configured",
    },
    "a missing explicit command must retain both its requested path and ownership",
  );
  assert.ok(missingCodexDiscovery.health?.message?.includes(missingCodexOverride));
  assert.ok(missingCodexDiscovery.health?.message?.includes("fallback"));

  const claudeNodeScript = join(tempRoot, "claude-cli.mjs");
  writeFileSync(claudeNodeScript, "console.log('claude-node-script 1.0')\n", "utf8");
  chmodSync(claudeNodeScript, 0o644);
  assert.equal(
    commandVersion(claudeNodeScript),
    "claude-node-script 1.0",
    "a Node-script CLI probe must use Node just like the Claude runtime launch path",
  );
  const nodeScriptClaude = discoverClaudeCodeKernel({ cliPath: claudeNodeScript }, tempRoot);
  assert.equal(
    nodeScriptClaude.available,
    true,
    "a readable Claude Node script must not be rejected for lacking a shebang or executable bit",
  );

  const missingKimiProbe = { homeDir: join(tempRoot, "empty-home"), path: join(tempRoot, "empty-path") };
  assert.equal(resolveKimiCommand(undefined, missingKimiProbe), undefined);
  assert.equal(discoverKimiKernel(undefined, missingKimiProbe).available, false);
  const installedKimi = writeCommand(join(homeDir, ".kimi-code", "bin", "kimi"), true);
  const kimiProbe = { homeDir, path: pathDir };
  assert.equal(
    resolveKimiCommand(undefined, kimiProbe),
    installedKimi,
    "Kimi must resolve its official install directory without a terminal PATH",
  );
  assert.equal(discoverKimiKernel(undefined, kimiProbe).binaryPath, installedKimi);
  assert.equal(discoverKimiKernel(undefined, kimiProbe).executableProbe?.source, "discovered");
  const pathKimi = writeCommand(join(pathDir, "kimi"), true);
  assert.equal(
    resolveKimiCommand(undefined, kimiProbe),
    pathKimi,
    "PATH must take precedence over an automatic install-directory candidate",
  );
  const explicitKimi = writeCommand(join(tempRoot, "explicit kimi"), true);
  assert.equal(resolveKimiCommand(explicitKimi, kimiProbe), explicitKimi);
  assert.equal(
    resolveKimiCommand(join(tempRoot, "missing kimi"), kimiProbe),
    undefined,
    "an invalid explicit path must not fall back",
  );
  const brokenKimi = writeFailingCommand(join(tempRoot, "broken kimi"));
  assert.equal(resolveKimiCommand(brokenKimi, kimiProbe), undefined);
  assert.equal(discoverKimiKernel(brokenKimi, kimiProbe).executableProbe?.status, "failed");

  const slowPathDir = join(tempRoot, "slow-path");
  const slowOpenCode = writeSlowCommand(join(slowPathDir, "opencode"));
  const slowKimi = writeSlowCommand(join(slowPathDir, "kimi"));
  process.env.PATH = slowPathDir;
  assert.equal(
    resolveOpenCodeCommand(),
    slowOpenCode,
    "An executable OpenCode path must not be rejected because --version exceeds a diagnostic timeout",
  );
  assert.equal(
    resolveKimiCommand(),
    slowKimi,
    "An executable Kimi path must not be rejected because --version exceeds a diagnostic timeout",
  );
  assert.equal(
    commandVersion(slowOpenCode),
    "slow native cli",
    "a slow CLI must retain version output emitted before the diagnostic timeout",
  );
  assert.equal(
    discoverOpenCodeKernel(slowOpenCode).health?.message,
    `Configured OpenCode command resolved to ${slowOpenCode}, but its version check timed out; the command remains available.`,
    "an explicit slow CLI diagnostic must name its owner without malformed prose",
  );
  assert.equal(
    discoverOpenCodeKernel().health?.message,
    "OpenCode CLI version check timed out; the command remains available.",
    "a PATH slow CLI diagnostic must not repeat probe/version-check wording",
  );

  const failingPathDir = join(tempRoot, "failing-path");
  const failingCodex = writeFailingCommand(join(failingPathDir, "codex"));
  const failingClaude = writeFailingCommand(join(failingPathDir, "claude"));
  const failingOpenCode = writeFailingCommand(join(failingPathDir, "opencode"));
  const failingKimi = writeFailingCommand(join(failingPathDir, "kimi"));
  process.env.PATH = failingPathDir;
  assert.equal(
    resolveOpenCodeCommand(),
    undefined,
    "OpenCode must reject a command whose version probe exits unsuccessfully",
  );
  assert.equal(resolveKimiCommand(), undefined, "Kimi must reject a command whose version probe exits unsuccessfully");
  for (const [name, pathDiscovery, binaryPath] of [
    ["OpenCode", discoverOpenCodeKernel(), failingOpenCode],
    ["Kimi", discoverKimiKernel(), failingKimi],
  ] as const) {
    assert.equal(pathDiscovery.binaryPath, binaryPath);
    assert.equal(pathDiscovery.executableProbe?.status, "failed");
    assert.equal(
      pathDiscovery.executableProbe?.source,
      "path",
      `${name} must preserve a found-but-broken PATH candidate as a PATH diagnostic`,
    );
  }
  for (const [name, discovery, binaryPath] of [
    ["Codex", discoverCodexKernel({ command: failingCodex }), failingCodex],
    ["Claude Agent", discoverClaudeCodeKernel({ cliPath: failingClaude }, tempRoot), failingClaude],
    ["OpenCode", discoverOpenCodeKernel(failingOpenCode), failingOpenCode],
    ["Kimi", discoverKimiKernel(failingKimi), failingKimi],
  ] as const) {
    assert.equal(
      discovery.installed,
      true,
      `${name} discovery must distinguish a found executable from a missing install`,
    );
    assert.equal(discovery.available, false, `${name} discovery must reject a failed version probe`);
    assert.equal(discovery.binaryPath, binaryPath);
    assert.equal(discovery.health?.status, "unavailable");
    assert.ok(discovery.health?.message?.includes("exited with code 2"));
    assert.deepEqual(
      discovery.executableProbe,
      {
        role: "runtime-required",
        status: "failed",
        path: binaryPath,
        requestedCommand: binaryPath,
        source: "configured",
        exitCode: 2,
      },
      `${name} discovery must expose a structured failed executable probe`,
    );
  }
  for (const [name, adapter, binaryPath] of [
    ["Codex", createCodexKernelAdapter({ command: failingCodex }), failingCodex],
    ["Claude Agent", createClaudeCodeKernelAdapter({ cliPath: failingClaude }), failingClaude],
    ["OpenCode", createOpenCodeKernelAdapter({ command: failingOpenCode }), failingOpenCode],
    ["Kimi", createKimiKernelAdapter({ command: failingKimi }), failingKimi],
  ] as const) {
    const health = await adapter.healthCheck();
    assert.equal(health.status, "unavailable", `${name} health must reject a found-but-broken executable`);
    assert.ok(health.message?.includes(binaryPath));
    assert.ok(health.message?.includes("exited with code 2"));
    await adapter.dispose?.();
  }
  for (const [name, create, binaryPath] of [
    ["Codex", createCodexKernelAdapterFromOptions, failingCodex],
    ["Claude Agent", createClaudeCodeKernelAdapterFromOptions, failingClaude],
  ] as const) {
    assert.throws(
      () => create({ cwd: tempRoot, configHome: tempRoot, command: binaryPath, env: {} }),
      new RegExp(
        `Configured ${name} command resolved to ${escapeRegExp(binaryPath)}, but --version exited with code 2.*PATH fallback`,
      ),
      `${name} adapter creation must preserve the found-but-broken diagnosis`,
    );
  }
  writeCommand(failingOpenCode, true);
  assert.equal(
    resolveOpenCodeCommand(),
    failingOpenCode,
    "replacing a failed CLI at the same path must invalidate its cached probe without a settings change",
  );

  const noPiCliPath = join(tempRoot, "no-pi-cli");
  mkdirSync(noPiCliPath, { recursive: true });
  process.env.PATH = noPiCliPath;
  const inProcessPi = discoverPiKernel();
  assert.equal(inProcessPi.installed, true, "Pi installation must be derived from the bundled in-process SDK");
  assert.equal(inProcessPi.available, true, "Pi runtime availability must not depend on a separate pi CLI");
  assert.equal(
    inProcessPi.binaryPath,
    undefined,
    "the optional Pi CLI may be absent while the SDK runtime remains available",
  );
  assert.deepEqual(inProcessPi.executableProbe, {
    role: "optional-diagnostic",
    status: "missing",
    requestedCommand: "pi",
    source: "path",
  });
  const missingOptionalPiPath = join(tempRoot, "configured", "missing-pi");
  const missingOptionalPi = discoverPiKernel(missingOptionalPiPath);
  assert.equal(missingOptionalPi.available, true);
  assert.ok(
    missingOptionalPi.health?.message?.includes(missingOptionalPiPath),
    "an explicit missing optional CLI must retain the requested path in diagnostics",
  );
  assert.ok(
    !missingOptionalPi.health?.message?.includes("PATH fallback"),
    "an optional CLI diagnostic must not imply that runtime fallback was blocked",
  );
  const openClawConfigHome = join(tempRoot, "openclaw-gateway-home");
  mkdirSync(openClawConfigHome, { recursive: true });
  writeFileSync(
    join(openClawConfigHome, "openclaw.json"),
    JSON.stringify({
      gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:18789" } },
    }),
    "utf8",
  );
  const gatewayOpenClaw = discoverOpenClawKernel(undefined, { configHome: openClawConfigHome, env: {} });
  assert.equal(
    gatewayOpenClaw.installed,
    true,
    "OpenClaw adapter discovery must derive installation from its configured Gateway",
  );
  assert.equal(
    gatewayOpenClaw.available,
    true,
    "OpenClaw adapter discovery must derive availability from its configured Gateway",
  );
  assert.equal(
    gatewayOpenClaw.executableProbe?.role,
    "optional-diagnostic",
    "OpenClaw's optional CLI must not be modeled as its Gateway runtime entrypoint",
  );
  assert.equal(
    gatewayOpenClaw.health?.status,
    "ok",
    "a configured Gateway must be healthy even when the optional OpenClaw CLI is absent",
  );

  const coldOpenCode = createOpenCodeKernelAdapter();
  const coldKimi = createKimiKernelAdapter({
    command: join(noPiCliPath, process.platform === "win32" ? "kimi.cmd" : "kimi"),
  });
  writeCommand(join(noPiCliPath, "opencode"), true);
  writeCommand(join(noPiCliPath, "kimi"), true);
  for (const [name, adapter] of [
    ["OpenCode", coldOpenCode],
    ["Kimi Code", coldKimi],
  ] as const) {
    const events = [];
    for await (const event of adapter.runTurn({
      input: "hello",
      context: { sessionId: `session-${name}` },
      tools: [],
    } as any))
      events.push(event);
    const response = events.find((event) => event.type === "model.response");
    assert.ok(response && response.type === "model.response");
    assert.ok(response.response.text.includes("not initialized"));
    assert.ok(
      !response.response.text.includes("CLI detected"),
      `${name} must never expose a health-check success message as assistant正文`,
    );
    await adapter.dispose?.();
  }

  const explicitFallbackDir = join(tempRoot, "explicit-fallback-path");
  for (const command of ["opencode", "kimi", "pi", "openclaw", "hermes"]) {
    writeCommand(join(explicitFallbackDir, command), true);
  }
  const failingOverride = writeFailingCommand(join(tempRoot, "configured", "wrong-cli"));
  process.env.PATH = explicitFallbackDir;
  for (const name of explicitBinNames) process.env[appEnvName(name)] = failingOverride;
  assert.equal(resolveOpenCodeCommand(), undefined, "an invalid explicit OpenCode binary must not silently use PATH");
  assert.equal(resolveKimiCommand(), undefined, "an invalid explicit Kimi binary must not silently use PATH");
  assert.equal(resolvePiCommand(), undefined, "an invalid explicit Pi binary must not silently use PATH");
  assert.equal(resolveOpenClawCommand(), undefined, "an invalid explicit OpenClaw binary must not silently use PATH");
  assert.equal(resolveHermesCommandPath(), undefined, "an invalid explicit Hermes binary must not silently use PATH");
  for (const [envName, discovery] of [
    ["OPENCODE_BIN", discoverOpenCodeKernel()],
    ["KIMI_BIN", discoverKimiKernel()],
    ["HERMES_BIN", discoverHermesKernel()],
  ] as const) {
    assert.equal(discovery.installed, true, `${envName} executable must remain visible even when its probe fails`);
    assert.equal(discovery.available, false, `${envName} failure must remain visible in Kernel discovery`);
    assert.equal(discovery.binaryPath, failingOverride);
    assert.equal(discovery.executableProbe?.status, "failed");
    assert.equal(discovery.executableProbe?.path, failingOverride);
    assert.equal(discovery.executableProbe?.exitCode, 2);
  }
  const brokenOptionalOpenClaw = discoverOpenClawKernel(undefined, {
    configHome: join(tempRoot, "openclaw-without-gateway"),
    env: {},
  });
  assert.equal(
    brokenOptionalOpenClaw.installed,
    false,
    "an optional OpenClaw CLI must not impersonate Gateway installation",
  );
  assert.equal(
    brokenOptionalOpenClaw.available,
    false,
    "an optional OpenClaw CLI must not impersonate Gateway availability",
  );
  assert.equal(brokenOptionalOpenClaw.binaryPath, failingOverride);
  assert.equal(brokenOptionalOpenClaw.executableProbe?.role, "optional-diagnostic");
  assert.equal(brokenOptionalOpenClaw.executableProbe?.status, "failed");
  assert.equal(brokenOptionalOpenClaw.health?.message, "OpenClaw Gateway is not configured.");
  const inheritedGatewayUrlName = appEnvName("OPENCLAW_GATEWAY_URL");
  const inheritedConfigPathName = appEnvName("OPENCLAW_CONFIG_PATH");
  const inheritedGatewayUrl = process.env[inheritedGatewayUrlName];
  const inheritedConfigPath = process.env[inheritedConfigPathName];
  const unrelatedOpenClawConfig = join(tempRoot, "ambient-openclaw.json");
  writeFileSync(
    unrelatedOpenClawConfig,
    JSON.stringify({
      gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:19999" } },
    }),
    "utf8",
  );
  try {
    process.env[inheritedGatewayUrlName] = "ws://127.0.0.1:18888";
    process.env[inheritedConfigPathName] = unrelatedOpenClawConfig;
    const isolatedOpenClaw = discoverOpenClawKernel(undefined, {
      configHome: join(tempRoot, "isolated-openclaw-home"),
      env: {},
    });
    assert.equal(
      isolatedOpenClaw.installed,
      false,
      "an explicit discovery environment must not inherit ambient Gateway variables or config paths",
    );
  } finally {
    if (inheritedGatewayUrl === undefined) delete process.env[inheritedGatewayUrlName];
    else process.env[inheritedGatewayUrlName] = inheritedGatewayUrl;
    if (inheritedConfigPath === undefined) delete process.env[inheritedConfigPathName];
    else process.env[inheritedConfigPathName] = inheritedConfigPath;
  }
  const explicitPiDiscovery = discoverPiKernel();
  assert.equal(explicitPiDiscovery.installed, true);
  assert.equal(
    explicitPiDiscovery.available,
    true,
    "a broken optional PI_BIN must not hide the bundled in-process Pi runtime",
  );
  assert.equal(explicitPiDiscovery.binaryPath, failingOverride);
  assert.equal(
    explicitPiDiscovery.health?.status,
    "degraded",
    "a broken optional Pi CLI is diagnostic degradation, not SDK unavailability",
  );
  assert.deepEqual(explicitPiDiscovery.executableProbe, {
    role: "optional-diagnostic",
    status: "failed",
    path: failingOverride,
    requestedCommand: failingOverride,
    source: "environment",
    sourceName: appEnvName("PI_BIN"),
    exitCode: 2,
  });
  assert.throws(
    () =>
      createHermesKernelAdapterFromOptions({
        cwd: tempRoot,
        configHome: join(tempRoot, "hermes-home"),
        env: {},
      }),
    new RegExp(
      `${appEnvName("HERMES_BIN")} resolved to ${escapeRegExp(failingOverride)}, but --version exited with code 2.*PATH fallback`,
    ),
    "selecting a broken Hermes executable must not report that the CLI was absent",
  );
  process.env.PATH = originalPath;

  process.stdout.write("kernel-command-path-harness: product discovery checks passed\n");
} finally {
  if (originalCodexBin === undefined) delete process.env.OPENGROVE_CODEX_BIN;
  else process.env.OPENGROVE_CODEX_BIN = originalCodexBin;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const [name, value] of originalExplicitBins) {
    if (value === undefined) delete process.env[appEnvName(name)];
    else process.env[appEnvName(name)] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

function writeSlowCommand(path: string): string {
  const commandPath = process.platform === "win32" ? `${path}.cmd` : path;
  mkdirSync(dirname(commandPath), { recursive: true });
  writeFileSync(
    commandPath,
    process.platform === "win32"
      ? '@echo off\r\necho slow native cli\r\n>nul "%SystemRoot%\\System32\\ping.exe" 127.0.0.1 -n 4\r\n'
      : "#!/bin/sh\necho 'slow native cli'\n/bin/sleep 3\n",
    "utf8",
  );
  chmodSync(commandPath, 0o755);
  return commandPath;
}

function writeFailingCommand(path: string): string {
  const commandPath = process.platform === "win32" && !path.toLowerCase().endsWith(".cmd") ? `${path}.cmd` : path;
  mkdirSync(dirname(commandPath), { recursive: true });
  writeFileSync(
    commandPath,
    process.platform === "win32"
      ? "@echo off\r\necho not the expected cli 1>&2\r\nexit /b 2\r\n"
      : "#!/bin/sh\necho 'not the expected cli' >&2\nexit 2\n",
    "utf8",
  );
  chmodSync(commandPath, 0o755);
  return commandPath;
}

function writeCommand(path: string, executable: boolean, platform: NodeJS.Platform = process.platform): string {
  const commandPath = platform === "win32" && !path.toLowerCase().endsWith(".cmd") ? `${path}.cmd` : path;
  mkdirSync(dirname(commandPath), { recursive: true });
  writeFileSync(
    commandPath,
    platform === "win32"
      ? "@echo off\r\necho codex-cli product-discovery-test\r\n"
      : "#!/bin/sh\necho 'codex-cli product-discovery-test'\n",
    "utf8",
  );
  chmodSync(commandPath, executable ? 0o755 : 0o644);
  return commandPath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
