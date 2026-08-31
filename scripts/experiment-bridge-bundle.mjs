import { fork } from "node:child_process";
import { builtinModules } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const entryPoint = join(projectRoot, "dist", "server", "desktop-bridge-entry.js");
const experimentRoot = join(projectRoot, ".opengrove", "bridge-bundle-experiment");
const outputEntry = join(experimentRoot, "dist", "desktop-bridge-entry.mjs");
const metafilePath = join(experimentRoot, "esbuild-metafile.json");
const reportPath = join(experimentRoot, "report.json");
const optionalExternalPackages = ["bufferutil", "utf-8-validate"];

if (!existsSync(entryPoint))
  throw new Error(
    "Bridge bundle experiment requires dist/server/desktop-bridge-entry.js; run npm run build:server first",
  );
rmSync(experimentRoot, { recursive: true, force: true });
mkdirSync(dirname(outputEntry), { recursive: true });
stageRuntimeAssets();

const result = await build({
  absWorkingDir: projectRoot,
  entryPoints: [relative(projectRoot, entryPoint)],
  outfile: relative(projectRoot, outputEntry),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  metafile: true,
  external: optionalExternalPackages,
  plugins: [secondaryEntryGuardPlugin()],
  // Several bundled CommonJS transitive dependencies still call require()
  // for Node builtins. ESM has no ambient require, so provide the standard
  // createRequire bridge at the bundle boundary.
  banner: {
    js: 'import { createRequire as __bridgeBundleCreateRequire } from "node:module"; const require = __bridgeBundleCreateRequire(import.meta.url);',
  },
});
writeFileSync(metafilePath, `${JSON.stringify(result.metafile, null, 2)}\n`);

const externalImports = collectExternalImports(result.metafile);
const packageExternals = externalImports.filter((name) => !isBuiltin(name));
const unexpectedExternals = packageExternals.filter((name) => !optionalExternalPackages.includes(name));
if (unexpectedExternals.length > 0) {
  throw new Error(`Bridge bundle introduced unapproved package externals: ${unexpectedExternals.join(", ")}`);
}

