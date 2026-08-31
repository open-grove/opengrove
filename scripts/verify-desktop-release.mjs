import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedWindowsPowerShellEnv, windowsPowerShellExecutable } from "./windows-powershell-env.mjs";

// 正式包收尾校验：确认签名/公证/staple 真实生效（Gatekeeper 视角）。
// 在 dist:desktop:release 的最后一步运行；开发打包（pack:desktop / dist:desktop）不走这里。
// macOS 同时校验 .app 本体和最终分发的 DMG 外壳；Windows 正式包必须通过
// Authenticode 签名、时间戳和预期证书校验。校验和由聚合发布器统一生成。

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const releaseDir = join(projectRoot, "release", "desktop");

if (process.platform === "darwin") {
  verifyMacApps();
  verifyMacDmgs();
} else if (process.platform === "win32") {
  verifyWindowsArtifacts();
}
console.log("verify-desktop-release: 全部校验通过。");

function verifyMacApps() {
  const apps = resolveMacApps();
  for (const app of apps) {
    verifyMacApp(app.path, app.arch);
  }
  console.log(`macOS 签名/公证/staple 校验通过：${apps.map((app) => app.arch).join(", ")}。`);
}

function verifyMacApp(appPath, arch) {
  console.log(`校验 ${appPath}`);

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], "codesign 校验 .app 失败");
  const enginePath = resolveBundledEngine(appPath, arch);
  if (enginePath) {
    run("codesign", ["--verify", "--strict", "--verbose=2", enginePath], "codesign 校验内置 Claude 引擎失败");
  } else {
    fail(`未找到 ${arch} 内置 Claude 引擎，无法校验其签名`);
  }

  const details = capture("codesign", ["-dv", "--verbose=2", appPath]);
  if (!details.includes("Developer ID Application")) {
    fail(`签名身份不是 Developer ID Application（当前为 adhoc 或开发证书）：\n${firstLines(details, 6)}`);
  }

  const assess = capture("spctl", ["--assess", "--type", "execute", "-vv", appPath], { allowFailure: true });
  if (!/accepted/.test(assess) || !/Notarized Developer ID/.test(assess)) {
    fail(`Gatekeeper 未放行（需要 accepted + Notarized Developer ID）：\n${firstLines(assess, 6)}`);
  }

  run("xcrun", ["stapler", "validate", appPath], "公证票据未 staple 到 .app");
}

function verifyMacDmgs() {
  const dmgs = resolveMacDmgs();
  for (const dmgPath of dmgs) {
    verifyMacDmg(dmgPath);
  }
  console.log(`macOS DMG 签名/公证/staple 校验通过：${dmgs.map((path) => path.split(/[\\/]/).pop()).join(", ")}。`);
}

function verifyMacDmg(dmgPath) {
  console.log(`校验 ${dmgPath}`);
  run("codesign", ["--verify", "--verbose=2", dmgPath], "codesign 校验 DMG 失败");
  run("xcrun", ["stapler", "validate", dmgPath], "公证票据未 staple 到 DMG");

  const assess = capture(
    "spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmgPath],
    { allowFailure: true },
  );
  if (!/accepted/.test(assess) || !/Notarized Developer ID/.test(assess)) {
    fail(`Gatekeeper 未放行 DMG（需要 accepted + Notarized Developer ID）：\n${firstLines(assess, 6)}`);
  }
}

function resolveMacApps() {
  const candidates = [
    { arch: "arm64", path: join(releaseDir, "mac-arm64", "OpenGrove.app") },
    { arch: "x64", path: join(releaseDir, "mac-x64", "OpenGrove.app") },
    { arch: "x64", path: join(releaseDir, "mac", "OpenGrove.app") },
  ];
  const found = candidates.filter((candidate) => existsSync(candidate.path));
  if (found.length === 0) {
    fail(`未找到 .app 产物，检查过:\n${candidates.map((candidate) => candidate.path).join("\n")}`);
  }
  return found;
}

function resolveMacDmgs() {
  const dmgs = readdirSync(releaseDir)
    .filter((name) => /\.dmg$/i.test(name))
    .sort()
    .map((name) => join(releaseDir, name));
  if (dmgs.length === 0) {
    fail(`release/desktop 下没有 DMG 产物`);
  }
  return dmgs;
}

