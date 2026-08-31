import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeAppPackageManifest, packApp, publishApp, validateAppPackageSource } from "../app-builder/cli.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-pack-"));
const highEntropyToken = ["A1b2C3d4E5f6G7h8", "J9k0L_m-N.o/P=q+R", "sT2uV3wX4yZ5"].join("");
const googleApiKeyFixture = (suffix: string): string => ["AI", "za", suffix].join("");

try {
  const appRoot = join(tempRoot, "demo-app");
  mkdirSync(join(appRoot, "bin"), { recursive: true });
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  mkdirSync(join(appRoot, "config"), { recursive: true });
  mkdirSync(join(appRoot, "src"), { recursive: true });
  mkdirSync(join(appRoot, "web", "node_modules", "@modelcontextprotocol", "sdk", "dist", "cjs"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "demo-app",
        title: "Demo App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: {
          packageKey: "demo.demo-app",
          visibility: "restricted",
          packExclude: ["config/accounts.json"],
          requirements: {
            env: ["DEMO_TOKEN"],
            system: ["ffmpeg"],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(appRoot, "bin", "demo"), "#!/usr/bin/env bash\necho demo\n");
  chmodSync(join(appRoot, "bin", "demo"), 0o755);
  writeFileSync(join(appRoot, "requirements.txt"), "Pillow>=10.0.0\nfastapi>=0.110.0\n");
  writeFileSync(join(appRoot, "workspace", "user-output.txt"), "must stay local\n");
  writeFileSync(join(appRoot, "config", "accounts.json"), '{"secret":true}\n');
  writeFileSync(join(appRoot, ".env"), "DEMO_TOKEN=secret\n");
  writeFileSync(
    join(appRoot, "src", "generated-types.js"),
    "exports.RELATED_TASK_META_KEY = exports.SUPPORTED_PROTOCOL_VERSIONS;\n",
  );
  writeFileSync(
    join(appRoot, "web", "node_modules", "@modelcontextprotocol", "sdk", "dist", "cjs", "types.js"),
    `SERVICE_TOKEN = "${highEntropyToken}";\n`,
  );
  writeFileSync(join(appRoot, "web", ".env.production"), `SERVICE_TOKEN=${highEntropyToken}\n`);

  const inspectedManifest = computeAppPackageManifest(appRoot);
  assert.deepEqual(inspectedManifest.files, {
    "bin/demo": "sha256:ae58e71d160ed2a21727e7e931f9155fc1703d045423f648a3a91f767b308bb0",
    "opengrove.app.json": "sha256:d6244f7bfbf988966b0962dacba4b20d8ce8f10c789d641124c9b8f8d4c97707",
    "requirements.txt": "sha256:6cb46d33df81f82dc14f80a43ebb23b5288cf1ab66fdda3637835b5c5b0d12d3",
    "src/generated-types.js": "sha256:da4848d6ff359709dcb56b61cf0482a56dc8c0656620e44f5a931310eacc4a91",
  });
  assert.deepEqual(
    {
      schemaVersion: inspectedManifest.schemaVersion,
      packageKey: inspectedManifest.packageKey,
      packageId: inspectedManifest.packageId,
      appId: inspectedManifest.appId,
      version: inspectedManifest.version,
      workspacePath: inspectedManifest.workspacePath,
    },
    {
      schemaVersion: 1,
      packageKey: "demo.demo-app",
      packageId: "demo-app",
      appId: "demo-app",
      version: "0.1.0",
      workspacePath: "workspace",
    },
  );

  const packed = packApp(appRoot, { outputPath: join(tempRoot, "demo-app.tgz") });
  assert.deepEqual(
    inspectedManifest,
    packed.packageManifest,
    "content-only package inspection must produce the exact manifest used by real packing",
  );
  assert.equal(packed.packageManifest.packageKey, "demo.demo-app");
  assert.equal(packed.packageManifest.packageId, "demo-app");
  assert.equal(packed.packageManifest.version, "0.1.0");
  assert.ok(packed.packageManifest.files["opengrove.app.json"]);
  assert.ok(packed.packageManifest.files["bin/demo"]);
  assert.ok(packed.packageManifest.files["requirements.txt"]);
  assert.ok(packed.packageManifest.files["src/generated-types.js"]);
  assert.equal(packed.packageManifest.files["workspace/user-output.txt"], undefined);
  assert.equal(packed.packageManifest.files["config/accounts.json"], undefined);
  assert.equal(packed.packageManifest.files[".env"], undefined);
  assert.equal(packed.packageManifest.files["web/node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js"], undefined);
  assert.equal(packed.packageManifest.files["web/.env.production"], undefined);

  const listing = execFileSync("tar", ["-tzf", packed.archivePath], { encoding: "utf8" });
  assert.match(listing, /opengrove\.app\.json/);
  assert.match(listing, /\.opengrove-package-manifest\.json/);
  assert.doesNotMatch(listing, /workspace\/user-output/);
  assert.doesNotMatch(listing, /config\/accounts\.json/);
  assert.doesNotMatch(listing, /\.env/);

  const setupRoot = join(tempRoot, "setup-app");
  mkdirSync(join(setupRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(setupRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "setup-app",
        title: "Setup App",
        version: "0.1.0",
        ui: { surface: "setup", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  assert.throws(
    () => packApp(setupRoot, { outputPath: join(tempRoot, "setup-app.tgz") }),
    /app_setup_not_publishable/,
    "an unfinished setup App must not be packable",
  );

  const excludedUiRoot = join(tempRoot, "excluded-ui-entry-app");
  mkdirSync(join(excludedUiRoot, "workspace"), { recursive: true });
  mkdirSync(join(excludedUiRoot, "ui"), { recursive: true });
  writeFileSync(join(excludedUiRoot, "ui", "view.html"), "<h1>view</h1>\n");
  writeFileSync(
    join(excludedUiRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "excluded-ui-entry-app",
        title: "Excluded UI Entry App",
        version: "0.1.0",
        ui: {
          surface: "file-workbench",
          workspace: "workspace",
          tabs: [
            {
              id: "view",
              component: "view",
              view: { protocol: "mcp-app", entry: "ui/view.html", tools: [] },
            },
          ],
        },
        workspace: { path: "workspace" },
        store: { packExclude: ["ui/view.html"] },
      },
      null,
      2,
    ),
  );
  assertPackageSafetyParity(
    excludedUiRoot,
    "excluded-ui-entry-app.tgz",
    /pack_ui_entry_excluded:ui\.tabs\[0\]\.view\.entry:ui\/view\.html/u,
  );

  // 打包→解包后 bin/ 下 CLI 必须保留执行位，否则安装到同事机器上会 permission denied。
  const extractRoot = join(tempRoot, "extracted-demo-app");
  mkdirSync(extractRoot, { recursive: true });
  execFileSync("tar", ["-xzf", packed.archivePath, "-C", extractRoot]);
  assert.ok(
    statSync(join(extractRoot, "bin", "demo")).mode & 0o111,
    "packed bin/demo should keep its executable bit through pack and extract",
  );

  const opaqueContentRoot = join(tempRoot, "opaque-content-app");
  mkdirSync(opaqueContentRoot, { recursive: true });
  writeFileSync(
    join(opaqueContentRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "secret-app",
        title: "Secret App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  // Opaque App content must not be interpreted by the structural package validator.
  writeFileSync(
    join(opaqueContentRoot, "leak.txt"),
    `OPENAI_API_KEY=${["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("")}\n`,
  );
  assert.doesNotThrow(() => {
    validateAppPackageSource(opaqueContentRoot);
    packApp(opaqueContentRoot, { outputPath: join(tempRoot, "opaque-content-app.tgz") });
  }, "App packaging must not reject files based on heuristic content inspection");

  const highEntropyRoot = join(tempRoot, "high-entropy-secret-app");
  mkdirSync(highEntropyRoot, { recursive: true });
  writeFileSync(
    join(highEntropyRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "high-entropy-secret-app",
        title: "High Entropy Secret App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(highEntropyRoot, "secrets.js"), `SERVICE_TOKEN = "${highEntropyToken}";\n`);
  assert.doesNotThrow(() => {
    validateAppPackageSource(highEntropyRoot);
    packApp(highEntropyRoot, { outputPath: join(tempRoot, "high-entropy-secret-app.tgz") });
  }, "high-entropy assignments are ordinary App content, not a packaging concern");
  const pythonExpressionRoot = join(tempRoot, "python-expression-app");
  mkdirSync(pythonExpressionRoot, { recursive: true });
  writeFileSync(
    join(pythonExpressionRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "python-expression-app",
        title: "Python Expression App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(pythonExpressionRoot, "inspect.py"), "_KEYWORD_ONLY = _ParameterKind.POSITIONAL_OR_KEYWORD\n");
  assert.doesNotThrow(
    () => packApp(pythonExpressionRoot, { outputPath: join(tempRoot, "python-expression-app.tgz") }),
    "Python source expressions must not be treated as unquoted config secrets",
  );

  const unquotedSecretRoot = join(tempRoot, "unquoted-secret-app");
  mkdirSync(unquotedSecretRoot, { recursive: true });
  writeFileSync(
    join(unquotedSecretRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "unquoted-secret-app",
        title: "Unquoted Secret App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(unquotedSecretRoot, "secrets.yaml"), `SERVICE_TOKEN: ${highEntropyToken}\n`);
  assert.doesNotThrow(
    () => packApp(unquotedSecretRoot, { outputPath: join(tempRoot, "unquoted-secret-app.tgz") }),
    "configuration values must not be rejected by heuristic content inspection",
  );

  const privateNetworkRoot = join(tempRoot, "private-network-app");
  mkdirSync(privateNetworkRoot, { recursive: true });
  writeFileSync(
    join(privateNetworkRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "private-network-app",
        title: "Private Network App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(privateNetworkRoot, "notes.txt"), "Internal service: http://192.168.1.10:8080\n");
  assert.doesNotThrow(
    () => packApp(privateNetworkRoot, { outputPath: join(tempRoot, "private-network-app.tgz") }),
    "private network examples are ordinary App content",
  );
  writeFileSync(join(privateNetworkRoot, "notes.txt"), "API_HOST=10.0.0.12\n");
  assert.doesNotThrow(
    () => packApp(privateNetworkRoot, { outputPath: join(tempRoot, "private-network-config-app.tgz") }),
    "assigned private network endpoints are not a packaging concern",
  );
  writeFileSync(join(privateNetworkRoot, "notes.txt"), JSON.stringify({ API_HOST: "10.0.0.12" }));
  assert.doesNotThrow(
    () => packApp(privateNetworkRoot, { outputPath: join(tempRoot, "private-network-json-app.tgz") }),
    "single-line JSON must not be inspected heuristically",
  );
  writeFileSync(join(privateNetworkRoot, "notes.txt"), JSON.stringify({ API_HOST: "10.0.0.12" }, null, 2));
  assert.doesNotThrow(
    () => packApp(privateNetworkRoot, { outputPath: join(tempRoot, "private-network-multiline-json-app.tgz") }),
    "multiline JSON must not be inspected heuristically",
  );
  writeFileSync(join(privateNetworkRoot, "notes.txt"), "'api_host': '192.168.20.5'\n");
  assert.doesNotThrow(
    () => packApp(privateNetworkRoot, { outputPath: join(tempRoot, "private-network-yaml-app.tgz") }),
    "quoted YAML must not be inspected heuristically",
  );
  writeFileSync(join(privateNetworkRoot, "notes.txt"), "API_HOST=10.999.999.999\n");
  assert.doesNotThrow(
    () => packApp(privateNetworkRoot, { outputPath: join(tempRoot, "invalid-private-network-app.tgz") }),
    "invalid IPv4 text must not be treated as a private endpoint",
  );

  const vendoredRuntimeRoot = join(tempRoot, "vendored-runtime-app");
  mkdirSync(join(vendoredRuntimeRoot, "runtime", "vendor"), { recursive: true });
  writeFileSync(
    join(vendoredRuntimeRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "vendored-runtime-app",
        title: "Vendored Runtime App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "stdlib.bin"),
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(`upstream build: ${["", "Users", "upstream", "build"].join("/")}; RFC example: 192.168.0.1`),
      Buffer.from([0]),
    ]),
  );
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "vendored-runtime-app.tgz") }),
    "vendored runtime binaries may contain upstream build paths and protocol examples",
  );
  mkdirSync(join(vendoredRuntimeRoot, "runtime", "linux-x64"), { recursive: true });
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "linux-x64", "python.bin"),
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(`upstream build: ${["", "home", "upstream", "build"].join("/")}; docs: C:\\Users\\builder\\src`),
      Buffer.from([0]),
    ]),
  );
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "platform-runtime-app.tgz") }),
    "platform runtime binaries may contain upstream build paths",
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "linux-x64", "secret.bin"),
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(`embedded key: ${googleApiKeyFixture("12345678901234567890123456789012345")}`),
      Buffer.from([0]),
    ]),
  );
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "platform-runtime-secret-app.tgz") }),
    "platform runtime binaries must not be inspected heuristically",
  );
  rmSync(join(vendoredRuntimeRoot, "runtime", "linux-x64", "secret.bin"));
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "ipaddress.py"),
    ["IPv4Network('10.0.0.0/8')", "IPv4Network('172.16.0.0/12')", "IPv4Network('192.168.0.0/16')", ""].join("\n"),
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "nturl2path.py"),
    ["# Examples:", "#   ///C:/foo/bar/spam.foo", "#   C:\\foo\\bar\\spam.foo", ""].join("\n"),
  );
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "vendored-runtime-source-app.tgz") }),
    "vendored runtime source may define private address ranges and document generic paths",
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "receipt.json"),
    JSON.stringify(
      {
        lock: {
          python: {
            embedded_path_replacements: {
              [["", "Users", "upstream-builder", ""].join("/")]: "/__build__/",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "vendored-runtime-receipt-app.tgz") }),
    "vendored runtime receipts may document scrubbed upstream build paths",
  );
  assert.doesNotThrow(
    () => validateAppPackageSource(vendoredRuntimeRoot),
    "streamed preparation must accept the same valid runtime receipt",
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "receipt.json"),
    JSON.stringify({
      padding: "x".repeat(1024 * 1024 + 1024),
      lock: {
        python: {
          embedded_path_replacements: {
            [["", "Users", "upstream-builder", ""].join("/")]: "/__build__/",
          },
        },
      },
    }),
  );
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "large-vendored-runtime-receipt-app.tgz") }),
    "runtime receipts must be parsed as a whole file instead of unrelated scan chunks",
  );
  assert.doesNotThrow(
    () => validateAppPackageSource(vendoredRuntimeRoot),
    "streamed preparation must parse the same bounded runtime receipt as a whole file",
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "receipt.json"),
    JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024 + 1) }),
  );
  assertPackageSafetyParity(
    vendoredRuntimeRoot,
    "too-large-vendored-runtime-receipt-app.tgz",
    /pack_runtime_receipt_invalid/,
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "receipt.json"),
    JSON.stringify({
      lock: {
        python: {
          embedded_path_replacements: {
            [["", "Users", "upstream-builder", ""].join("/")]: "/tmp/not-a-scrubbed-placeholder/",
          },
        },
      },
    }),
  );
  assertPackageSafetyParity(
    vendoredRuntimeRoot,
    "invalid-vendored-runtime-receipt-app.tgz",
    /pack_runtime_receipt_invalid/,
  );
  writeFileSync(join(vendoredRuntimeRoot, "runtime", "vendor", "receipt.json"), "{");
  assert.throws(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "malformed-vendored-runtime-receipt-app.tgz") }),
    /pack_runtime_receipt_invalid/,
    "malformed runtime receipts must fail closed",
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "receipt.json"),
    JSON.stringify({
      lock: {
        python: {
          embedded_path_replacements: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [
              ["", "Users", `upstream-builder-${index}`, ""].join("/"),
              `/__build_${index}__/`,
            ]),
          ),
        },
      },
    }),
  );
  assert.throws(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "oversized-vendored-runtime-receipt-app.tgz") }),
    /pack_runtime_receipt_invalid/,
    "runtime receipt exceptions must be narrowly bounded",
  );
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "receipt.json"),
    JSON.stringify({
      lock: {
        python: {
          embedded_path_replacements: {
            [["", "Users", "upstream-builder", ""].join("/")]: "/__build__/",
          },
        },
      },
    }),
  );
  const vendoredRuntimeConfigPath = join(vendoredRuntimeRoot, "runtime", "vendor", "runtime-config.txt");
  writeFileSync(vendoredRuntimeConfigPath, "Internal service: http://192.168.1.10:8080\n");
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "vendored-runtime-config-app.tgz") }),
    "vendored runtime configuration must not be inspected heuristically",
  );
  rmSync(vendoredRuntimeConfigPath);
  writeFileSync(
    join(vendoredRuntimeRoot, "runtime", "vendor", "leaked-key.txt"),
    `${googleApiKeyFixture("0123456789abcdefghijklmnopqrstuv")}\n`,
  );
  assert.doesNotThrow(
    () => packApp(vendoredRuntimeRoot, { outputPath: join(tempRoot, "vendored-runtime-secret-app.tgz") }),
    "vendored runtime content is not a packaging policy decision",
  );

  const binaryScannerRoot = join(tempRoot, "binary-scanner-app");
  mkdirSync(binaryScannerRoot, { recursive: true });
  writeFileSync(
    join(binaryScannerRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "binary-scanner-app",
        title: "Binary Scanner App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(binaryScannerRoot, "random-drive-prefix.bin"), Buffer.from([0, 1, 2, 0x49, 0x3a, 0x2f, 3, 4, 5]));
  assert.doesNotThrow(
    () => packApp(binaryScannerRoot, { outputPath: join(tempRoot, "binary-scanner-app.tgz") }),
    "three random printable bytes in a native binary must not look like a local Windows path",
  );
  writeFileSync(
    join(binaryScannerRoot, "format-string.bin"),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("server=http%s://%s%s%s"), Buffer.from([3, 4])]),
  );
  assert.doesNotThrow(
    () => packApp(binaryScannerRoot, { outputPath: join(tempRoot, "binary-format-string-app.tgz") }),
    "printf URL format strings in native libraries must not look like a local Windows path",
  );

  const windowsBoundaryRoot = join(tempRoot, "windows-boundary-app");
  mkdirSync(windowsBoundaryRoot, { recursive: true });
  writeFileSync(
    join(windowsBoundaryRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "windows-boundary-app",
        title: "Windows Boundary App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(windowsBoundaryRoot, "paths.txt"), `fallback;C:${["", "Users", "example", "project"].join("\\")}`);
  assert.doesNotThrow(
    () => packApp(windowsBoundaryRoot, { outputPath: join(tempRoot, "windows-boundary-app.tgz") }),
    "Windows path examples must not be rejected by content inspection",
  );
  writeFileSync(
    join(binaryScannerRoot, "single-separator.bin"),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("R:\\Sg|p5rL"), Buffer.from([3, 4])]),
  );
  assert.doesNotThrow(
    () => packApp(binaryScannerRoot, { outputPath: join(tempRoot, "binary-single-separator-app.tgz") }),
    "one binary drive-like run without a second separator is not a local path",
  );
  writeFileSync(
    join(binaryScannerRoot, "actual-local-path.bin"),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("C:\\Users\\example\\private-project"), Buffer.from([3, 4])]),
  );
  assert.doesNotThrow(
    () => packApp(binaryScannerRoot, { outputPath: join(tempRoot, "binary-local-path-app.tgz") }),
    "binary contents must not be inspected heuristically",
  );

  const boundarySecretRoot = join(tempRoot, "boundary-secret-app");
  mkdirSync(boundarySecretRoot, { recursive: true });
  writeFileSync(
    join(boundarySecretRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "boundary-secret-app",
        title: "Boundary Secret App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(boundarySecretRoot, "boundary.txt"),
    `${"x".repeat(1024 * 1024 - 5)}\n${["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("")}\n`,
  );
  assert.doesNotThrow(
    () => packApp(boundarySecretRoot, { outputPath: join(tempRoot, "boundary-secret-app.tgz") }),
    "content across former scan chunk boundaries must package normally",
  );

  const captured = await withPublishServer(async (registryUrl) =>
    publishApp(appRoot, {
      registryUrl,
      token: "registry-token",
    }),
  );
  assert.equal(captured.method, "POST");
  assert.equal(captured.url, "/v1/app-store/packages");
  assert.equal(captured.authorization, "Bearer registry-token");
  assert.equal(captured.contentType, "application/vnd.opengrove.app-package");
  assert.match(captured.idempotencyKey || "", /^og-app-publish-request-[a-f0-9]{64}$/);
  assert.ok(captured.bodyLength > 0);
  assert.equal(captured.metadata.packageKey, "demo.demo-app");
  assert.equal(captured.metadata.visibility, "restricted");

  // Provenance: non-git app roots pack without provenance.
  assert.equal(packed.packageManifest.provenance, undefined);

  const gitAppRoot = join(tempRoot, "git-app");
  mkdirSync(join(gitAppRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(gitAppRoot, "opengrove.app.json"),
    JSON.stringify(
      {
        id: "git-app",
        title: "Git App",
        version: "0.1.0",
        ui: { surface: "file-workbench", workspace: "workspace" },
        workspace: { path: "workspace" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(gitAppRoot, "README.md"), "git provenance demo\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", gitAppRoot, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "harness@opengrove.test");
  git("config", "user.name", "Harness");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "--quiet", "-m", "initial");
  const headCommit = git("rev-parse", "HEAD").trim();
  mkdirSync(join(gitAppRoot, "web", "node_modules", "demo-dependency"), { recursive: true });
  writeFileSync(join(gitAppRoot, "web", "node_modules", "demo-dependency", "index.js"), "export const demo = true;\n");

  const packedClean = packApp(gitAppRoot, { outputPath: join(tempRoot, "git-app-clean.tgz") });
  assert.equal(packedClean.packageManifest.provenance?.vcs, "git");
  assert.equal(packedClean.packageManifest.provenance?.commit, headCommit);
  assert.equal(packedClean.packageManifest.provenance?.dirty, false);
  assert.equal(packedClean.packageManifest.provenance?.remote, undefined);

  // Uncommitted change to a packed file flips dirty.
  writeFileSync(join(gitAppRoot, "README.md"), "git provenance demo — edited\n");
  const packedDirty = packApp(gitAppRoot, { outputPath: join(tempRoot, "git-app-dirty.tgz") });
  assert.equal(packedDirty.packageManifest.provenance?.dirty, true);
  git("add", "-A");
  git("commit", "--quiet", "-m", "edit");

  // Changes confined to pack-excluded paths (workspace/) stay clean.
  writeFileSync(join(gitAppRoot, "workspace", "scratch.txt"), "local only\n");
  const packedWorkspaceOnly = packApp(gitAppRoot, { outputPath: join(tempRoot, "git-app-workspace.tgz") });
  assert.equal(packedWorkspaceOnly.packageManifest.provenance?.dirty, false);

  console.log("app-pack-publish-harness ok");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function assertPackageSafetyParity(appRoot: string, archiveName: string, expected: RegExp): void {
  const prepareError = capturedError(() => validateAppPackageSource(appRoot));
  const packError = capturedError(() => packApp(appRoot, { outputPath: join(tempRoot, archiveName) }));
  assert.match(prepareError, expected);
  assert.equal(packError, prepareError, "streamed preparation and final packing must enforce the same safety policy");
}

function capturedError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected package safety validation to fail");
}

async function withPublishServer(run: (registryUrl: string) => Promise<unknown>): Promise<{
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  idempotencyKey?: string;
  bodyLength: number;
  metadata: Record<string, unknown>;
}> {
  const captured = {
    method: undefined as string | undefined,
    url: undefined as string | undefined,
    authorization: undefined as string | undefined,
    contentType: undefined as string | undefined,
    idempotencyKey: undefined as string | undefined,
    bodyLength: 0,
    metadata: {} as Record<string, unknown>,
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured.method = request.method;
      captured.url = request.url;
      captured.authorization = request.headers.authorization;
      captured.contentType = request.headers["content-type"];
      captured.idempotencyKey = String(request.headers["idempotency-key"] || "") || undefined;
      captured.bodyLength = Buffer.concat(chunks).byteLength;
      const metadataHeader = request.headers["x-opengrove-package-metadata"];
      const metadataText = Buffer.from(String(metadataHeader ?? ""), "base64url").toString("utf8");
      captured.metadata = JSON.parse(metadataText) as Record<string, unknown>;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ package: { packageKey: captured.metadata.packageKey } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
    return captured;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
