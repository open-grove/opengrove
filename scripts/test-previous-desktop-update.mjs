import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { readAsarPackageVersion } from "./asar-package-version.mjs";
import { desktopReleaseTargets } from "./desktop-release-targets.mjs";
import { processCommandMatchesExecutable } from "./process-command-path.mjs";
import { removeTemporaryTree } from "./temporary-cleanup.mjs";
import { sanitizedWindowsPowerShellEnv, windowsPowerShellExecutable } from "./windows-powershell-env.mjs";
import { seedWindowsInstallerFirewallState } from "./windows-installer-gate-state.mjs";
import { isWindowsExactExecutableRunning, stopWindowsExactExecutable } from "./windows-exact-process.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const target = desktopReleaseTargets(packageJson.version).find((item) => item.id === args.target);
if (!target || !args.previousInstaller) throw new Error("--target and --previous-installer are required");
if (target.buildPlatform !== process.platform || target.arch !== process.arch) {
  throw new Error(
    `${target.id} previous-version update gate requires a matching ${target.buildPlatform}-${target.arch} runner`,
  );
}
const releaseDir = resolve(args.releaseDir ?? join(projectRoot, "release", "desktop"));
const updaterDir = resolve(args.updaterDir ?? join(releaseDir, "updater"));
const previousInstaller = resolve(args.previousInstaller);
const candidateInstaller = join(releaseDir, target.installerFile);
const targetUpdaterDir = join(updaterDir, target.id);
for (const path of [
  previousInstaller,
  candidateInstaller,
  join(targetUpdaterDir, target.updaterFeed),
  join(releaseDir, target.updaterFile),
]) {
  if (!existsSync(path)) throw new Error(`previous-version update gate input is missing: ${path}`);
}

const tempRoot = mkdtempSync(join(tmpdir(), `opengrove-update-${target.id}-`));
const evidenceOut = resolve(
  args.evidenceOut ?? join(releaseDir, "release-gates", target.id, "previous_version_update.json"),
);
let executablePath;
let installedAppRoot;
let electronApp;
let page;
let server;
let restartedProcessStopped = false;
let windowsFirewallState;
const rendererLog = [];
const installRequestTimeoutMs = 180_000;
const cleanupTimeoutMs = 30_000;
const fixtureAccessToken = "release-gate-access";
const fixtureRefreshToken = "release-gate-refresh";
const fixtureSessionId = "release-gate-session";

