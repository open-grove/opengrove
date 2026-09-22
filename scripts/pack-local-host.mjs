import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nodePackageManagerInvocation } from "./node-package-manager-invocation.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "release", "local");
await mkdir(output, { recursive: true });
run(process.execPath, ["scripts/build-server.mjs", "--declarations"], root);
run(process.execPath, ["node_modules/typescript/bin/tsc6", "-p", "packages/sdk/tsconfig.json"], root);
const original = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stage = await mkdtemp(join(output, ".host-package-"));
try {
  for (const path of [
    "dist",
    "vendor",
    "assets",
    "docs",
    "examples/external-editor",
    "src/skills/bundled",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    await cp(join(root, path), join(stage, path), { recursive: true });
  }
  await rm(join(stage, "dist", "tests"), { recursive: true, force: true });
  const { "electron-updater": _desktopUpdater, ...dependencies } = original.dependencies;
  const router = JSON.parse(await readFile(join(root, "node_modules/@agent-router/sdk/package.json"), "utf8"));
  const manifest = {
    name: "@opengrove/host",
    version: original.version,
    type: "module",
    private: true,
    description: "Local OpenGrove Host for external products, without Desktop or Web UI assets.",
    license: original.license,
    engines: original.engines,
    clientReleaseNumber: original.clientReleaseNumber,
    bin: { opengrove: "dist/cli.js" },
    main: "./dist/server/create-server.js",
    types: "./dist/server/create-server.d.ts",
    exports: { ".": { types: "./dist/server/create-server.d.ts", import: "./dist/server/create-server.js" } },
    imports: Object.fromEntries(Object.entries(original.imports).map(([key, value]) => [key, value.default])),
    // npm installs the bundled Router SDK dependencies from the consumer root.
    dependencies: { ...router.dependencies, ...dependencies },
    bundleDependencies: original.bundleDependencies,
    files: [
      "dist",
      "vendor",
      "assets",
      "docs",
      "examples/external-editor",
      "src/skills/bundled",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "README.md",
    ],
  };
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(stage, "README.md"),
    "# OpenGrove local Host\n\nRun `opengrove start` or import `startOpenGroveServer` from `@opengrove/host`.\nRequires Node.js 24 and an installed/configured native Agent.\n\nSee [Local integration](docs/reference/LOCAL_INTEGRATION.md) / [本地产品接入](docs/reference/LOCAL_INTEGRATION.zh-CN.md) for authentication, SDK usage, product tools and limitations.\nThis local package does not include Desktop or Web UI output.\n",
  );
  // npm follows this tree only for explicitly bundled dependencies and their closure.
  await symlink(
    join(root, "node_modules"),
    join(stage, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  npm(["pack", "--ignore-scripts", "--pack-destination", output], stage);
  npm(["pack", "--ignore-scripts", "--pack-destination", output], join(root, "packages/sdk"));
  console.log(`Local Host and SDK packages: ${output}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
function npm(args, cwd) {
  const invocation = nodePackageManagerInvocation("npm", args);
  run(invocation.command, invocation.args, cwd);
}
function run(command, args, cwd) {
  const child = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`${command} failed (${child.status ?? child.signal})`);
}
