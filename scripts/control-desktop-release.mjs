import { resolveReleaseUploadToken } from "./desktop-release-credentials.mjs";
import { releaseRequestSignal } from "./release-network.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const releasesUrl = requiredBaseUrl(
  args.releasesUrl ?? process.env.OPENGROVE_CLIENT_RELEASES_URL,
  "--releases-url / OPENGROVE_CLIENT_RELEASES_URL",
);
if (!args.yes) fail("refusing to change the active release pointer without --yes");

const credential = resolveReleaseUploadToken();
if (!credential.token) {
  fail(
    "a ww release control token is required; set OPENGROVE_RELEASE_UPLOAD_TOKEN or store the default OpenGrove Release Upload / ww Keychain item on macOS",
  );
}
if (credential.source === "keychain") {
  console.log("control-desktop-release: using the ww release token from macOS Keychain");
}

if (args.command === "withdraw") {
  await request(`${releasesUrl}/active`, "DELETE");
  console.log("control-desktop-release: active desktop release withdrawn; clients will receive no update candidate");
} else {
  const releaseNumber = requiredReleaseNumber(args.releaseNumber);
  await request(`${releasesUrl}/${releaseNumber}/promote`, "POST");
  const verb = args.command === "rollback" ? "repointed" : "promoted";
  console.log(`control-desktop-release: active pointer ${verb} to client release ${releaseNumber}`);
  if (args.command === "rollback") {
    console.log(
      "control-desktop-release: existing newer installations are not downgraded; this only stops offering the newer release to eligible clients",
    );
  }
}

async function request(url, method) {
  const response = await fetch(url, {
    method,
    signal: releaseRequestSignal(),
    headers: { authorization: `Bearer ${credential.token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    fail(`ww release control failed: HTTP ${response.status}${body ? ` ${body.slice(0, 500)}` : ""}`);
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if ((value === "-h" || value === "--help") && !result.command) result.help = true;
    else if (!result.command && ["promote", "rollback", "withdraw"].includes(value)) result.command = value;
    else if (result.command && result.command !== "withdraw" && !result.releaseNumber && !value.startsWith("--"))
      result.releaseNumber = value;
    else if (value === "--releases-url") result.releasesUrl = readRequired(values, ++index, value);
    else if (value.startsWith("--releases-url=")) result.releasesUrl = value.slice("--releases-url=".length);
    else if (value === "--yes") result.yes = true;
    else throw new Error(`Unknown control-desktop-release option: ${value}`);
  }
  if (!result.help && !result.command) throw new Error("Expected promote, rollback, or withdraw");
  return result;
}

function requiredReleaseNumber(value) {
  const number = Number(value);
  if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(number) || number <= 0) {
    fail("promote/rollback requires a positive clientReleaseNumber, for example 10012");
  }
  return number;
}

function requiredBaseUrl(value, name) {
  if (!value) fail(`${name} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be a valid URL`);
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) fail(`${name} must use HTTPS`);
  return url.href.replace(/\/+$/, "");
}

function readRequired(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/control-desktop-release.mjs promote CLIENT_RELEASE_NUMBER --yes [options]
  node scripts/control-desktop-release.mjs rollback CLIENT_RELEASE_NUMBER --yes [options]
  node scripts/control-desktop-release.mjs withdraw --yes [options]

Changes only ww's active desktop release pointer. Candidate registration is a
separate publish step. Rollback repoints the feed and does not force installed
clients to downgrade.

  --releases-url URL  ww /v1/admin/client/releases base endpoint
  --yes               Required explicit operator confirmation
`);
}

function fail(message) {
  console.error(`control-desktop-release: ${message}`);
  process.exit(1);
}
