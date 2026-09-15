import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[3];
const targets = {
  "windows-x64": {
    platform: "win32",
    arch: "x64",
    flag: "--win",
    kind: "nsis",
    stage: "windows",
    artifact: "win32-x64",
  },
  "mac-arm64": {
    platform: "darwin",
    arch: "arm64",
    flag: "--mac",
    kind: "dmg",
    stage: "mac",
    artifact: "darwin-arm64",
  },
};
const spec = targets[target];
if (process.argv[2] !== "--target" || !spec || process.platform !== spec.platform || process.arch !== spec.arch) {
  throw new Error("Desktop CI requires --target windows-x64 or mac-arm64 on a matching native runner");
}
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const phases = [
  ["build", "scripts/build.mjs"],
  ["generated-source", "scripts/check-generated-source.mjs"],
  ["minify", "scripts/minify-dist.mjs"],
  ["package-inputs", "scripts/check-desktop-package.mjs"],
  ["stage-runtime", "scripts/stage-desktop-runtime.mjs", "--target", spec.stage],
  [
    "package",
    "node_modules/electron-builder/cli.js",
    "--config",
    "electron-builder.yml",
    spec.flag,
    spec.kind,
    `--${spec.arch}`,
    "--publish",
    "never",
    "-c.npmRebuild=false",
    "-c.artifactName=OpenGrove-${version}-${os}-${arch}.${ext}",
  ],
  ["inventory", "scripts/check-desktop-artifact.mjs", "--target", spec.artifact],
  ["installed-startup", "scripts/smoke-desktop-installer.mjs", "--target", target],
  ["final-source", "scripts/check-generated-source.mjs"],
];
for (const [phase, script, ...args] of phases) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-release-timing-phase.mjs",
      "--timing-file",
      process.env.RELEASE_TIMING_FILE || join(".opengrove", "desktop-ci-timing.json"),
      "--command",
      "desktop-ci",
      "--version",
      version,
      "--phase",
      phase,
      ...(phase === "build" ? ["--reset"] : []),
      ...(phase === "final-source" ? ["--finish-run"] : []),
      "--",
      process.execPath,
      script,
      ...args,
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.error || result.status !== 0) throw new Error(`Desktop CI failed during ${phase}`);
}