try {
  ({ executablePath, installedAppRoot } = preparePreviousApplication());
  const previousVersion = readInstalledVersion(installedAppRoot);
  if (compareVersions(previousVersion, packageJson.version) >= 0) {
    throw new Error(
      `previous installer version ${previousVersion} must be lower than candidate ${packageJson.version}`,
    );
  }
  console.log(`test-previous-desktop-update: ${target.id} installed previous version ${previousVersion}.`);
  server = await startFixtureServer();
  const environment = isolatedEnvironment(tempRoot, server.baseUrl);
  // The updater gate models an already authenticated user of the immutable
  // previous release. Authentication transport itself is covered separately;
  // this gate must stay focused on discovery, download, install, and restart.
  seedFixtureAuthCookies(environment.OPENGROVE_DESKTOP_RELEASE_GATE_USER_DATA_DIR);
  electronApp = await launchElectronOverCdp({ executablePath, env: environment, timeout: 90_000 });
  page = await electronApp.firstWindow({ timeout: 60_000 });
  page.on("console", (message) => rendererLog.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => rendererLog.push(`[pageerror] ${error.stack || error.message}`));
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await waitForDesktopBridgeHealth(page, 90_000);

  const login = await page.evaluate(async () => {
    const desktop = window.openGroveDesktop;
    const response = await fetch(`${desktop.apiBase}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "release-gate@example.test",
        code: "123456",
        deviceName: "release-gate",
        platform: navigator.platform,
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  if (login.status !== 200) throw new Error(`fixture login failed: ${JSON.stringify(login)}`);
  await pollPage(
    page,
    async () => page.evaluate(() => window.openGroveDesktop.hasSavedAuthSession()),
    (saved) => saved === true,
    30_000,
  );
  console.log(`test-previous-desktop-update: ${target.id} previous app launched and authenticated.`);

  const downloaded = await downloadCandidateUpdate(page, 180_000);
  if (downloaded.stage !== "downloaded" || downloaded.latestVersion !== packageJson.version) {
    throw new Error(`previous app did not download candidate update: ${JSON.stringify(downloaded)}`);
  }
  console.log(`test-previous-desktop-update: ${target.id} candidate update downloaded.`);

  if (args.downloadOnly) {
    const downloadedAppProcess = electronApp.process();
    const downloadedAppExited =
      downloadedAppProcess.exitCode === null ? once(downloadedAppProcess, "exit") : Promise.resolve();
    stopInstalledApplication(executablePath);
    await withTimeout(
      downloadedAppExited,
      cleanupTimeoutMs,
      "previous app did not exit after download-only verification",
    );
    restartedProcessStopped = true;
    writeEvidence(evidenceOut, {
      schemaVersion: 1,
      gate: "previous_version_update_download",
      passed: true,
      target: target.id,
      previousInstaller: basename(previousInstaller),
      previousVersion,
      candidateVersion: packageJson.version,
      candidateReleaseNumber: packageJson.clientReleaseNumber,
      updaterFeed: target.updaterFeed,
      downloaded: true,
      installed: false,
      installation: "cloud-notarized-candidate-only",
      finishedAt: new Date().toISOString(),
    });
    console.log(
      `test-previous-desktop-update: ${target.id} ${previousVersion} -> ${packageJson.version} detected and downloaded; install/restart stays on the notarized cloud candidate.`,
    );
  } else {
    const electronProcess = electronApp.process();
    const exited = electronProcess.exitCode === null ? once(electronProcess, "exit") : Promise.resolve();
    await withTimeout(
      page
        .evaluate(() => window.openGroveDesktop.installClientUpdate())
        .catch((error) => {
          if (!page.isClosed()) throw error;
        }),
      installRequestTimeoutMs,
      "installClientUpdate did not return or close the previous app",
    );
    await withTimeout(exited, 180_000, "previous app did not exit for update installation");
    console.log(`test-previous-desktop-update: ${target.id} previous app exited for installation.`);
    await poll(
      async () => readInstalledVersion(installedAppRoot),
      (version) => version === packageJson.version,
      180_000,
    );
    console.log(`test-previous-desktop-update: ${target.id} candidate files installed.`);
    await poll(
      async () => isInstalledApplicationRunning(executablePath),
      (running) => running === true,
      180_000,
    );
    stopInstalledApplication(executablePath);
    restartedProcessStopped = true;

    writeEvidence(evidenceOut, {
      schemaVersion: 1,
      gate: "previous_version_update",
      passed: true,
      target: target.id,
      previousInstaller: basename(previousInstaller),
      previousVersion,
      candidateVersion: packageJson.version,
      candidateReleaseNumber: packageJson.clientReleaseNumber,
      updaterFeed: target.updaterFeed,
      installedVersion: readInstalledVersion(installedAppRoot),
      restarted: true,
      finishedAt: new Date().toISOString(),
    });
    console.log(
      `test-previous-desktop-update: ${target.id} ${previousVersion} -> ${packageJson.version} downloaded, installed, and restarted.`,
    );
  }
} catch (error) {
  mkdirSync(dirname(evidenceOut), { recursive: true });
  await page
    ?.screenshot({ path: join(dirname(evidenceOut), "previous-version-update-failure.png"), fullPage: true })
    .catch(() => undefined);
  writeFileSync(join(dirname(evidenceOut), "previous-version-update.log"), `${rendererLog.join("\n")}\n`);
  copyRuntimeLogs(dirname(evidenceOut));
  copyWindowsInstallerDiagnostics(dirname(evidenceOut));
  throw error;
} finally {
  if (electronApp) {
    await withTimeout(
      electronApp.close(),
      cleanupTimeoutMs,
      "timed out closing Electron during update-gate cleanup",
    ).catch((error) => {
      console.warn(error instanceof Error ? error.message : String(error));
      electronApp?.process().kill();
    });
  }
  if (executablePath && !restartedProcessStopped) stopInstalledApplication(executablePath);
  server?.forceClose();
  if (server) {
    await withTimeout(server.close(), cleanupTimeoutMs, "timed out closing update fixture server").catch((error) => {
      console.warn(error instanceof Error ? error.message : String(error));
    });
  }
  try {
    windowsFirewallState?.restore();
  } finally {
    removeTemporaryTree(tempRoot);
  }
}

function preparePreviousApplication() {
  if (process.platform === "darwin") {
    const mountPoint = join(tempRoot, "previous-mount");
    mkdirSync(mountPoint);
    execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, previousInstaller], {
      stdio: "pipe",
    });
    try {
      const source = join(mountPoint, "OpenGrove.app");
      const destination = join(tempRoot, "installed", "OpenGrove.app");
      mkdirSync(dirname(destination), { recursive: true });
      execFileSync("ditto", [source, destination], { stdio: "pipe" });
      return { installedAppRoot: destination, executablePath: join(destination, "Contents", "MacOS", "OpenGrove") };
    } finally {
      spawnSync("hdiutil", ["detach", mountPoint, "-force"], { stdio: "ignore" });
    }
  }
  const root = join(tempRoot, "installed");
  mkdirSync(root);
  // v0.5.7 already required an interactive UAC grant for first-install
  // firewall provisioning. The updater gate runs headlessly, so model the
  // idempotent state left by that successful interactive installation.
  windowsFirewallState = seedWindowsInstallerFirewallState(root);
  const result = spawnSync(previousInstaller, ["/S", `/D=${root}`], { encoding: "utf8", timeout: 300_000 });
  if (result.error || result.status !== 0)
    throw new Error(`previous NSIS install failed: ${result.error?.message || result.stderr || result.status}`);
  const executable = findFile(root, "OpenGrove.exe");
  if (!executable) throw new Error("previous NSIS installer did not install OpenGrove.exe");
  return { installedAppRoot: dirname(executable), executablePath: executable };
}

async function launchElectronOverCdp({ executablePath: path, env, timeout }) {
  const child = spawn(path, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const endpoint = await waitForCdpEndpoint(child, () => `${stdout}\n${stderr}`, timeout);
    const browser = await chromium.connectOverCDP(endpoint, { timeout });
    return {
      process: () => child,
      firstWindow: ({ timeout: windowTimeout }) =>
        waitForFirstWindow(browser, child, () => `${stdout}\n${stderr}`, windowTimeout),
      close: async () => {
        if (browser.isConnected()) await browser.close();
        if (child.exitCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      },
    };
  } catch (error) {
    if (child.exitCode === null) child.kill();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to connect to packaged Electron over CDP: ${detail}\n${stdout}\n${stderr}`);
  }
}

function waitForCdpEndpoint(child, output, timeoutMs) {
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onOutput);
      child.off("error", onError);
      child.off("exit", onExit);
      callback(value);
    };
    const onOutput = () => {
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(output());
      if (match) finish(resolveEndpoint, match[1]);
    };
    const onError = (error) => finish(rejectEndpoint, error);
    const onExit = (code, signal) =>
      finish(rejectEndpoint, new Error(`packaged Electron exited before exposing CDP: ${code ?? signal}\n${output()}`));
    const timer = setTimeout(
      () => finish(rejectEndpoint, new Error(`timed out waiting for packaged Electron CDP endpoint\n${output()}`)),
      timeoutMs,
    );
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", onError);
    child.once("exit", onExit);
    onOutput();
  });
}

