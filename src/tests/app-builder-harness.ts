import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appImportReport,
  inspectAppSource,
  mountAppInSettings,
  packApp,
  scaffoldApp,
  stageAppSource,
  validateAppRoot,
} from "../app-builder/cli.js";
import { validateAppCliTargetFile } from "../app-builder/cli-targets.js";
import { importProjectAsApp } from "../app-builder/importer.js";
import { resolveAppManifestPresentation } from "../app-builder/manifest-localization.js";
import { validateAppManifestText } from "../app-builder/manifest.js";
import { normalizeAppUi } from "../app-builder/ui-runtime.js";
import { normalizeCompatibleAppUi } from "../app-builder/compat/legacy-app-ui.compat.js";
import { migrateMountedAppManifestV1 } from "../server/migrations/app-manifest-v1.js";
import { validateAppReleaseBuildContract } from "../server/app-release-build-contract.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-app-builder-"));

try {
  const appRoot = join(tempRoot, "demo-app");
  const scaffolded = scaffoldApp(appRoot, {
    id: "demo-app",
    title: "Demo App",
    description: "Harness app.",
  });
  assert.equal(scaffolded.ok, true);
  assert.equal(existsSync(join(appRoot, "AGENTS.md")), true);
  const scaffoldManifest = JSON.parse(readFileSync(join(appRoot, "opengrove.app.json"), "utf8")) as {
    ui?: { surface?: string };
    employees?: Array<{ kernel?: string; model?: string }>;
  };
  assert.equal(scaffoldManifest.ui?.surface, "setup", "new App scaffolds should start in deterministic setup");
  assert.equal(scaffoldManifest.employees, undefined, "setup scaffolds must not declare a placeholder Operator");
  assert.equal(
    existsSync(join(appRoot, "ui", "index.html")),
    false,
    "setup scaffolds must not emit protocol-demo HTML",
  );
  assert.equal(
    existsSync(join(appRoot, "skills", "demo-app-operator", "SKILL.md")),
    false,
    "setup scaffolds must not emit a placeholder Operator skill",
  );

  const valid = validateAppRoot(appRoot);
  assert.equal(valid.ok, true);
  assert.equal(valid.workspacePath, "workspace");

  writeFileSync(
    join(appRoot, "workspace", "demo.flow.md"),
    [
      "---",
      "flow: v1",
      "title: Demo Flow",
      "status: pending",
      "steps:",
      "  - id: s1",
      "    title: First step",
      "    owner: operator",
      "    status: pending",
      "---",
      "",
      "# Demo Flow",
    ].join("\n"),
    "utf8",
  );
  const flowValidated = validateAppRoot(appRoot);
  assert.equal(flowValidated.ok, true);
  assert.deepEqual(flowValidated.warnings, []);

  const inspected = inspectAppSource(appRoot);
  assert.equal(inspected.sourceType, "opengrove-app");
  assert.equal(inspected.manifest, "valid");
  assert.equal(inspected.recommendedUiKind, "setup");
  assert.equal((inspected.capabilities as { flows?: boolean }).flows, true);

  writeFileSync(join(appRoot, "workspace", "bad.flow.md"), "---\nflow: v1\nstatus: pending\n---\n", "utf8");
  const invalidFlow = validateAppRoot(appRoot);
  assert.equal(invalidFlow.ok, true);
  assert.equal(
    (invalidFlow.warnings as string[]).some((warning) => warning.includes("bad.flow.md")),
    true,
  );

  const loopAppRoot = join(tempRoot, "loop-app");
  scaffoldApp(loopAppRoot, {
    id: "loop-app",
    title: "Loop App",
    force: true,
  });
  writeFileSync(
    join(loopAppRoot, "workspace", "loop.flow.md"),
    [
      "---",
      "flow: v1",
      "title: Loop Flow",
      "status: pending",
      "steps:",
      "  - id: s1",
      "    title: Loop step",
      "    owner: operator",
      "    status: pending",
      "---",
      "",
      "# Loop Flow",
    ].join("\n"),
    "utf8",
  );
  symlinkSync(
    join(loopAppRoot, "workspace"),
    join(loopAppRoot, "workspace", "loop"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const loopValidated = validateAppRoot(loopAppRoot);
  assert.equal(loopValidated.ok, true);
  assert.equal((loopValidated.warnings as string[]).length, 0);
  const loopInspected = inspectAppSource(loopAppRoot);
  assert.equal((loopInspected.capabilities as { flows?: boolean }).flows, true);

  const stagedRoot = join(tempRoot, "staged-app");
  const staged = await stageAppSource(appRoot, {
    target: stagedRoot,
    copy: true,
  });
  assert.equal(staged.ok, true);
  assert.equal(existsSync(join(stagedRoot, "opengrove.app.json")), true);

  const report = appImportReport(stagedRoot);
  assert.equal(report.readyToMount, true);
  assert.deepEqual(report.mountCandidate, {
    id: "demo-app",
    title: "Demo App",
    path: stagedRoot,
    enabled: true,
  });

  const settingsPath = join(tempRoot, "bridge-settings.json");
  const mounted = mountAppInSettings(stagedRoot, { settingsPath });
  assert.equal(mounted.ok, true);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    mountedApps: Array<{ id: string; path: string; title: string; enabled: boolean }>;
  };
  assert.deepEqual(settings.mountedApps, [
    {
      id: "demo-app",
      path: stagedRoot,
      title: "Demo App",
      enabled: true,
    },
  ]);

  const webRoot = join(tempRoot, "web-project");
  scaffoldApp(webRoot, {
    id: "web-project",
    title: "Web Project",
    uiSurface: "view",
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(webRoot, ".opengrove-build.json"), "utf8")),
    {
      schemaVersion: 1,
      workingDirectory: ".",
      inputs: ["web", "build.mjs"],
      outputs: ["ui"],
      commands: [["node", "build.mjs"]],
    },
    "known view scaffolds must declare their reproducible build instead of guessing later",
  );
  assert.equal(
    readFileSync(join(webRoot, "web", "index.html"), "utf8"),
    readFileSync(join(webRoot, "ui", "index.html"), "utf8"),
  );
  writeFileSync(
    join(webRoot, "package.json"),
    JSON.stringify({ name: "web-project", scripts: { dev: "vite" } }),
    "utf8",
  );
  const webInspected = inspectAppSource(webRoot);
  assert.equal(webInspected.uiStatus, "existing-ui");

  // A literal backslash makes JSON encode the source root as `\\\\` even on
  // POSIX, reproducing the Windows path shape without platform-specific tests.
  const workflowSource = join(tempRoot, "workflow-source\\escaped");
  mkdirSync(join(workflowSource, "src"), { recursive: true });
  mkdirSync(join(workflowSource, "scripts"), { recursive: true });
  mkdirSync(join(workflowSource, "data"), { recursive: true });
  mkdirSync(join(workflowSource, "projects", "#1#", "tmp"), { recursive: true });
  mkdirSync(join(workflowSource, "projects", "#1#", "outputs", "final"), { recursive: true });
  mkdirSync(join(workflowSource, "clip_generator_tmp"), { recursive: true });
  writeFileSync(join(workflowSource, "requirements.txt"), "pydantic\n", "utf8");
  writeFileSync(join(workflowSource, "src", "project_compat.py"), "print('ok')\n", "utf8");
  writeFileSync(join(workflowSource, "scripts", "run.py"), "print('run')\n", "utf8");
  const unrelatedJson = '{"opaque_id":9007199254740993123456789,"layout":[1,2]}';
  writeFileSync(join(workflowSource, "data", "unrelated.json"), unrelatedJson, "utf8");
  writeFileSync(
    join(workflowSource, "data", "path-key.json"),
    `{${JSON.stringify(workflowSource)}:"metadata"}`,
    "utf8",
  );
  const pathPrefixCollisionJson = JSON.stringify({ path: `${workflowSource}or/output.json` });
  writeFileSync(join(workflowSource, "data", "path-prefix-collision.json"), pathPrefixCollisionJson, "utf8");
  const pathDotSuffixJson = JSON.stringify({ path: `${workflowSource}.bak/output.json` });
  writeFileSync(join(workflowSource, "data", "path-dot-suffix.json"), pathDotSuffixJson, "utf8");
  writeFileSync(join(workflowSource, "PATHS.md"), `Project lives at ${workflowSource}.\n`, "utf8");
  writeFileSync(
    join(workflowSource, "projects", "#1#", "outputs", "final", "clip_plan.json"),
    JSON.stringify({
      source_video: join(workflowSource, "projects", "#1#", "source", "videos", "EP1.mp4"),
    }),
    "utf8",
  );
  writeFileSync(join(workflowSource, ".env"), "SECRET=1\n", "utf8");
  writeFileSync(join(workflowSource, "clip_generator_tmp", "cache.mp4"), "cache", "utf8");
  writeFileSync(join(workflowSource, "projects", "#1#", "tmp", "cache.mp4"), "cache", "utf8");
  const workflowInspected = inspectAppSource(workflowSource);
  assert.equal(workflowInspected.sourceType, "workflow-project");
  const importedWorkflowRoot = join(tempRoot, "imported-workflow");
  const importedWorkflow = importProjectAsApp(workflowSource, {
    id: "workflow-import",
    title: "Workflow Import",
    target: importedWorkflowRoot,
  });
  assert.equal(importedWorkflow.ok, true);
  const importedManifest = JSON.parse(readFileSync(join(importedWorkflowRoot, "opengrove.app.json"), "utf8")) as {
    employees?: Array<{ kernel?: string; model?: string }>;
  };
  assert.equal(
    importedManifest.employees?.[0]?.kernel,
    undefined,
    "imported App employees should inherit the user's active kernel",
  );
  assert.equal(
    importedManifest.employees?.[0]?.model,
    undefined,
    "imported App employees should inherit that kernel's selected model",
  );
  assert.equal(existsSync(join(importedWorkflowRoot, "AGENTS.md")), true);
  assert.equal(validateAppRoot(importedWorkflowRoot).ok, true);
  assert.deepEqual(
    validateAppReleaseBuildContract(importedWorkflowRoot),
    { ok: true, detail: "build_contract_valid" },
    "an imported project must enter OpenGrove with an explicit platform build contract",
  );
  assert.match(
    readFileSync(join(importedWorkflowRoot, ".gitignore"), "utf8"),
    /^node_modules\/$/m,
    "imported Apps must exclude local dependency trees from formal source snapshots",
  );
  const importedCheckout = join(tempRoot, "imported-workflow-checkout");
  assert.equal(
    spawnSync("git", ["clone", "--quiet", importedWorkflowRoot, importedCheckout], { encoding: "utf8" }).status,
    0,
  );
  const importedBuild = spawnSync(process.execPath, ["build.mjs"], {
    cwd: importedCheckout,
    encoding: "utf8",
  });
  assert.equal(importedBuild.status, 0, importedBuild.stderr);
  assert.equal(
    spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: importedCheckout,
      encoding: "utf8",
    }).stdout,
    "",
    "the imported App build must reproduce committed output in a fresh checkout",
  );
  assert.equal(existsSync(join(importedWorkflowRoot, "source-project", "src", "project_compat.py")), true);
  assert.equal(
    readFileSync(join(importedWorkflowRoot, "source-project", "data", "unrelated.json"), "utf8"),
    unrelatedJson,
    "importing a project must preserve unrelated JSON bytes and large integer literals",
  );
  const importedSourceRoot = realpathSync(join(importedWorkflowRoot, "source-project"));
  assert.deepEqual(
    JSON.parse(readFileSync(join(importedWorkflowRoot, "source-project", "data", "path-key.json"), "utf8")),
    { [importedSourceRoot]: "metadata" },
    "an absolute source path used as a JSON object key must follow the imported project",
  );
  assert.equal(
    readFileSync(join(importedWorkflowRoot, "source-project", "data", "path-prefix-collision.json"), "utf8"),
    pathPrefixCollisionJson,
    "a directory name that merely starts with the source root must not be rewritten",
  );
  assert.equal(
    readFileSync(join(importedWorkflowRoot, "source-project", "data", "path-dot-suffix.json"), "utf8"),
    pathDotSuffixJson,
    "a dot-suffixed sibling directory must not be mistaken for the source root",
  );
  assert.equal(
    readFileSync(join(importedWorkflowRoot, "source-project", "PATHS.md"), "utf8"),
    `Project lives at ${importedSourceRoot}.\n`,
    "a source path followed by sentence punctuation must migrate with the imported project",
  );
  assert.equal(existsSync(join(importedWorkflowRoot, "source-project", ".env")), false);
  assert.equal(existsSync(join(importedWorkflowRoot, "source-project", "clip_generator_tmp")), false);
  assert.equal(existsSync(join(importedWorkflowRoot, "source-project", "projects", "#1#", "tmp")), false);
  const importedClipPlan = JSON.parse(
    readFileSync(
      join(importedWorkflowRoot, "source-project", "projects", "#1#", "outputs", "final", "clip_plan.json"),
      "utf8",
    ),
  ) as { source_video: string };
  assert.equal(
    importedClipPlan.source_video
      .replaceAll("\\", "/")
      .startsWith(realpathSync(join(importedWorkflowRoot, "source-project")).replaceAll("\\", "/")),
    true,
  );

  const unsafeRoot = join(tempRoot, "unsafe-app");
  scaffoldApp(unsafeRoot, {
    id: "unsafe-app",
    title: "Unsafe App",
    force: true,
  });
  writeFileSync(
    join(unsafeRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "unsafe-app",
      title: "Unsafe App",
      ui: { surface: "file-workbench", workspace: "../outside" },
    }),
    "utf8",
  );
  const unsafe = validateAppRoot(unsafeRoot);
  assert.equal(unsafe.ok, false);
  assert.deepEqual(unsafe.issues, ["workspace escapes app root: ../outside"]);

  const cliArgsRoot = join(tempRoot, "cli-args-app");
  scaffoldApp(cliArgsRoot, {
    id: "cli-args-app",
    title: "CLI Args App",
    force: true,
  });
  mkdirSync(join(cliArgsRoot, "scripts"), { recursive: true });
  writeFileSync(
    join(cliArgsRoot, "scripts", "task.mjs"),
    "#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(','));\n",
    "utf8",
  );
  writeFileSync(
    join(cliArgsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "cli-args-app",
      title: "CLI Args App",
      capabilities: {
        cli: [
          {
            id: "legacy-inline-args",
            command: "node scripts/task.mjs --fixed",
          },
        ],
      },
    }),
    "utf8",
  );
  assert.equal(
    validateAppRoot(cliArgsRoot).ok,
    true,
    "validation must parse a legacy command string instead of treating it as one file path",
  );

  writeFileSync(
    join(cliArgsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "cli-args-app",
      title: "CLI Args App",
      capabilities: {
        cli: [
          {
            id: "declared-args",
            command: "node",
            args: ["--experimental-vm-modules", "scripts/missing.mjs", "--fixed"],
          },
        ],
      },
    }),
    "utf8",
  );
  const missingCliArg = validateAppRoot(cliArgsRoot);
  assert.equal(missingCliArg.ok, false, "validation must reject a missing App-owned Node script from args");
  assert.ok(
    (missingCliArg.issues as string[]).some((issue) => issue.includes("scripts/missing.mjs")),
    `missing script issue not reported: ${(missingCliArg.issues as string[]).join("; ")}`,
  );

  writeFileSync(
    join(cliArgsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "cli-args-app",
      title: "CLI Args App",
      capabilities: {
        cli: [
          {
            id: "declared-args",
            command: "node",
            args: ["--experimental-vm-modules", "scripts/task.mjs", "--fixed"],
          },
        ],
      },
    }),
    "utf8",
  );
  assert.equal(
    validateAppRoot(cliArgsRoot).ok,
    true,
    "command + args must pass validation when its App-owned Node script exists",
  );

  writeFileSync(
    join(cliArgsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "cli-args-app",
      title: "CLI Args App",
      capabilities: {
        cli: [
          {
            id: "node-eval",
            command: "node",
            args: ["--eval", "process.stdout.write('ok')"],
          },
        ],
      },
    }),
    "utf8",
  );
  assert.equal(
    validateAppRoot(cliArgsRoot).ok,
    true,
    "Node eval source must not be treated as an App-owned script path",
  );

  writeFileSync(join(tempRoot, "outside.mjs"), "process.stdout.write('outside');\n", "utf8");
  writeFileSync(
    join(cliArgsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "cli-args-app",
      title: "CLI Args App",
      capabilities: {
        cli: [
          {
            id: "outside-script",
            command: "node",
            args: ["../outside.mjs"],
          },
        ],
      },
    }),
    "utf8",
  );
  const outsideCliArg = validateAppRoot(cliArgsRoot);
  assert.equal(outsideCliArg.ok, false, "validation must reject a Node script outside the App root");
  assert.ok(
    (outsideCliArg.issues as string[]).includes("cli script escapes app root: ../outside.mjs"),
    `outside script issue not reported: ${(outsideCliArg.issues as string[]).join("; ")}`,
  );

  const linkedOutsideArg =
    process.platform === "win32" ? "scripts/linked-outside/outside.mjs" : "scripts/linked-outside.mjs";
  if (process.platform === "win32") {
    const linkedOutsideRoot = join(tempRoot, "linked-outside-root");
    mkdirSync(linkedOutsideRoot, { recursive: true });
    writeFileSync(join(linkedOutsideRoot, "outside.mjs"), "process.exit(0);\n", "utf8");
    symlinkSync(linkedOutsideRoot, join(cliArgsRoot, "scripts", "linked-outside"), "junction");
  } else {
    symlinkSync(join(tempRoot, "outside.mjs"), join(cliArgsRoot, linkedOutsideArg));
  }
  writeFileSync(
    join(cliArgsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "cli-args-app",
      title: "CLI Args App",
      capabilities: {
        cli: [
          {
            id: "linked-outside-script",
            command: "node",
            args: [linkedOutsideArg],
          },
        ],
      },
    }),
    "utf8",
  );
  const linkedOutsideCliArg = validateAppRoot(cliArgsRoot);
  assert.equal(linkedOutsideCliArg.ok, false, "validation must resolve symlinks before accepting an App-owned script");
  assert.ok(
    (linkedOutsideCliArg.issues as string[]).includes(`cli script escapes app root: ${linkedOutsideArg}`),
    `symlink escape issue not reported: ${(linkedOutsideCliArg.issues as string[]).join("; ")}`,
  );

  writeFileSync(
    join(cliArgsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "cli-args-app",
      title: "CLI Args App",
      capabilities: {
        cli: [
          {
            id: "external-cli",
            command: "external-cli",
            args: ["--status"],
          },
        ],
      },
    }),
    "utf8",
  );
  assert.equal(
    validateAppRoot(cliArgsRoot).ok,
    true,
    "a bare independently installed command must not be mistaken for an App-owned path",
  );

  const jsoncWithGlob = validateAppManifestText(`{
    // comment
    "id": "glob-app",
    "title": "Glob App",
    "ui": { "surface": "file-workbench", "workspace": "workspace" },
    "capabilities": {
      "cli": [{
        "id": "glob-cli",
        "command": "./bin/glob",
        "artifacts": ["workspace/runs/**", "source-project/projects/**/outputs/**"]
      }]
    }
  }`);
  assert.equal(jsoncWithGlob.ok, true);
  const globManifest = jsoncWithGlob.manifest as { capabilities?: { cli?: Array<{ artifacts?: string[] }> } };
  assert.deepEqual(globManifest.capabilities?.cli?.[0]?.artifacts, [
    "workspace/runs/**",
    "source-project/projects/**/outputs/**",
  ]);

  const safeEmployeeAvatarManifest = validateAppManifestText(`{
    "id": "safe-employee-avatar-app",
    "title": "Safe Employee Avatar App",
    "employees": [{
      "id": "reviewer",
      "name": "Reviewer",
      "avatarMode": "upload",
      "avatarDataUrl": "data:image/png;base64,c2FmZQ=="
    }]
  }`);
  assert.equal(safeEmployeeAvatarManifest.ok, true);

  const uppercaseAppIdentityManifest = validateAppManifestText(`{
    "id": "Uppercase-App",
    "title": "Uppercase App",
    "employees": [{ "id": "writer", "name": "Writer" }]
  }`);
  assert.equal(uppercaseAppIdentityManifest.ok, false);
  assert.ok(uppercaseAppIdentityManifest.issues.some((issue) => issue.includes("lowercase and URL-safe")));

  const uppercaseEmployeeIdentityManifest = validateAppManifestText(`{
    "id": "uppercase-employee-app",
    "title": "Uppercase Employee App",
    "employees": [{ "id": "Writer", "name": "Writer" }]
  }`);
  assert.equal(uppercaseEmployeeIdentityManifest.ok, false);
  assert.ok(uppercaseEmployeeIdentityManifest.issues.some((issue) => issue.includes("lowercase and URL-safe")));

  const duplicateEmployeeIdentityManifest = validateAppManifestText(`{
    "id": "duplicate-employee-app",
    "title": "Duplicate Employee App",
    "employees": [{ "name": "Writer" }],
    "rooms": { "employees": [{ "name": "writer" }] }
  }`);
  assert.equal(duplicateEmployeeIdentityManifest.ok, false);
  assert.ok(duplicateEmployeeIdentityManifest.issues.includes("employees contain duplicate identities: writer"));

  const remoteEmployeeAvatarManifest = validateAppManifestText(`{
    "id": "remote-employee-avatar-app",
    "title": "Remote Employee Avatar App",
    "employees": [{
      "id": "reviewer",
      "name": "Reviewer",
      "avatarMode": "upload",
      "avatarDataUrl": "https://tracker.example/avatar.png"
    }]
  }`);
  assert.equal(remoteEmployeeAvatarManifest.ok, false, "employee declarations must reject remote avatar URLs");

  const portableCliManifest = validateAppManifestText(`{
    "id": "portable-cli-app",
    "title": "Portable CLI App",
    "capabilities": {
      "cli": [{
        "id": "portable-cli",
        "command": "./bin/portable-cli",
        "targets": {
          "darwin-arm64": "./bin/macos/portable-cli",
          "darwin-x64": "./bin/macos/portable-cli",
          "win32-x64": "./bin/windows-x64/portable-cli.exe",
          "linux-x64": "./bin/linux-x64/portable-cli",
          "linux-arm64": "./bin/linux-arm64/portable-cli"
        }
      }]
    }
  }`);
  assert.equal(portableCliManifest.ok, true);

  const invalidPortableCliManifest = validateAppManifestText(`{
    "id": "invalid-portable-cli-app",
    "title": "Invalid Portable CLI App",
    "capabilities": {
      "cli": [{
        "id": "portable-cli",
        "command": "./bin/portable-cli",
        "targets": {
          "linux-amd64": "./bin/linux-x64/portable-cli",
          "linux-x64": "/tmp/outside-app"
        }
      }]
    }
  }`);
  assert.equal(invalidPortableCliManifest.ok, false);

  const invalidTargetRoot = join(tempRoot, "invalid-target-app");
  const invalidTargetWrapper = join(invalidTargetRoot, "bin", "portable-cli");
  const invalidTargetBinary = join(invalidTargetRoot, "bin", "linux-x64", "portable-cli");
  mkdirSync(join(invalidTargetRoot, "bin", "linux-x64"), { recursive: true });
  writeFileSync(invalidTargetWrapper, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(invalidTargetWrapper, 0o755);
  const wrongArchitecture = Buffer.alloc(64);
  wrongArchitecture.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
  wrongArchitecture.writeUInt16LE(0xb7, 18);
  writeFileSync(invalidTargetBinary, wrongArchitecture);
  chmodSync(invalidTargetBinary, 0o755);
  writeFileSync(
    join(invalidTargetRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "invalid-target-app",
      title: "Invalid Target App",
      capabilities: {
        cli: [
          {
            id: "portable-cli",
            command: "./bin/portable-cli",
            targets: {
              "linux-x64": "./bin/linux-x64/portable-cli",
              "linux-arm64": "./bin/linux-arm64/portable-cli",
            },
          },
        ],
      },
    }),
    "utf8",
  );
  const invalidTargets = validateAppRoot(invalidTargetRoot);
  assert.equal(invalidTargets.ok, false);
  const invalidTargetIssues = invalidTargets.issues as string[];
  assert.ok(invalidTargetIssues.some((issue) => issue.includes("linux-x64 arch_mismatch")));
  assert.ok(invalidTargetIssues.some((issue) => issue.includes("linux-arm64 missing")));
  wrongArchitecture.writeUInt16LE(0x3e, 18);
  writeFileSync(invalidTargetBinary, wrongArchitecture);
  chmodSync(invalidTargetBinary, 0o644);
  assert.deepEqual(
    validateAppCliTargetFile(invalidTargetBinary, "linux-x64", {
      appRoot: invalidTargetRoot,
      hostPlatform: "win32",
    }),
    [],
    "Windows package validation cannot infer Unix execute bits from NTFS",
  );

  const symlinkTargetRoot = join(tempRoot, "symlink-target-app");
  const externalTargetDir = join(tempRoot, "external-linux-x64");
  const externalTarget = join(externalTargetDir, "portable-cli");
  mkdirSync(join(symlinkTargetRoot, "bin"), { recursive: true });
  mkdirSync(externalTargetDir, { recursive: true });
  writeFileSync(join(symlinkTargetRoot, "bin", "portable-cli"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(symlinkTargetRoot, "bin", "portable-cli"), 0o755);
  const externalElf = Buffer.alloc(64);
  externalElf.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
  externalElf.writeUInt16LE(0x3e, 18);
  writeFileSync(externalTarget, externalElf);
  chmodSync(externalTarget, 0o755);
  symlinkSync(
    externalTargetDir,
    join(symlinkTargetRoot, "bin", "linux-x64"),
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(
    join(symlinkTargetRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "symlink-target-app",
      title: "Symlink Target App",
      capabilities: {
        cli: [
          {
            id: "portable-cli",
            command: "./bin/portable-cli",
            targets: { "linux-x64": "./bin/linux-x64/portable-cli" },
          },
        ],
      },
    }),
    "utf8",
  );
  const symlinkTargets = validateAppRoot(symlinkTargetRoot);
  assert.equal(symlinkTargets.ok, false);
  assert.ok((symlinkTargets.issues as string[]).some((issue) => issue.includes("linux-x64 outside_app")));

  const localizedManifest = validateAppManifestText(`{
    "id": "localized-app",
    "title": "本地化 App",
    "description": "默认说明",
    "defaultLocale": "zh-CN",
    "welcome": { "message": "默认欢迎语" },
    "ui": {
      "tabs": [{ "id": "workspace", "component": "file-tree", "label": "工作区" }]
    },
    "employees": [{
      "id": "writer",
      "name": "作者",
      "role": "规范运行时角色",
      "publicDescription": "默认公开说明"
    }],
    "capabilities": {
      "cli": [{ "id": "tool", "command": "./bin/tool", "title": "工具" }]
    },
    "locales": {
      "en": {
        "title": "Localized App",
        "description": "Localized description",
        "ui": { "tabs": { "workspace": { "label": "Workspace" } } },
        "employees": { "writer": {
          "name": "Writer",
          "publicDescription": "Public description"
        } },
        "capabilities": { "cli": { "tool": {
          "title": "Tool",
          "description": "Localized CLI"
        } } },
        "welcome": { "message": "Welcome" }
      }
    }
  }`);
  assert.equal(localizedManifest.ok, true, localizedManifest.issues.join("\n"));
  const presentation = resolveAppManifestPresentation(localizedManifest.manifest!, "en");
  assert.equal(presentation.title, "Localized App");
  assert.equal(presentation.tabs.workspace?.label, "Workspace");
  assert.equal(presentation.employees.writer?.name, "Writer");
  assert.equal(presentation.cli.tool?.title, "Tool");
  assert.equal(presentation.welcomeMessage, "Welcome");
  assert.equal(
    resolveAppManifestPresentation({ name: "Readable Name", id: "machine-id", defaultLocale: "en" }, "en").title,
    "Readable Name",
  );
  const legacyEnglishPresentation = resolveAppManifestPresentation(
    {
      id: "legacy-workbench",
      defaultLocale: "zh-CN",
      title: "旧工作台",
      description: "只有中文描述",
      welcome: { message: "只有中文欢迎语" },
      ui: {
        tabs: [{ id: "workspace", component: "file-tree", label: "工作区" }],
      },
      capabilities: {
        cli: [{ id: "sync-report", title: "同步报表", description: "同步线上数据" }],
      },
      employees: [
        {
          id: "legacy-writer",
          name: "旧作者",
          role: "旧角色",
        },
      ],
    },
    "en",
  );
  assert.equal(legacyEnglishPresentation.localeMatched, false);
  assert.equal(legacyEnglishPresentation.title, "旧工作台");
  assert.equal(legacyEnglishPresentation.description, "只有中文描述");
  assert.equal(legacyEnglishPresentation.tabs.workspace?.label, "工作区");
  assert.equal(legacyEnglishPresentation.cli["sync-report"]?.title, "同步报表");
  assert.equal(legacyEnglishPresentation.cli["sync-report"]?.description, "同步线上数据");
  assert.equal(legacyEnglishPresentation.welcomeMessage, "只有中文欢迎语");
  assert.deepEqual(
    legacyEnglishPresentation.employees,
    {},
    "A missing locale preserves canonical App text instead of fabricating translations from identifiers",
  );

  const unknownWelcomeField = validateAppManifestText(`{
    "id": "unknown-welcome-field",
    "title": "Unknown Welcome Field",
    "welcome": { "message": "Hello", "role": "must-not-leak-into-runtime" }
  }`);
  assert.equal(unknownWelcomeField.ok, false);
  assert.equal(
    unknownWelcomeField.issues.some((issue) => issue.includes("Unrecognized key")),
    true,
  );

  const runtimeFieldInLocale = validateAppManifestText(`{
    "id": "unsafe-localized-agent",
    "title": "Unsafe",
    "defaultLocale": "en",
    "employees": [{ "id": "writer", "name": "Writer", "role": "Canonical role" }],
    "locales": { "zh-CN": { "employees": {
      "writer": { "name": "作者", "role": "不要让 Locale 改变 Prompt" }
    } } }
  }`);
  assert.equal(runtimeFieldInLocale.ok, true);
  assert.equal(
    (runtimeFieldInLocale.manifest?.employees as Array<Record<string, unknown>>)[0]?.role,
    "Canonical role",
    "localized presentation fields never replace canonical prompt metadata",
  );
  assert.equal(
    resolveAppManifestPresentation(runtimeFieldInLocale.manifest!, "zh-CN").employees.writer?.role,
    "不要让 Locale 改变 Prompt",
    "localized role is exposed only through the presentation overlay",
  );

  const nativeUi = validateAppManifestText(`{
    "id": "native-ui",
    "title": "Native UI",
    "ui": { "kind": "native" }
  }`);
  assert.equal(nativeUi.ok, true);
  assert.equal(
    nativeUi.warnings.some((warning) => warning.includes("ui.kind=native")),
    true,
  );

  const newViewUi = validateAppManifestText(`{
    "id": "new-view-ui",
    "title": "New View UI",
    "ui": {
      "surface": "view",
      "workspace": "workspace",
      "view": { "protocol": "mcp-app", "entry": "ui/index.html", "tools": [] }
    },
    "workspace": { "path": "workspace" }
  }`);
  assert.equal(newViewUi.ok, true);
  assert.equal(normalizeAppUi(newViewUi.manifest).surface, "view");

  const workbenchViewTab = validateAppManifestText(`{
    "id": "workbench-view-tab",
    "title": "Workbench View Tab",
    "ui": {
      "surface": "file-workbench",
      "workspace": "workspace",
      "workbenchLayout": { "filesWidth": 180, "chatWidth": 800 },
      "tabs": [{
        "id": "work-management",
        "component": "view",
        "label": "作品管理",
        "view": {
          "protocol": "mcp-app",
          "entry": "ui/work-management.html",
          "tools": ["opengrove.app.workspace.list"]
        }
      }]
    }
  }`);
  assert.equal(workbenchViewTab.ok, true, workbenchViewTab.issues.join("\n"));
  assert.equal(workbenchViewTab.warnings.length, 0);
  assert.deepEqual(workbenchViewTab.manifest?.ui?.workbenchLayout, { filesWidth: 180, chatWidth: 800 });

  const invalidWorkbenchLayout = validateAppManifestText(`{
    "id": "invalid-workbench-layout",
    "title": "Invalid Workbench Layout",
    "ui": {
      "surface": "file-workbench",
      "workbenchLayout": { "filesWidth": 0, "chatWidth": "800" }
    }
  }`);
  assert.equal(invalidWorkbenchLayout.ok, false, "workbench layout defaults must be positive finite numbers");

  const invalidWorkbenchViewTab = validateAppManifestText(`{
    "id": "invalid-workbench-view-tab",
    "title": "Invalid Workbench View Tab",
    "ui": {
      "surface": "file-workbench",
      "workspace": "workspace",
      "tabs": [{
        "component": "view",
        "view": {
          "protocol": "mcp-app",
          "entry": "../outside.html",
          "tools": ["opengrove.host.internal"]
        }
      }]
    }
  }`);
  assert.equal(invalidWorkbenchViewTab.ok, false);
  assert.deepEqual(invalidWorkbenchViewTab.issues, [
    "ui.tabs[0].id is required for component=view",
    "ui.tabs[0].view.entry must be a relative path inside the App root",
    "ui.tabs[0].view.tools contains unsupported tools: opengrove.host.internal",
  ]);

  const hiddenViewTab = validateAppManifestText(`{
    "id": "hidden-view-tab",
    "title": "Hidden View Tab",
    "ui": {
      "surface": "none",
      "tabs": [{
        "id": "hidden",
        "component": "view",
        "view": { "protocol": "mcp-app", "entry": "ui/hidden.html", "tools": [] }
      }]
    }
  }`);
  assert.deepEqual(hiddenViewTab.issues, ["ui.tabs[0].component=view is only allowed when ui.surface=file-workbench"]);

  const missingViewTabEntryRoot = join(tempRoot, "missing-view-tab-entry");
  mkdirSync(join(missingViewTabEntryRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(missingViewTabEntryRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "missing-view-tab-entry",
      title: "Missing View Tab Entry",
      ui: {
        surface: "file-workbench",
        workspace: "workspace",
        tabs: [
          {
            id: "work-management",
            component: "view",
            view: { protocol: "mcp-app", entry: "ui/missing.html", tools: [] },
          },
        ],
      },
    }),
    "utf8",
  );
  const missingViewTabEntry = validateAppRoot(missingViewTabEntryRoot);
  assert.equal(missingViewTabEntry.ok, false);
  assert.deepEqual(missingViewTabEntry.issues, ["ui.tabs[0].view.entry does not exist: ui/missing.html"]);
  assert.throws(
    () => packApp(missingViewTabEntryRoot, { outputPath: join(tempRoot, "missing-view-tab-entry.tgz") }),
    /app_not_valid: ui\.tabs\[0\]\.view\.entry does not exist/u,
    "pack must reject a missing View Tab bundle even when the caller skipped app validate",
  );

  const excludedViewTabEntryRoot = join(tempRoot, "excluded-view-tab-entry");
  mkdirSync(join(excludedViewTabEntryRoot, "workspace"), { recursive: true });
  mkdirSync(join(excludedViewTabEntryRoot, "ui"), { recursive: true });
  writeFileSync(join(excludedViewTabEntryRoot, "ui", "view.html"), "<h1>view</h1>", "utf8");
  writeFileSync(
    join(excludedViewTabEntryRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "excluded-view-tab-entry",
      title: "Excluded View Tab Entry",
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
      store: { packExclude: ["ui/view.html"] },
    }),
    "utf8",
  );
  assert.throws(
    () => packApp(excludedViewTabEntryRoot, { outputPath: join(tempRoot, "excluded-view-tab-entry.tgz") }),
    /pack_ui_entry_excluded:ui\.tabs\[0\]\.view\.entry:ui\/view\.html/u,
    "pack must reject a View Tab whose entry was removed by packExclude",
  );

  const legacyMcpUi = validateAppManifestText(`{
    "id": "legacy-mcp-ui",
    "title": "Legacy MCP UI",
    "ui": { "kind": "mcp-app", "entry": "ui/index.html", "tools": [] }
  }`);
  assert.equal(legacyMcpUi.ok, true);
  assert.equal(
    normalizeCompatibleAppUi(legacyMcpUi.manifest).surface,
    "view",
    "legacy mcp-app must remain openable at the migration boundary",
  );

  const legacyMcpRoot = join(tempRoot, "legacy-mcp-ui");
  mkdirSync(join(legacyMcpRoot, "ui"), { recursive: true });
  const legacyMcpManifestPath = join(legacyMcpRoot, "opengrove.app.json");
  const legacyMcpManifestSource = JSON.stringify(
    {
      id: "legacy-mcp-ui",
      title: "Legacy MCP UI",
      ui: {
        kind: "mcp-app",
        entry: "ui/index.html",
        tools: ["opengrove.app.workspace.read"],
      },
    },
    null,
    2,
  );
  writeFileSync(legacyMcpManifestPath, legacyMcpManifestSource, "utf8");
  const migratedLegacyMcp = migrateMountedAppManifestV1(legacyMcpRoot);
  assert.equal(migratedLegacyMcp.status, "migrated");
  assert.deepEqual(migratedLegacyMcp.migrations, ["ui-surface-v1"]);
  assert.equal(readFileSync(`${legacyMcpManifestPath}.pre-ui-surface-v1.bak`, "utf8"), legacyMcpManifestSource);
  const migratedLegacyMcpManifest = JSON.parse(readFileSync(legacyMcpManifestPath, "utf8")) as {
    ui?: {
      kind?: string;
      surface?: string;
      entry?: string;
      view?: { protocol?: string; entry?: string; tools?: string[] };
    };
  };
  assert.equal(migratedLegacyMcpManifest.ui?.kind, undefined);
  assert.equal(migratedLegacyMcpManifest.ui?.entry, undefined);
  assert.equal(migratedLegacyMcpManifest.ui?.surface, "view");
  assert.equal(migratedLegacyMcpManifest.ui?.view?.protocol, "mcp-app");
  assert.equal(migratedLegacyMcpManifest.ui?.view?.entry, "ui/index.html");
  assert.deepEqual(migratedLegacyMcpManifest.ui?.view?.tools, ["opengrove.app.workspace.read"]);
  assert.equal(migrateMountedAppManifestV1(legacyMcpRoot).status, "current");

  const legacyEmployeeSkillsRoot = join(tempRoot, "legacy-employee-skills");
  mkdirSync(legacyEmployeeSkillsRoot, { recursive: true });
  writeFileSync(
    join(legacyEmployeeSkillsRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "legacy-employee-skills",
      title: "Legacy Employee Skills",
      ui: { surface: "none" },
      employees: [{ id: "operator", name: "Operator", skills: ["operate"] }],
    }),
    "utf8",
  );
  assert.deepEqual(migrateMountedAppManifestV1(legacyEmployeeSkillsRoot).migrations, ["employee-skills-v1"]);
  const migratedEmployeeSkills = JSON.parse(
    readFileSync(join(legacyEmployeeSkillsRoot, "opengrove.app.json"), "utf8"),
  ) as { employees?: Array<{ skills?: string[]; defaultSkillIds?: string[]; availableSkillIds?: string[] }> };
  assert.equal(migratedEmployeeSkills.employees?.[0]?.skills, undefined);
  assert.deepEqual(migratedEmployeeSkills.employees?.[0]?.defaultSkillIds, ["operate"]);
  assert.deepEqual(migratedEmployeeSkills.employees?.[0]?.availableSkillIds, ["operate"]);
  assert.equal(migrateMountedAppManifestV1(legacyEmployeeSkillsRoot).status, "current");

  const legacyWorkbenchRoot = join(tempRoot, "legacy-workbench-ui");
  mkdirSync(join(legacyWorkbenchRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(legacyWorkbenchRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "legacy-workbench-ui",
      title: "Legacy Workbench UI",
      ui: {
        kind: "file-workbench",
        workspace: "workspace",
        entry: "ui/legacy.html",
        tools: ["opengrove.app.workspace.read"],
        csp: { connectDomains: ["https://api.example.test"] },
        permissions: { clipboardWrite: {} },
      },
    }),
    "utf8",
  );
  assert.equal(migrateMountedAppManifestV1(legacyWorkbenchRoot).status, "migrated");
  const migratedLegacyWorkbenchManifest = JSON.parse(
    readFileSync(join(legacyWorkbenchRoot, "opengrove.app.json"), "utf8"),
  ) as {
    ui?: {
      kind?: string;
      surface?: string;
      workspace?: string;
      entry?: string;
      tools?: string[];
      csp?: unknown;
      permissions?: unknown;
    };
  };
  assert.deepEqual(migratedLegacyWorkbenchManifest.ui, {
    workspace: "workspace",
    entry: "ui/legacy.html",
    tools: ["opengrove.app.workspace.read"],
    csp: { connectDomains: ["https://api.example.test"] },
    permissions: { clipboardWrite: {} },
    surface: "file-workbench",
  });

  const legacyWebRoot = join(tempRoot, "legacy-web-ui");
  mkdirSync(legacyWebRoot, { recursive: true });
  writeFileSync(
    join(legacyWebRoot, "opengrove.app.json"),
    JSON.stringify({
      id: "legacy-web-ui",
      title: "Legacy Web UI",
      ui: { kind: "web-app" },
    }),
    "utf8",
  );
  assert.equal(
    migrateMountedAppManifestV1(legacyWebRoot).status,
    "requires-legacy-boundary",
    "the migration must not grant old same-origin web apps a new View security contract",
  );

  const legacyCustomUi = validateAppManifestText(`{
    "id": "legacy-custom-ui",
    "title": "Legacy Custom UI",
    "ui": { "kind": "custom" }
  }`);
  assert.equal(legacyCustomUi.ok, true);
  assert.equal(
    normalizeCompatibleAppUi(legacyCustomUi.manifest).surface,
    "unsupported",
    "legacy custom must stay reserved",
  );
  assert.equal(
    normalizeCompatibleAppUi(legacyCustomUi.manifest).view,
    undefined,
    "legacy custom must never normalize to a runnable View",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
