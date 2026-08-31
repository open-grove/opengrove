import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const tempDir = mkdtempSync(join(tmpdir(), "opengrove-desktop-auth-cookies-"));
const outFile = join(tempDir, "auth-cookies.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop", "auth-cookies.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: outFile,
  });

  const { DesktopAuthCookieJar, responseSetCookieHeaders } = await import(pathToFileURL(outFile).href);
  const storePath = join(tempDir, "auth-cookies.json");
  const jar = new DesktopAuthCookieJar(storePath);

  const combinedHeaders = new Headers({
    "set-cookie": [
      "opengrove_auth_access=combined-access; Path=/; Max-Age=60; HttpOnly",
      "opengrove_auth_refresh=combined-refresh; Path=/; Max-Age=3600; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly",
      "opengrove_auth_session=combined-session; Path=/; Max-Age=3600",
    ].join(", "),
  });
  assert.deepEqual(responseSetCookieHeaders(combinedHeaders), [
    "opengrove_auth_access=combined-access; Path=/; Max-Age=60; HttpOnly",
    "opengrove_auth_refresh=combined-refresh; Path=/; Max-Age=3600; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly",
    "opengrove_auth_session=combined-session; Path=/; Max-Age=3600",
  ]);
  jar.applySetCookieHeaders(responseSetCookieHeaders(combinedHeaders));
  assert.equal(jar.hasSavedSession(), true);
  jar.clear();

  assert.equal(jar.mergeRequestCookieHeader(undefined), undefined);
  assert.equal(jar.hasSavedSession(), false);
  jar.applySetCookieHeaders(undefined);

  jar.applySetCookieHeaders([
    "opengrove_auth_access=access-one; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
    "opengrove_auth_refresh=refresh-one; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax",
    "opengrove_auth_session=session-one; Path=/; Max-Age=3600; SameSite=Lax",
    "unrelated=value; Path=/; Max-Age=60",
    "not-a-cookie",
  ]);
  assertCookies(jar.mergeRequestCookieHeader("theme=dark; opengrove_auth_access=stale"), {
    theme: "dark",
    opengrove_auth_access: "access-one",
    opengrove_auth_refresh: "refresh-one",
    opengrove_auth_session: "session-one",
  });
  assert.equal(jar.hasSavedSession(), true);

  const restored = new DesktopAuthCookieJar(storePath);
  assertCookies(restored.mergeRequestCookieHeader(undefined), {
    opengrove_auth_access: "access-one",
    opengrove_auth_refresh: "refresh-one",
    opengrove_auth_session: "session-one",
  });
  assert.equal(restored.hasSavedSession(), true);

  jar.applySetCookieHeaders(["opengrove_auth_access=access-two; Path=/; Max-Age=60; HttpOnly"]);
  assertCookies(jar.mergeRequestCookieHeader(undefined), {
    opengrove_auth_access: "access-two",
    opengrove_auth_refresh: "refresh-one",
    opengrove_auth_session: "session-one",
  });

  jar.applySetCookieHeaders([
    "opengrove_auth_access=; Path=/; Max-Age=0; HttpOnly",
    "opengrove_auth_session=session-one; Path=/; max-age=0",
  ]);
  assertCookies(jar.mergeRequestCookieHeader("theme=dark"), {
    theme: "dark",
    opengrove_auth_refresh: "refresh-one",
  });
  assert.equal(jar.hasSavedSession(), true, "the refresh token keeps the saved session available");

  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      cookies: {
        opengrove_auth_access: { value: "expired", expiresAt: Date.now() - 1000 },
        opengrove_auth_refresh: { value: "refresh-persisted", expiresAt: Date.now() + 3600_000 },
      },
    }),
  );
  const pruned = new DesktopAuthCookieJar(storePath);
  assertCookies(pruned.mergeRequestCookieHeader(undefined), {
    opengrove_auth_refresh: "refresh-persisted",
  });
  assert.equal(pruned.hasSavedSession(), true);

  pruned.clear();
  assert.equal(pruned.mergeRequestCookieHeader(undefined), undefined);
  assert.equal(pruned.hasSavedSession(), false);
  assert.equal(existsSync(storePath), false);

  console.log("desktop-auth-cookies-harness ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function assertCookies(header, expected) {
  assert.deepEqual(Object.fromEntries(parseCookieHeader(header)), expected);
}

function parseCookieHeader(header) {
  const cookies = new Map();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}