async function waitForFirstWindow(browser, child, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`packaged Electron exited before opening a window: ${child.exitCode}\n${output()}`);
    }
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => !candidate.isClosed());
    if (page) return page;
    await delay(100);
  }
  throw new Error(`timed out waiting for packaged Electron window\n${output()}`);
}

async function startFixtureServer() {
  const files = new Map();
  for (const name of readdirSync(targetUpdaterDir))
    files.set(`/updater/${target.id}/${name}`, join(targetUpdaterDir, name));
  files.set(`/updater/${target.id}/${target.updaterFile}`, join(releaseDir, target.updaterFile));
  if (existsSync(join(releaseDir, target.updaterBlockmap))) {
    files.set(`/updater/${target.id}/${target.updaterBlockmap}`, join(releaseDir, target.updaterBlockmap));
  }
  files.set(`/installers/${target.installerFile}`, candidateInstaller);
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/v1/auth/email-login") {
      sendJson(response, 200, {
        data: {
          access_token: fixtureAccessToken,
          access_token_expires_in: 3600,
          refresh_token: fixtureRefreshToken,
          refresh_token_expires_in: 3600,
          token_type: "Bearer",
        },
        request_id: "release-gate-login",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/users/me") {
      sendJson(response, 200, {
        data: { user_id: "release-gate-user", email: "release-gate@example.test", role: "member" },
        request_id: "release-gate-user",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/api-keys") {
      sendJson(response, 200, { data: null, request_id: "release-gate-keys" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/api-keys") {
      sendJson(response, 201, {
        data: {
          id: "release-gate-key",
          name: "OpenGrove WW Provider",
          key_prefix: "ww_sk_release",
          status: "active",
          api_key: "ww_sk_release_gate_secret",
          created_at: new Date().toISOString(),
        },
        request_id: "release-gate-key",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/client/latest-version") {
      const base = `http://127.0.0.1:${httpServer.address().port}`;
      const entry = {
        version: packageJson.clientReleaseNumber,
        released_at: new Date().toISOString(),
        download_url: `${base}/installers/${target.installerFile}`,
        release_notes: "release gate candidate",
        file: target.installerFile,
        arch: target.arch,
        updater_base_url: `${base}/updater/${target.id}`,
        updater_feed_url: `${base}/updater/${target.id}/${target.updaterFeed}`,
      };
      const key = target.platform === "mac" ? `mac_${target.arch}` : `windows_${target.arch}`;
      const alias = target.platform === "mac" ? "mac" : "windows";
      sendJson(response, 200, { [key]: entry, [alias]: entry });
      return;
    }
    const file = files.get(url.pathname);
    if (file && (request.method === "GET" || request.method === "HEAD")) {
      sendFile(request, response, file);
      return;
    }
    sendJson(response, 404, { error: { code: 404, message: "release gate fixture" } });
  });
  await new Promise((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
  return {
    baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        httpServer.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
    forceClose: () => httpServer.closeAllConnections(),
  };
}

function sendFile(request, response, path) {
  const size = statSync(path).size;
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), end) : end;
    if (start > end || start >= size) {
      response.writeHead(416, { "content-range": `bytes */${size}` });
      response.end();
      return;
    }
    status = 206;
  }
  response.writeHead(status, {
    "accept-ranges": "bytes",
    "content-length": String(end - start + 1),
    "content-type": contentType(path),
    ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start, end }).pipe(response);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".yml") return "text/yaml";
  if (extension === ".zip") return "application/zip";
  if (extension === ".exe") return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

function readInstalledVersion(root) {
  const resources = process.platform === "darwin" ? join(root, "Contents", "Resources") : join(root, "resources");
  return readAsarPackageVersion(join(resources, "app.asar"));
}

function isolatedEnvironment(root, wwBaseUrl) {
  const temporary = join(root, "tmp");
  mkdirSync(temporary, { recursive: true });
  const common = {
    ...process.env,
    OPENGROVE_DESKTOP_RELEASE_GATE: "1",
    OPENGROVE_DESKTOP_RELEASE_GATE_LOG: join(temporary, "opengrove-installer-gate.log"),
    OPENGROVE_DESKTOP_RELEASE_GATE_USER_DATA_DIR: join(root, "user-data"),
    OPENGROVE_WW_BASE_URL: wwBaseUrl,
  };
  if (process.platform === "win32") {
    const roaming = join(root, "AppData", "Roaming");
    const local = join(root, "AppData", "Local");
    mkdirSync(roaming, { recursive: true });
    mkdirSync(local, { recursive: true });
    return { ...common, USERPROFILE: root, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temporary, TMP: temporary };
  }
  return { ...common, HOME: root, TMPDIR: temporary };
}

function seedFixtureAuthCookies(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  const expiresAt = Date.now() + 3_600_000;
  writeFileSync(
    join(userDataDir, "auth-cookies.json"),
    JSON.stringify({
      version: 1,
      cookies: {
        opengrove_auth_access: { value: fixtureAccessToken, expiresAt },
        opengrove_auth_refresh: { value: fixtureRefreshToken, expiresAt },
        opengrove_auth_session: { value: fixtureSessionId, expiresAt },
      },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
}

function stopInstalledApplication(path) {
  if (process.platform === "win32") {
    stopWindowsExactExecutable(path);
  } else {
    spawnSync("pkill", ["-f", path], { stdio: "ignore" });
  }
}

function isInstalledApplicationRunning(path) {
  if (process.platform === "win32") {
    return isWindowsExactExecutableRunning(path);
  }
  const result = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) return false;
  return result.stdout.split("\n").some((command) => processCommandMatchesExecutable(command, path));
}

function findFile(root, name) {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function pollPage(pageValue, read, accept, timeoutMs) {
  return poll(read, accept, timeoutMs, () => pageValue.isClosed());
}

async function waitForDesktopBridgeHealth(pageValue, timeoutMs) {
  await pollPage(
    pageValue,
    async () =>
      pageValue.evaluate(async () => {
        try {
          const desktop = window.openGroveDesktop;
          const response = await fetch(`${desktop.apiBase}/health`, { cache: "no-store" });
          return { status: response.status, body: await response.json() };
        } catch (error) {
          return { status: 0, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    (health) => health.status === 200 && health.body?.ok === true && health.body?.name === "opengrove-local-bridge",
    timeoutMs,
  );
}

async function downloadCandidateUpdate(pageValue, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await pageValue.evaluate(() => window.openGroveDesktop.checkForClientUpdate());
    if (last.stage === "idle" && !last.busy) {
      // A startup/focus check can begin just before the login response reaches
      // the main-process cookie jar. The IPC call then joins that older check;
      // retry only this explicit release-gate action after authentication is saved.
      console.warn("test-previous-desktop-update: retrying update check after a pre-authentication background check.");
      await delay(1_000);
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    last = await pollPage(
      pageValue,
      async () => pageValue.evaluate(() => window.openGroveDesktop.getClientUpdateState()),
      (state) => ["downloaded", "error", "idle", "up-to-date"].includes(state.stage),
      remainingMs,
    );
    if (last.stage !== "idle") return last;
    console.warn("test-previous-desktop-update: retrying update check after authentication became available.");
    await delay(1_000);
  }
  throw new Error(`timed out waiting for candidate update download; last=${JSON.stringify(last)}`);
}

async function poll(read, accept, timeoutMs, cancelled = () => false) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error("desktop window closed before update gate completed");
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`timed out waiting for update gate; last=${typeof last === "string" ? last : JSON.stringify(last)}`);
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/).map(Number);
  const b = right.split(/[.-]/).map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function writeEvidence(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function copyRuntimeLogs(failureDir) {
  const path = join(tempRoot, "user-data", "logs");
  if (existsSync(path)) cpSync(path, join(failureDir, "previous-version-runtime-logs"), { recursive: true });
}

function copyWindowsInstallerDiagnostics(failureDir) {
  if (process.platform !== "win32") return;
  const gateLog = join(tempRoot, "tmp", "opengrove-installer-gate.log");
  if (existsSync(gateLog)) cpSync(gateLog, join(failureDir, "windows-installer-gate.log"));
  const script = [
    "$items = Get-CimInstance Win32_Process |",
    "  Where-Object { $_.Name -like 'OpenGrove*' -or $_.ExecutablePath -like '*OpenGrove*' } |",
    "  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath",
    "$items | Format-List | Out-String -Width 4096",
  ].join("\n");
  const result = spawnSync(windowsPowerShellExecutable, ["-NoProfile", "-Command", script], {
    env: sanitizedWindowsPowerShellEnv(process.env),
    encoding: "utf8",
  });
  writeFileSync(
    join(failureDir, "windows-installer-processes.txt"),
    `status=${result.status}\n${result.stdout || ""}${result.stderr || ""}`,
  );
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--target") result.target = readRequired(values, ++index, value);
    else if (value.startsWith("--target=")) result.target = value.slice("--target=".length);
    else if (value === "--previous-installer") result.previousInstaller = readRequired(values, ++index, value);
    else if (value.startsWith("--previous-installer="))
      result.previousInstaller = value.slice("--previous-installer=".length);
    else if (value === "--release-dir") result.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) result.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--updater-dir") result.updaterDir = readRequired(values, ++index, value);
    else if (value.startsWith("--updater-dir=")) result.updaterDir = value.slice("--updater-dir=".length);
    else if (value === "--evidence-out") result.evidenceOut = readRequired(values, ++index, value);
    else if (value.startsWith("--evidence-out=")) result.evidenceOut = value.slice("--evidence-out=".length);
    else if (value === "--download-only") result.downloadOnly = true;
    else throw new Error(`Unknown previous-version update option: ${value}`);
  }
  return result;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
