import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommandInvocation } from "../kernel/discovery.js";
import type { BridgeState } from "../server/bridge-types.js";
import { defaultBridgeSettings } from "../server/bridge-settings-store.js";
import {
  cleanupStaleKernelLoginSessions,
  describeKernelLogins,
  expireKernelLoginSessions,
  kernelLoginRouteProfiles,
  kernelLoginSession,
  startKernelLoginAction,
  type KernelLoginActionRuntime,
} from "../server/kernel-login.js";
import { cleanupStaleSystemTerminalRoots, systemTerminalScript } from "../server/system-terminal.js";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "opengrove-kernel-login-"));
  try {
    const codex = fakeCli(
      root,
      "codex",
      `
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("codex-test 1.0.0");
else if (args === "login status") console.log("Logged in using ChatGPT");
else if (args === "login --device-auth") console.log('Open https://example.test/device and enter ABCD-EFGH\\n{"refresh_token":"private-test-refresh-token"}');
else if (args === "logout") console.log("Logged out");
else process.exitCode = 1;
`,
    );
    const claude = fakeCli(
      root,
      "claude",
      `
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("claude-test 1.0.0");
else if (args === "auth status --json") console.log(JSON.stringify({ loggedIn: false }));
else if (args === "auth login") console.log("Continue in the browser");
else if (args === "auth logout") console.log("Logged out");
else process.exitCode = 1;
`,
    );
    const kimi = fakeCli(
      root,
      "kimi",
      `
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("kimi-test 1.0.0");
else if (args === "login") console.log("Enter device code KIMI-CODE");
else process.exitCode = 1;
`,
    );
    const kimiHome = join(root, "kimi-home");
    mkdirSync(join(kimiHome, "credentials"), { recursive: true });
    writeFileSync(
      join(kimiHome, "credentials", "kimi-code.json"),
      `${JSON.stringify({ refresh_token: "private-test-refresh-token" })}\n`,
      "utf8",
    );

    const state = {
      settings: {
        ...defaultBridgeSettings(),
        kernelProxy: {
          enabled: true,
          proxyUrl: "http://127.0.0.1:17890",
          noProxy: "localhost,127.0.0.1",
          nodeUseEnvProxy: false,
        },
        kernelPathOverrides: {
          codex: { binaryPath: codex, configHome: join(root, "codex-home") },
          "claude-code": { binaryPath: claude, configHome: join(root, "claude-home") },
          kimi: { binaryPath: kimi, configHome: kimiHome },
        },
      },
    } as unknown as BridgeState;

    const logins = await describeKernelLogins(state);
    assert.deepEqual(
      logins.map((login) => [login.kernelId, login.status]),
      [
        ["codex", "authenticated"],
        ["claude-code", "missing"],
        ["kimi", "authenticated"],
      ],
      "Kernel Login status must be independent from the Host Provider directory",
    );
    assert.equal(
      logins.some((login) => login.kernelId === "hermes"),
      false,
    );
    const activeClaudePath = state.settings.kernelPathOverrides["claude-code"]?.binaryPath;
    const missingClaudePath = join(root, "missing-claude");
    state.settings.kernelPathOverrides["claude-code"] = {
      ...state.settings.kernelPathOverrides["claude-code"],
      binaryPath: missingClaudePath,
    };
    const unavailableClaude = (await describeKernelLogins(state)).find((login) => login.kernelId === "claude-code");
    assert.deepEqual(
      unavailableClaude,
      {
        kernelId: "claude-code",
        label: "Claude Agent",
        status: "unavailable",
        loginAvailable: false,
        logoutAvailable: false,
        configuredCommand: missingClaudePath,
        configuredCommandIssue: "missing",
      },
      "a stale configured CLI path must remain diagnosable and resettable",
    );
    state.settings.kernelPathOverrides["claude-code"] = {
      ...state.settings.kernelPathOverrides["claude-code"],
      binaryPath: activeClaudePath,
    };
    assert.deepEqual(
      kernelLoginRouteProfiles(state).map((profile) => [profile.sourceKernel, profile.id, profile.models[0]?.id]),
      [["kimi", "$login:kimi", "kimi-default"]],
      "only authenticated account Login routes may enter selectors, never Kernel Provider configuration",
    );

    let launchedCommand: Parameters<KernelLoginActionRuntime["launchTerminal"]>[0] | undefined;
    const started = startKernelLoginAction(
      state,
      "codex",
      "login",
      fakeTerminalRuntime(root, (command) => {
        launchedCommand = command;
      }),
    );
    const finished = await waitForSession(started.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(
      launchedCommand?.command,
      process.execPath,
      "Login must resolve Node scripts before opening the terminal",
    );
    assert.deepEqual(launchedCommand?.args, [codex, "login", "--device-auth"]);
    assert.equal(launchedCommand?.environment.HTTPS_PROXY, "http://127.0.0.1:17890");
    assert.equal(launchedCommand?.environment.CODEX_HOME, join(root, "codex-home"));
    assert.equal(finished.output, "", "interactive CLI output must stay in the system terminal");

    const generatedScript = join(root, "generated-login.sh");
    const generatedResult = join(root, "generated-exit-code");
    writeFileSync(generatedScript, systemTerminalScript(launchedCommand, generatedResult, "linux"), { mode: 0o700 });
    const generatedRun = spawnSync("/bin/sh", [generatedScript], { encoding: "utf8" });
    assert.equal(generatedRun.status, 0, generatedRun.stderr);
    assert.equal(readFileSync(generatedResult, "utf8"), "0");
    for (const extension of ["cmd", "bat"]) {
      const windowsCommand = `C:\\Program Files\\OpenGrove\\codex.${extension}`;
      const windowsInvocation = resolveCommandInvocation(windowsCommand, ["login"], {
        platform: "win32",
        environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      });
      const windowsScript = systemTerminalScript(
        {
          ...launchedCommand,
          command: windowsInvocation.command,
          args: windowsInvocation.args,
        },
        "C:\\Temp\\exit-code",
        "win32",
      );
      assert.match(windowsScript, /cmd\.exe'/i);
      assert.ok(
        windowsScript.includes(windowsCommand),
        `Windows .${extension} Login must remain in the generated terminal script`,
      );
      const failureMessageOffset = windowsScript.indexOf("Login failed");
      const failurePauseOffset = windowsScript.indexOf("Read-Host");
      const exitOffset = windowsScript.lastIndexOf("exit $opengroveStatus");
      assert.ok(
        failureMessageOffset >= 0 && failurePauseOffset > failureMessageOffset && exitOffset > failurePauseOffset,
        "a failed Windows Login must remain readable until the user closes the terminal",
      );
    }

    let timeoutCleanupRoot = "";
    let timeoutLauncher: ReturnType<typeof spawn> | undefined;
    const hanging = startKernelLoginAction(state, "codex", "login", {
      launchTerminal() {
        timeoutCleanupRoot = mkdtempSync(join(root, "terminal-timeout-"));
        timeoutLauncher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        return {
          cleanupRoot: timeoutCleanupRoot,
          resultPath: join(timeoutCleanupRoot, "exit-code"),
          launcher: timeoutLauncher,
        };
      },
    });
    expireKernelLoginSessions(Number.MAX_SAFE_INTEGER);
    assert.equal(kernelLoginSession(hanging.id)?.status, "failed");
    assert.equal(existsSync(timeoutCleanupRoot), false, "server timeout must remove terminal session files");
    timeoutLauncher?.kill();

    const staleTempRoot = mkdtempSync(join(root, "temp-root-"));
    const staleTerminalRoot = join(staleTempRoot, "opengrove-kernel-login-stale");
    mkdirSync(staleTerminalRoot);
    cleanupStaleSystemTerminalRoots({ root: staleTempRoot, maxAgeMs: 1, now: Date.now() + 1_000 });
    assert.equal(existsSync(staleTerminalRoot), false, "stale terminal files must be swept on the next start");

    const importTempRoot = mkdtempSync(join(root, "import-temp-root-"));
    const importTerminalRoot = join(importTempRoot, "opengrove-kernel-login-import-side-effect");
    mkdirSync(importTerminalRoot);
    const staleTime = new Date(Date.now() - 20 * 60_000);
    utimesSync(importTerminalRoot, staleTime, staleTime);
    const importProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(new URL("../server/kernel-login.js", import.meta.url).href)});`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: importTempRoot },
      },
    );
    assert.equal(importProbe.status, 0, importProbe.stderr);
    assert.equal(
      existsSync(importTerminalRoot),
      true,
      "importing kernel-login must not scan or mutate the system temporary directory",
    );
    cleanupStaleKernelLoginSessions({ root: importTempRoot, now: Date.now() });
    assert.equal(
      existsSync(importTerminalRoot),
      false,
      "the bridge startup cleanup must remove stale terminal roots when called explicitly",
    );
    console.log("✓ Kernel-native login status and actions stay outside Provider state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeTerminalRuntime(
  root: string,
  observe: (command: Parameters<KernelLoginActionRuntime["launchTerminal"]>[0]) => void,
): KernelLoginActionRuntime {
  return {
    launchTerminal(command) {
      observe(command);
      const cleanupRoot = mkdtempSync(join(root, "terminal-"));
      const resultPath = join(cleanupRoot, "exit-code");
      const environment = { ...process.env, ...command.environment };
      for (const key of command.unsetEnvironment) environment[key] = undefined;
      const launcher = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: environment,
        stdio: "ignore",
      });
      launcher.once("close", (code) => writeFileSync(resultPath, String(code ?? 1), "utf8"));
      return { cleanupRoot, resultPath, launcher };
    },
  };
}

function fakeCli(root: string, name: string, body: string): string {
  const path = join(root, `${name}.mjs`);
  writeFileSync(path, body.trimStart(), "utf8");
  chmodSync(path, 0o755);
  return path;
}

async function waitForSession(id: string): Promise<NonNullable<ReturnType<typeof kernelLoginSession>>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const session = kernelLoginSession(id);
    if (session && session.status !== "running") return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("kernel_login_session_test_timed_out");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
