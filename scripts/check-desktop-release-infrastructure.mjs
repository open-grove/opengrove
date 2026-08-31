import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyR2ReleaseAccess } from "./r2-release-upload.mjs";
import { releaseRequestSignal } from "./release-network.mjs";

const execFileAsync = promisify(execFile);
const WW_RELEASE_PATH = "/v1/admin/client/releases";
const WW_ATTEMPTS = 3;
const WW_RETRY_DELAY_MS = 1_000;
const requiredNames = [
  "OPENGROVE_RELEASE_OSS_REGION",
  "OPENGROVE_RELEASE_OSS_BUCKET",
  "OPENGROVE_RELEASE_OSS_ENDPOINT",
  "OPENGROVE_RELEASE_R2_BUCKET",
  "OPENGROVE_RELEASE_R2_ACCOUNT_ID",
  "OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT",
  "OPENGROVE_DESKTOP_RELEASE_UPDATER_ROOT",
  "OPENGROVE_CLIENT_RELEASES_URL",
  "OSS_ACCESS_KEY_ID",
  "OSS_ACCESS_KEY_SECRET",
  "OPENGROVE_RELEASE_R2_ACCESS_KEY_ID",
  "OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY",
  "OPENGROVE_RELEASE_UPLOAD_TOKEN",
];

export async function checkDesktopReleaseInfrastructure({
  env = process.env,
  executeFile = execFileAsync,
  fetchImpl = fetch,
  r2Client,
  wait = delay,
  warn = console.warn,
} = {}) {
  const values = Object.fromEntries(requiredNames.map((name) => [name, trimmed(env[name])]));
  const missing = requiredNames.filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(`Missing desktop-release environment configuration: ${missing.join(" ")}`);
  }

  for (const name of ["OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT", "OPENGROVE_DESKTOP_RELEASE_UPDATER_ROOT"]) {
    requireHttpsUrl(values[name], name);
  }
  requireWwReleaseUrl(values.OPENGROVE_CLIENT_RELEASES_URL);

  await executeFile(
    "ossutil",
    [
      "ls",
      `oss://${values.OPENGROVE_RELEASE_OSS_BUCKET}/`,
      "--limited-num",
      "1",
      "--region",
      values.OPENGROVE_RELEASE_OSS_REGION,
      "--endpoint",
      values.OPENGROVE_RELEASE_OSS_ENDPOINT,
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        OSS_ACCESS_KEY_ID: values.OSS_ACCESS_KEY_ID,
        OSS_ACCESS_KEY_SECRET: values.OSS_ACCESS_KEY_SECRET,
      },
    },
  );

  await verifyR2ReleaseAccess(
    {
      accountId: values.OPENGROVE_RELEASE_R2_ACCOUNT_ID,
      bucket: values.OPENGROVE_RELEASE_R2_BUCKET,
      accessKeyId: values.OPENGROVE_RELEASE_R2_ACCESS_KEY_ID,
      secretAccessKey: values.OPENGROVE_RELEASE_R2_SECRET_ACCESS_KEY,
    },
    {
      env,
      ...(r2Client ? { client: r2Client } : {}),
    },
  );

  await verifyWwReleaseOrigin({
    url: values.OPENGROVE_CLIENT_RELEASES_URL,
    token: values.OPENGROVE_RELEASE_UPLOAD_TOKEN,
    fetchImpl,
    wait,
    warn,
  });

  return { oss: "authenticated", r2: "authenticated", ww: "origin-reachable" };
}

async function verifyWwReleaseOrigin({ url, token, fetchImpl, wait, warn }) {
  // ww intentionally has no non-mutating authenticated method on the release
  // registration route. Validate the exact configured path above, then use HEAD
  // only to prove that its HTTPS origin is reachable. Registration proves the
  // upload token later without weakening the no-write readiness boundary.
  for (let attempt = 1; attempt <= WW_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "HEAD",
        headers: { authorization: `Bearer ${token}` },
        redirect: "follow",
        signal: releaseRequestSignal(),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(`ww release API readiness failed: HTTP ${response.status}`);
      }
      if (!retryableWwStatus(response.status)) return;
      if (attempt === WW_ATTEMPTS) {
        throw new Error(`ww release API readiness failed: HTTP ${response.status}`);
      }
      warn(`ww release API readiness returned HTTP ${response.status}; retrying attempt ${attempt + 1}/${WW_ATTEMPTS}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("ww release API readiness failed:")) throw error;
      if (attempt === WW_ATTEMPTS) {
        throw new Error(`ww release API readiness failed: ${errorMessage(error)}`, { cause: error });
      }
      warn(
        `ww release API readiness request failed: ${errorMessage(error)}; retrying attempt ${attempt + 1}/${WW_ATTEMPTS}`,
      );
    }
    await wait(WW_RETRY_DELAY_MS * attempt);
  }
}

function retryableWwStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function requireHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url;
}

function requireWwReleaseUrl(value) {
  const url = requireHttpsUrl(value, "OPENGROVE_CLIENT_RELEASES_URL");
  if (url.pathname !== WW_RELEASE_PATH || url.search || url.hash) {
    throw new Error(
      `OPENGROVE_CLIENT_RELEASES_URL must use the exact ${WW_RELEASE_PATH} path without query or fragment`,
    );
  }
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main() {
  const result = await checkDesktopReleaseInfrastructure();
  console.log(`desktop release infrastructure ready: OSS ${result.oss}; R2 ${result.r2}; ww ${result.ww}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
