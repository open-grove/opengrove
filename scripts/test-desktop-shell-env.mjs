import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDir = await mkdtemp(join(tmpdir(), "opengrove-desktop-shell-env-"));
const bundlePath = join(tempDir, "shell-env.mjs");

try {
  await build({
    entryPoints: [join(projectRoot, "desktop/shell-env.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundlePath,
  });
  const { mergeDesktopEnvironment } = await import(pathToFileURL(bundlePath).href);

  const baseEnv = {
    PATH: "/launcher/bin",
    OPENGROVE_DESKTOP_DEV_PROFILE: "test",
    OPENGROVE_DESKTOP_DEV_USER_DATA_DIR: "/tmp/OpenGroveDev-test",
    OPENGROVE_WW_BASE_URL: "https://opengrove-test.example",
    OPENGROVE_WW_API_KEY: "",
    OPENGROVE_APP_STORE_REGISTRY_URL: "https://opengrove-test.example",
    OPENGROVE_APP_STORE_REGISTRY_TOKEN: "",
    APP_STORE_REGISTRY_URL: "",
    APP_STORE_REGISTRY_TOKEN: "",
  };
  const merged = mergeDesktopEnvironment(baseEnv, {
    PATH: "/login-shell/bin",
    OPENGROVE_WW_BASE_URL: "https://opengrove.example",
    OPENGROVE_WW_API_KEY: "production-key",
    OPENGROVE_APP_STORE_REGISTRY_URL: "https://opengrove.example",
    OPENGROVE_APP_STORE_REGISTRY_TOKEN: "production-token",
    APP_STORE_REGISTRY_URL: "https://legacy-production.example",
    APP_STORE_REGISTRY_TOKEN: "legacy-production-token",
    OPENGROVE_WW_UNDECLARED_SECRET: "must-not-enter-test-profile",
  });
  assert.equal(merged.PATH, "/login-shell/bin", "the login shell may still enrich normal desktop environment");
  assert.equal(merged.OPENGROVE_WW_BASE_URL, baseEnv.OPENGROVE_WW_BASE_URL);
  assert.equal(merged.OPENGROVE_WW_API_KEY, "");
  assert.equal(merged.OPENGROVE_APP_STORE_REGISTRY_URL, baseEnv.OPENGROVE_APP_STORE_REGISTRY_URL);
  assert.equal(merged.OPENGROVE_APP_STORE_REGISTRY_TOKEN, "");
  assert.equal(merged.APP_STORE_REGISTRY_URL, "");
  assert.equal(merged.APP_STORE_REGISTRY_TOKEN, "");
  assert.equal(
    Object.prototype.hasOwnProperty.call(merged, "OPENGROVE_WW_UNDECLARED_SECRET"),
    false,
    "a login shell must not inject undeclared WW credentials into an isolated profile",
  );

  const normal = mergeDesktopEnvironment(
    { PATH: "/launcher/bin" },
    { PATH: "/login-shell/bin", OPENGROVE_WW_BASE_URL: "https://opengrove.example" },
  );
  assert.equal(normal.PATH, "/login-shell/bin");
  assert.equal(normal.OPENGROVE_WW_BASE_URL, "https://opengrove.example");

  console.log("desktop shell environment: ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
