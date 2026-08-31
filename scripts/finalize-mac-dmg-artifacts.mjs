import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macDmgRequiresSigning, resolveAppleNotaryCredentials } from "./desktop-release-credentials.mjs";
import { runCommand, runParallelTasks } from "./parallel-release-tasks.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const releaseDir = resolve(args.releaseDir ?? join(projectRoot, "release", "desktop"));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const credentials = resolveAppleNotaryCredentials();

if (process.platform !== "darwin") fail("finalize-mac-dmg-artifacts only runs on macOS");
if (!existsSync(releaseDir)) fail(`release directory does not exist: ${releaseDir}`);

const selectedArches = args.arches.length > 0 ? args.arches : ["arm64", "x64"];
const dmgs = selectedArches.map((arch) => ({
  arch,
  file: `OpenGrove-${packageJson.version}-mac-${arch}.dmg`,
  path: join(releaseDir, `OpenGrove-${packageJson.version}-mac-${arch}.dmg`),
}));
const missing = dmgs.filter((dmg) => !existsSync(dmg.path)).map((dmg) => dmg.file);
if (missing.length > 0) fail(`selected Mac release artifacts are missing ${missing.join(", ")}`);

await runParallelTasks(
  "DMG notarization",
  dmgs.map((dmg) => ({
    id: dmg.arch,
    run: () => finalizeDmg(dmg),
  })),
);

console.log(`finalize-mac-dmg-artifacts: finalized ${dmgs.map((dmg) => dmg.file).join(", ")}`);

async function finalizeDmg(dmg) {
  if (!args.force && (await isDmgGatekeeperReady(dmg.path))) {
    console.log(`finalize-mac-dmg-artifacts: ${dmg.file} is already signed, stapled, and Gatekeeper-accepted.`);
  } else {
    if (macDmgRequiresSigning({ signed: await isDmgSigned(dmg.path), force: args.force })) {
      await signDmg(dmg, resolveSigningIdentity());
    }
    await notarizeDmg(dmg);
    await stapleDmg(dmg);
    await verifyDmg(dmg);
  }
  rmSync(`${dmg.path}.blockmap`, { force: true });
}

async function signDmg(dmg, signingIdentity) {
  await runAsync("codesign", ["--force", "--sign", signingIdentity, "--timestamp", dmg.path]);
  await runAsync("codesign", ["--verify", "--verbose=4", dmg.path]);
}

async function isDmgSigned(path) {
  const result = await runCommand("codesign", ["--verify", "--verbose=2", path], {
    captureStdout: true,
    inheritStderr: false,
    allowFailure: true,
  });
  return result.status === 0;
}

function resolveSigningIdentity() {
  const signingIdentity =
    args.signingIdentity ||
    process.env.OPENGROVE_MAC_SIGNING_IDENTITY ||
    process.env.CSC_NAME ||
    findDeveloperIdIdentity();
  if (!signingIdentity) {
    throw new Error(
      "DMG is unsigned and no persistent Developer ID Application identity is available; formal electron-builder releases must sign DMGs before finalization",
    );
  }
  return signingIdentity;
}

async function notarizeDmg(dmg) {
  console.log(
    `\n$ xcrun notarytool submit ${dmg.path} ${credentials.redactedArgs.join(" ")} --output-format json --wait`,
  );
  const { stdout: output } = await runCommand(
    "xcrun",
    ["notarytool", "submit", dmg.path, ...credentials.args, "--output-format", "json", "--wait"],
    { captureStdout: true },
  );
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  const response = JSON.parse(output);
  if (response.status !== "Accepted") throw new Error(`DMG notarization was not Accepted for ${dmg.file}`);
}

async function stapleDmg(dmg) {
  await runAsync("xcrun", ["stapler", "staple", dmg.path]);
  await runAsync("xcrun", ["stapler", "validate", dmg.path]);
}

async function verifyDmg(dmg) {
  const { stdout, stderr } = await runCommand(
    "spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmg.path],
    { captureStdout: true, inheritStderr: false, allowFailure: true },
  );
  const assess = `${stdout}${stderr}`;
  if (!/accepted/.test(assess) || !/Notarized Developer ID/.test(assess)) {
    throw new Error(`Gatekeeper did not accept ${dmg.file}:\n${firstLines(assess, 8)}`);
  }
}

async function isDmgGatekeeperReady(path) {
  if (!(await isDmgSigned(path))) return false;
  const staple = await runCommand("xcrun", ["stapler", "validate", path], {
    captureStdout: true,
    inheritStderr: false,
    allowFailure: true,
  });
  if (staple.status !== 0) return false;
  const { stdout, stderr } = await runCommand(
    "spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", path],
    { captureStdout: true, inheritStderr: false, allowFailure: true },
  );
  const assess = `${stdout}${stderr}`;
  return /accepted/.test(assess) && /Notarized Developer ID/.test(assess);
}

function findDeveloperIdIdentity() {
  const output = capture("security", ["find-identity", "-v", "-p", "codesigning"], { allowFailure: true });
  for (const line of output.split("\n")) {
    const match = line.match(/"([^"]*Developer ID Application[^"]*)"/);
    if (match) return match[1];
  }
  return "";
}

async function runAsync(command, commandArgs) {
  console.log(`\n$ ${[command, ...commandArgs].join(" ")}`);
  await runCommand(command, commandArgs);
}

function capture(command, commandArgs, { allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) fail(`${command} ${commandArgs.join(" ")} failed\n${result.error.message}`);
  if (result.status !== 0 && !allowFailure) fail(`${command} failed\n${firstLines(output, 8)}`);
  return output;
}

function parseArgs(values) {
  const parsed = { force: false, arches: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--release-dir") parsed.releaseDir = readRequired(values, ++index, value);
    else if (value.startsWith("--release-dir=")) parsed.releaseDir = value.slice("--release-dir=".length);
    else if (value === "--arch") parsed.arches.push(readRequired(values, ++index, value));
    else if (value.startsWith("--arch=")) parsed.arches.push(value.slice("--arch=".length));
    else if (value === "--signing-identity") parsed.signingIdentity = readRequired(values, ++index, value);
    else if (value.startsWith("--signing-identity="))
      parsed.signingIdentity = value.slice("--signing-identity=".length);
    else if (value === "--force") parsed.force = true;
    else throw new Error(`Unknown finalize-mac-dmg-artifacts option: ${value}`);
  }
  if (parsed.arches.some((arch) => arch !== "arm64" && arch !== "x64")) {
    throw new Error("--arch must be arm64 or x64");
  }
  if (new Set(parsed.arches).size !== parsed.arches.length) {
    throw new Error("--arch must not contain duplicates");
  }
  return parsed;
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function firstLines(text, count) {
  return text.split("\n").slice(0, count).join("\n");
}

function fail(message) {
  console.error(`finalize-mac-dmg-artifacts: ${message}`);
  process.exit(1);
}