const smoke = await smokeBundle(outputEntry);
const inputEntries = Object.entries(result.metafile.inputs);
const firstPartyInputs = inputEntries.filter(([path]) => path.startsWith("dist/"));
const packageInputs = inputEntries.filter(([path]) => path.startsWith("node_modules/"));
const embeddedPackages = [...new Set(packageInputs.map(([path]) => packageName(path)))].sort();
const report = {
  schemaVersion: 1,
  experiment: "embedded_bridge_esbuild_bundle",
  productionBuildChanged: false,
  entryPoint: relative(projectRoot, entryPoint),
  outputEntry: relative(projectRoot, outputEntry),
  metafile: relative(projectRoot, metafilePath),
  build: {
    platform: "node",
    format: "esm",
    target: "node24",
    minified: true,
    bundleBytes: statSync(outputEntry).size,
    inputFiles: inputEntries.length,
    inputBytes: sumInputBytes(inputEntries),
    firstPartyInputFiles: firstPartyInputs.length,
    firstPartyInputBytes: sumInputBytes(firstPartyInputs),
    packageInputFiles: packageInputs.length,
    packageInputBytes: sumInputBytes(packageInputs),
    embeddedPackageCount: embeddedPackages.length,
    embeddedPackages,
    packageExternals,
    builtinExternals: externalImports.filter(isBuiltin),
  },
  experimentAdapters: [
    {
      id: "esm-create-require-banner",
      productionRequirement: "retain an ESM createRequire boundary for bundled CommonJS transitive dependencies",
    },
    {
      id: "neutralize-secondary-entry-guards",
      files: ["dist/server/create-server.js", "dist/server/local-bridge.js"],
      productionRequirement:
        "move executable guards into dedicated entry wrappers so library modules cannot auto-start after bundling",
    },
  ],
  runtimeAssets: runtimeAssetManifest(),
  riskFindings: scanBundleRisks(firstPartyInputs.map(([path]) => path)),
  smoke,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (process.env.OPENGROVE_BRIDGE_BUNDLE_SUMMARY_OUT) {
  const summaryOut = resolve(process.env.OPENGROVE_BRIDGE_BUNDLE_SUMMARY_OUT);
  mkdirSync(dirname(summaryOut), { recursive: true });
  writeFileSync(
    summaryOut,
    `${JSON.stringify({ ...report, metafile: ".opengrove/bridge-bundle-experiment/esbuild-metafile.json" }, null, 2)}\n`,
  );
}

console.log(
  [
    "bridge bundle experiment passed",
    `- bundle: ${report.build.bundleBytes} bytes from ${report.build.inputFiles} inputs`,
    `- embedded packages: ${report.build.embeddedPackageCount}`,
    `- package externals: ${report.build.packageExternals.join(", ") || "none"}`,
    `- smoke: ${report.smoke.endpoints.map((item) => `${item.path}=${item.status}`).join(", ")}`,
    `- report: ${reportPath}`,
    `- metafile: ${metafilePath}`,
  ].join("\n"),
);

function stageRuntimeAssets() {
  cpSync(join(projectRoot, "package.json"), join(experimentRoot, "package.json"));
  for (const path of ["src/skills/bundled", "src/packs/bundled"]) {
    const source = join(projectRoot, path);
    if (!existsSync(source)) continue;
    const destination = join(experimentRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

function secondaryEntryGuardPlugin() {
  const secondaryEntries = new Set([
    join(projectRoot, "dist", "server", "create-server.js"),
    join(projectRoot, "dist", "server", "local-bridge.js"),
  ]);
  return {
    name: "experiment-neutralize-secondary-entry-guards",
    setup(buildContext) {
      buildContext.onLoad({ filter: /dist[\\/]server[\\/](?:create-server|local-bridge)\.js$/ }, async (args) => {
        if (!secondaryEntries.has(args.path)) return undefined;
        const original = readFileSync(args.path, "utf8");
        const contents = original.replace(
          /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{/g,
          "if (false) {",
        );
        if (contents === original) throw new Error(`could not neutralize secondary entry guard in ${args.path}`);
        return { contents, loader: "js" };
      });
    },
  };
}

function runtimeAssetManifest() {
  const packageJson = JSON.parse(
    readFileSync(join(projectRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8"),
  );
  return [
    asset("package.json", "required", "packageRoot consumers and version/auth routes"),
    asset("web-dist", "required-for-full-desktop", "Bridge static UI routes; not needed by the API smoke"),
    asset("src/skills/bundled", "required", "first-party bundled skill catalog"),
    asset(
      "src/packs/bundled",
      "optional-if-present",
      "first-party bundled pack catalog; the current tree has no built-in packs",
    ),
    {
      path: "node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>",
      status: "required-unbundled-native-asset",
      reason:
        "SDK resolves the platform engine by a dynamic package name and electron-builder must keep its executable unpacked",
      sdkVersion: packageJson.version,
      declaredVariants: Object.keys(packageJson.optionalDependencies ?? {}).sort(),
    },
  ];
}

function asset(path, status, reason) {
  const absolute = join(projectRoot, path);
  const stats = treeStats(absolute);
  return { path, status, reason, existsInCheckout: existsSync(absolute), ...stats };
}

function treeStats(path) {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  const stat = statSync(path);
  if (stat.isFile()) return { files: 1, bytes: stat.size };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const nested = treeStats(join(path, entry.name));
    files += nested.files;
    bytes += nested.bytes;
  }
  return { files, bytes };
}

async function smokeBundle(bundlePath) {
  const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-bridge-bundle-smoke-"));
  const token = "bridge-bundle-experiment-token";
  let child;
  try {
    child = fork(bundlePath, [], {
      cwd: experimentRoot,
      env: {
        ...process.env,
        OPENGROVE_DATA_DIR: join(tempRoot, "data"),
        OPENGROVE_LOG_DIR: join(tempRoot, "logs"),
        OPENGROVE_DIAGNOSTICS_DIR: join(tempRoot, "diagnostics"),
        OPENGROVE_STATE_PATH: join(tempRoot, "data", "local-state.sqlite"),
        OPENGROVE_BRIDGE_SETTINGS_PATH: join(tempRoot, "data", "bridge-settings.json"),
        OPENGROVE_BRIDGE_TOKEN: token,
        OPENGROVE_BRIDGE_HOST: "127.0.0.1",
        OPENGROVE_BRIDGE_PORT: "0",
        OPENGROVE_WEB_AUTH_MODE: "bridge-token",
        OPENGROVE_WW_BASE_URL: "",
        OPENGROVE_CLAUDE_CLI_PATH: process.execPath,
      },
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    const ready = await waitForReady(child, () => output);
    const endpoints = [];
    for (const path of ["/health", "/settings", "/memory", "/diagnostics/summary"]) {
      const response = await fetch(`${ready.apiBase}${path}`, {
        headers: path === "/health" ? {} : { "x-opengrove-token": token },
        signal: AbortSignal.timeout(10_000),
      });
      endpoints.push({ path, status: response.status });
      if (response.status !== 200) throw new Error(`bundle smoke ${path} returned HTTP ${response.status}`);
      await response.arrayBuffer();
    }
    const exitPending = waitForExit(child, 10_000);
    child.send({ type: "opengrove.desktop.bridge.shutdown" });
    const exit = await exitPending;
    if (exit.code !== 0) throw new Error(`bundle smoke Bridge exited with ${exit.code ?? exit.signal}: ${output}`);
    return {
      passed: true,
      readyMessage: ready.type,
      endpoints,
      packageRootLayout:
        "bundle at dist/desktop-bridge-entry.mjs so packageRoot() resolves the staged application root",
    };
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function waitForReady(child, output) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`bundle smoke readiness timed out\n${output()}`)), 45_000);
    child.on("message", (message) => {
      if (message?.type !== "opengrove.desktop.bridge.ready") return;
      clearTimeout(timer);
      resolveReady(message);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`bundle smoke Bridge exited before readiness: ${code ?? signal}\n${output()}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("bundle smoke shutdown timed out")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function scanBundleRisks(paths) {
  const patterns = [
    ["package_root", /packageRoot\(\)|package-root\.js/],
    ["module_relative_url", /import\.meta\.url/],
    ["create_require", /createRequire\(/],
    ["dynamic_import", /\bimport\s*\(/],
    ["child_process_or_worker", /\b(?:fork|Worker)\s*\(/],
    ["first_party_runtime_asset", /src[\\/]\s*(?:skills|packs)[\\/]\s*bundled|src\/(?:skills|packs)\/bundled/],
  ];
  const findings = [];
  for (const path of paths) {
    const source = readFileSync(join(projectRoot, path), "utf8");
    const kinds = patterns.filter(([, pattern]) => pattern.test(source)).map(([kind]) => kind);
    if (kinds.length > 0) findings.push({ path, kinds });
  }
  return findings;
}

function collectExternalImports(metafile) {
  return [
    ...new Set(
      Object.values(metafile.outputs).flatMap((output) =>
        (output.imports ?? []).filter((item) => item.external).map((item) => item.path),
      ),
    ),
  ].sort();
}

function isBuiltin(name) {
  return name.startsWith("node:") || builtinModules.includes(name);
}

function packageName(path) {
  const parts = path.split("/");
  return parts[1]?.startsWith("@") ? parts.slice(1, 3).join("/") : parts[1];
}

function sumInputBytes(entries) {
  return entries.reduce((sum, [, input]) => sum + input.bytes, 0);
}
