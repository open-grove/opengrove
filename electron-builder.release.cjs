// 正式发布打包配置：以 electron-builder.yml 为基底，仅覆盖签名/公证相关开关。
// 用法：electron-builder --config electron-builder.release.cjs（由 dist:desktop:release 调用，
// 前置 scripts/preflight-desktop-release.mjs 保证凭证齐全，缺凭证不会走到这里）。
// 日常开发打包（pack:desktop / dist:desktop）继续使用 electron-builder.yml，不受影响。
const { existsSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { isAbsolute, join } = require("node:path");
const { load } = require("js-yaml");

const config = load(readFileSync(join(__dirname, "electron-builder.yml"), "utf8"));

config.extraMetadata = {
  ...config.extraMetadata,
  opengroveOfficialRelease: true,
};

// Fail closed even when somebody invokes electron-builder with this config
// directly instead of going through the release orchestration script.
config.beforePack = async () => {
  execFileSync(process.execPath, [join(__dirname, "scripts/check-web-fixture-account-boundary.mjs")], {
    cwd: __dirname,
    stdio: "inherit",
  });
};

// macOS architectures are packaged in parallel from the same read-only
// dependency tree. OpenGrove has no packaged native Node addons, so rebuilding
// node_modules per architecture is unnecessary and would introduce a write race.
config.npmRebuild = false;

// Local preflight keeps credentials and product configuration isolated, while
// reusing only the already-downloaded Electron archive. CI does not set these.
const localElectronDist = process.env.OPENGROVE_ELECTRON_DIST;
const localElectronDownloadCache = process.env.OPENGROVE_ELECTRON_DOWNLOAD_CACHE;
if (localElectronDist) {
  if (!isAbsolute(localElectronDist) || !existsSync(localElectronDist)) {
    throw new Error(`OPENGROVE_ELECTRON_DIST must be an existing absolute archive path: ${localElectronDist}`);
  }
  config.electronDist = localElectronDist;
} else if (localElectronDownloadCache) {
  if (!isAbsolute(localElectronDownloadCache)) {
    throw new Error(`OPENGROVE_ELECTRON_DOWNLOAD_CACHE must be absolute: ${localElectronDownloadCache}`);
  }
  config.electronDownload = { cache: localElectronDownloadCache };
}

// Formal packages must fail closed when a platform signing identity is unavailable.
config.forceCodeSigning = true;
// Windows Authenticode 证书采购前的临时豁免；限定 win32,变量泄漏也不会影响 macOS 签名。
// forceCodeSigning=false 只是不强制,残留凭证仍会触发 electron-builder 签名,所以直接报错。
if (process.platform === "win32" && process.env.OPENGROVE_ALLOW_UNSIGNED_WINDOWS === "1") {
  if (process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD) {
    throw new Error(
      "OPENGROVE_ALLOW_UNSIGNED_WINDOWS=1 conflicts with CSC_LINK/CSC_KEY_PASSWORD; unset them or drop the escape hatch",
    );
  }
  config.forceCodeSigning = false;
}

// 基底里 identity: "-" 只用于开发包的 ad-hoc 签名；删除后恢复
// keychain 自动发现（或 CSC_LINK），正式发布不得回退到 ad-hoc identity。
delete config.mac.identity;
config.mac.hardenedRuntime = true;
// 公证凭证从环境变量读取（APPLE_API_KEY/APPLE_ID/APPLE_KEYCHAIN_PROFILE 三选一），
// electron-builder 缺凭证时只告警不失败，因此 preflight 必须先行。
// 默认 release 编排改为外部提交/轮询，避免 electron-builder 内部的
// `notarytool submit --wait` 在 Apple 队列慢时无限卡住。
config.mac.notarize = process.env.OPENGROVE_DEFER_NOTARIZATION === "1" ? false : true;

const artifactName = "${productName}-${version}-${os}-${arch}.${ext}";
const isolatedMacArch = process.env.OPENGROVE_DESKTOP_ARCH;
if (isolatedMacArch && isolatedMacArch !== "arm64" && isolatedMacArch !== "x64") {
  throw new Error(`Invalid OPENGROVE_DESKTOP_ARCH: ${isolatedMacArch}`);
}
const macTargetArches = isolatedMacArch ? [isolatedMacArch] : ["arm64", "x64"];
config.mac.target = [
  { target: "dmg", arch: macTargetArches },
  { target: "zip", arch: macTargetArches },
];
config.mac.artifactName = artifactName;
if (process.env.OPENGROVE_DESKTOP_OUTPUT_DIR) {
  config.directories.output = process.env.OPENGROVE_DESKTOP_OUTPUT_DIR;
}
config.dmg = { ...config.dmg, sign: true };
config.nsis = { ...config.nsis, artifactName };
config.win = { ...config.win, artifactName };
config.linux = { ...config.linux, artifactName };

module.exports = config;