function resolveBundledEngine(appPath, arch) {
  const base = join(appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules", "@anthropic-ai");
  const packageName = `claude-agent-sdk-darwin-${arch}`;
  const candidate = join(base, packageName, "claude");
  return existsSync(candidate) ? candidate : undefined;
}

function verifyWindowsArtifacts() {
  const artifacts = readdirSync(releaseDir)
    .filter((name) => /\.exe$/i.test(name))
    .map((name) => join(releaseDir, name));
  if (artifacts.length === 0) {
    fail(`release/desktop 下没有可验签的 Windows .exe 产物`);
  }
  if (process.env.OPENGROVE_ALLOW_UNSIGNED_WINDOWS === "1") {
    for (const artifact of artifacts) {
      verifyWindowsUnsigned(artifact);
    }
    console.warn("OPENGROVE_ALLOW_UNSIGNED_WINDOWS=1：产物已确认为未签名（临时豁免，证书到位后移除该变量）。");
    return;
  }
  if (!process.env.OPENGROVE_WINDOWS_SIGNING_SUBJECT && !process.env.OPENGROVE_WINDOWS_SIGNING_THUMBPRINT) {
    fail("Windows 验签需要 OPENGROVE_WINDOWS_SIGNING_SUBJECT 或 OPENGROVE_WINDOWS_SIGNING_THUMBPRINT");
  }
  for (const artifact of artifacts) {
    verifyWindowsSignature(artifact);
  }
  console.log("Windows Authenticode 签名/时间戳校验通过。");
}

function verifyWindowsSignature(filePath) {
  const expectedSubject = process.env.OPENGROVE_WINDOWS_SIGNING_SUBJECT || "";
  const expectedThumbprint = (process.env.OPENGROVE_WINDOWS_SIGNING_THUMBPRINT || "").replace(/\s+/g, "").toUpperCase();
  const script = `
$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$sig = Get-AuthenticodeSignature -FilePath $env:OPENGROVE_VERIFY_TARGET
if ($sig.Status -ne "Valid") {
  Write-Error "Authenticode status is $($sig.Status): $($sig.StatusMessage)"
}
if (-not $sig.SignerCertificate) {
  Write-Error "Signer certificate is missing"
}
if (-not $sig.TimeStamperCertificate) {
  Write-Error "Timestamp countersignature is missing"
}
$subject = [string]$sig.SignerCertificate.Subject
$thumbprint = ([string]$sig.SignerCertificate.Thumbprint).Replace(" ", "").ToUpperInvariant()
if ($env:OPENGROVE_WINDOWS_SIGNING_SUBJECT -and -not $subject.Contains($env:OPENGROVE_WINDOWS_SIGNING_SUBJECT)) {
  Write-Error "Signer subject mismatch: $subject"
}
if ($env:OPENGROVE_WINDOWS_SIGNING_THUMBPRINT) {
  $expected = $env:OPENGROVE_WINDOWS_SIGNING_THUMBPRINT.Replace(" ", "").ToUpperInvariant()
  if ($thumbprint -ne $expected) {
    Write-Error "Signer thumbprint mismatch: $thumbprint"
  }
}
Write-Output "signed=$subject thumbprint=$thumbprint timestamp=$($sig.TimeStamperCertificate.Subject)"
`;
  try {
    const output = execFileSync(
      windowsPowerShellExecutable,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        env: sanitizedWindowsPowerShellEnv(process.env, {
          OPENGROVE_VERIFY_TARGET: filePath,
          OPENGROVE_WINDOWS_SIGNING_SUBJECT: expectedSubject,
          OPENGROVE_WINDOWS_SIGNING_THUMBPRINT: expectedThumbprint,
        }),
      },
    );
    console.log(`Windows 签名校验通过: ${filePath}\n${firstLines(output, 3)}`);
  } catch (error) {
    fail(`Windows Authenticode 校验失败: ${filePath}\n${firstLines(`${error.stdout || ""}${error.stderr || ""}`, 10)}`);
  }
}

function verifyWindowsUnsigned(filePath) {
  const script = `
$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$sig = Get-AuthenticodeSignature -FilePath $env:OPENGROVE_VERIFY_TARGET
if ($sig.Status -ne "NotSigned") {
  Write-Error "expected an unsigned artifact but Authenticode status is $($sig.Status)"
}
Write-Output "unsigned confirmed"
`;
  try {
    execFileSync(windowsPowerShellExecutable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      env: sanitizedWindowsPowerShellEnv(process.env, { OPENGROVE_VERIFY_TARGET: filePath }),
    });
    console.log(`Windows 未签名确认: ${filePath}`);
  } catch (error) {
    fail(
      `OPENGROVE_ALLOW_UNSIGNED_WINDOWS=1 但产物带有签名或状态异常: ${filePath}\n${firstLines(`${error.stdout || ""}${error.stderr || ""}`, 8)}`,
    );
  }
}

function run(command, args, message) {
  try {
    execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (error) {
    fail(`${message}\n${firstLines(`${error.stdout || ""}${error.stderr || ""}`, 8)}`);
  }
}

function capture(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) {
    fail(`${command} ${args.join(" ")} 执行失败\n${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    fail(`${command} ${args.join(" ")} 执行失败\n${firstLines(output, 8)}`);
  }
  return output;
}

function firstLines(text, count) {
  return text.split("\n").slice(0, count).join("\n");
}

function fail(message) {
  console.error(`verify-desktop-release: ${message}`);
  process.exit(1);
}
