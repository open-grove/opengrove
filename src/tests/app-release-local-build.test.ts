import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appEnvName } from "../identity.js";
import { readAppReleaseBuildContract } from "../server/app-release-build-contract.js";
import type { AppReleaseBuildBudget } from "../server/app-release-build-budget.js";
import {
  AppReleaseCoordinator,
  AppReleaseCoordinatorError,
  type AppReleaseRegistryAccess,
  type AppReleaseRemoteAccess,
} from "../server/app-release-coordinator.js";
import {
  AppReleaseBuildCommandError,
  prepareMountedAppReleaseBuild,
  runAppReleaseBuildRecipe,
  saveMountedAppReleasePrebuildDraft,
} from "../server/app-release-local-build.js";
import type { MountedAppReleaseDraft } from "../server/app-release.js";
import { extractAppStoreAppArchive } from "../server/app-store.js";
import { createBridgeState, recreateBridgeApp } from "../server/bridge-state.js";
import { LocalAppDraftStore } from "../server/local-app-drafts.js";
import { saveMountedAppDraft } from "../server/mounted-app-draft-service.js";
import { resolveMountedAppTarget } from "../server/mounted-apps.js";

const releaseBuildTest = process.platform === "win32" ? test.skip : test;

test("Windows local release builds fail closed before starting a command", {
  skip: process.platform !== "win32",
}, async () => {
  const appRoot = buildFixture();
  try {
    const contract = readAppReleaseBuildContract(appRoot);
    assert.equal(contract.status, "valid");
    if (contract.status !== "valid") return;
    await assert.rejects(
      () => runAppReleaseBuildRecipe({ appRoot, recipe: contract.recipe, timeoutMs: 10_000 }),
      /app_release_local_build_platform_unsupported/u,
    );
    assert.equal(existsSync(join(appRoot, "ui", "index.html")), false);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build runs from argv in isolation and replaces stale declared outputs", async () => {
  const appRoot = buildFixture();
  const previousSecret = process.env.OPENGROVE_RELEASE_TEST_SECRET;
  process.env.OPENGROVE_RELEASE_TEST_SECRET = "must-not-reach-app-build";
  try {
    writeFileSync(join(appRoot, "ui", "stale.txt"), "stale\n", "utf8");
    const contract = readAppReleaseBuildContract(appRoot);
    assert.equal(contract.status, "valid");
    if (contract.status !== "valid") return;

    const result = await runAppReleaseBuildRecipe({
      appRoot,
      recipe: contract.recipe,
      timeoutMs: 10_000,
    });

    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0]?.exitCode, 0);
    assert.equal(readFileSync(join(appRoot, "ui", "index.html"), "utf8"), "fresh UI\n");
    assert.equal(readFileSync(join(appRoot, "ui", "env.txt"), "utf8"), "absent\n");
    assert.equal(
      readFileSync(join(appRoot, "cache", "side-effect.txt"), "utf8"),
      "not a declared output\n",
      "build side effects may exist only inside the disposable build tree",
    );
    assert.equal(readFileSync(join(appRoot, "unexpected-build-side-effect.txt"), "utf8"), "not declared\n");
    assert.throws(
      () => readFileSync(join(appRoot, "ui", "stale.txt"), "utf8"),
      /ENOENT/,
      "declared outputs must be rebuilt from an empty destination",
    );
  } finally {
    if (previousSecret === undefined) delete process.env.OPENGROVE_RELEASE_TEST_SECRET;
    else process.env.OPENGROVE_RELEASE_TEST_SECRET = previousSecret;
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build resolves a relative executable from the recipe working directory", async () => {
  const appRoot = buildFixture();
  try {
    const binRoot = join(appRoot, "web", "node_modules", ".bin");
    mkdirSync(binRoot, { recursive: true });
    const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
    const executablePath = join(binRoot, executable);
    writeFileSync(
      executablePath,
      process.platform === "win32"
        ? "@echo off\r\nnode -e \"require('node:fs').mkdirSync('../ui',{recursive:true});require('node:fs').writeFileSync('../ui/index.html','recipe cwd\\n')\"\r\n"
        : "#!/usr/bin/env node\nrequire('node:fs').mkdirSync('../ui',{recursive:true});require('node:fs').writeFileSync('../ui/index.html','recipe cwd\\n');\n",
      "utf8",
    );
    if (process.platform !== "win32") chmodSync(executablePath, 0o755);

    await runAppReleaseBuildRecipe({
      appRoot,
      recipe: {
        schemaVersion: 1,
        workingDirectory: "web",
        inputs: ["web", "build.mjs"],
        outputs: ["ui"],
        commands: [[`./node_modules/.bin/${executable}`]],
      },
      timeoutMs: 10_000,
    });

    assert.equal(readFileSync(join(appRoot, "ui", "index.html"), "utf8"), "recipe cwd\n");
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest(
  "release build rejects a symlink anywhere inside a declared output",
  {
    skip: process.platform === "win32" ? "creating symlinks requires extra Windows privileges" : false,
  },
  async () => {
    const appRoot = buildFixture({ symlinkOutput: true });
    try {
      const contract = readAppReleaseBuildContract(appRoot);
      assert.equal(contract.status, "valid");
      if (contract.status !== "valid") return;
      await assert.rejects(
        () =>
          runAppReleaseBuildRecipe({
            appRoot,
            recipe: contract.recipe,
            timeoutMs: 10_000,
          }),
        /app_release_local_build_output_symlink:ui\/linked/u,
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  },
);

releaseBuildTest("release build rejects non-NFC output path spellings", async () => {
  const decomposedName = "e\u0301.txt";
  const appRoot = buildFixture({
    customBuildScript: [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("ui", { recursive: true });',
      `writeFileSync(${JSON.stringify(`ui/${decomposedName}`)}, "decomposed\\n");`,
      "",
    ].join("\n"),
  });
  try {
    await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_path_collision:ui\/e/u);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build protects manifest, workspace, and metadata through case-fold aliases", async () => {
  const appRoot = buildFixture();
  const manifestBefore = readFileSync(join(appRoot, "opengrove.app.json"), "utf8");
  try {
    for (const output of [
      "OpenGrove.app.json",
      "././opengrove.app.json",
      "WorkSpace/generated",
      ".OpenGrove-build.json",
    ]) {
      await assert.rejects(
        () =>
          runAppReleaseBuildRecipe({
            appRoot,
            recipe: {
              schemaVersion: 1,
              workingDirectory: ".",
              inputs: ["web", "build.mjs"],
              outputs: [output],
              commands: [["node", "build.mjs"]],
            },
            timeoutMs: 10_000,
          }),
        /app_release_local_build_output_protected/u,
      );
    }
    for (const output of ["opengrove.app.json.", "workspace "]) {
      await assert.rejects(
        () =>
          runAppReleaseBuildRecipe({
            appRoot,
            recipe: {
              schemaVersion: 1,
              workingDirectory: ".",
              inputs: ["web", "build.mjs"],
              outputs: [output],
              commands: [["node", "build.mjs"]],
            },
            timeoutMs: 10_000,
          }),
        /app_release_local_build_path_invalid/u,
      );
    }
    assert.equal(readFileSync(join(appRoot, "opengrove.app.json"), "utf8"), manifestBefore);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest(
  "release build command failure retains bounded actionable diagnostics outside its message",
  async () => {
    const appRoot = buildFixture({ fails: true });
    try {
      const contract = readAppReleaseBuildContract(appRoot);
      assert.equal(contract.status, "valid");
      if (contract.status !== "valid") return;
      await assert.rejects(
        () =>
          runAppReleaseBuildRecipe({
            appRoot,
            recipe: contract.recipe,
            timeoutMs: 10_000,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppReleaseBuildCommandError);
          assert.equal(error.message, "app_release_local_build_command_failed:1");
          assert.equal(error.diagnostic.commandIndex, 1);
          assert.deepEqual(error.diagnostic.argv, ["node", "build.mjs"]);
          assert.equal(error.diagnostic.argvTruncated, false);
          assert.equal(error.diagnostic.exitCode, 23);
          assert.equal(Buffer.byteLength(error.diagnostic.stdout), 64 * 1024);
          assert.equal(Buffer.byteLength(error.diagnostic.stderr), 64 * 1024);
          assert.match(error.diagnostic.stdout, /^build stdout:/u);
          assert.match(error.diagnostic.stderr, /^build stderr:/u);
          assert.equal(error.diagnostic.stdoutTruncated, true);
          assert.equal(error.diagnostic.stderrTruncated, true);
          assert.doesNotMatch(error.message, /build stdout|build stderr/u);
          return true;
        },
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  },
);

releaseBuildTest("release build command error independently bounds injected diagnostics", () => {
  const error = new AppReleaseBuildCommandError(3, {
    argv: Array.from({ length: 70 }, (_, index) => `arg-${index}`),
    exitCode: 29,
    stdout: `injected stdout:${"o".repeat(70 * 1024)}`,
    stderr: `injected stderr:${"e".repeat(70 * 1024)}`,
    stdoutTruncated: false,
    stderrTruncated: false,
  });

  assert.equal(error.message, "app_release_local_build_command_failed:4");
  assert.equal(error.diagnostic.commandIndex, 4);
  assert.equal(error.diagnostic.argv.length, 64);
  assert.equal(error.diagnostic.argvTruncated, true);
  assert.equal(Buffer.byteLength(error.diagnostic.stdout), 64 * 1024);
  assert.equal(Buffer.byteLength(error.diagnostic.stderr), 64 * 1024);
  assert.equal(error.diagnostic.stdoutTruncated, true);
  assert.equal(error.diagnostic.stderrTruncated, true);
  assert.doesNotMatch(error.message, /injected stdout|injected stderr/u);

  const oversizedArgumentError = new AppReleaseBuildCommandError(0, {
    argv: ["node", "x".repeat(10 * 1024)],
    exitCode: 31,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  assert.ok(oversizedArgumentError.diagnostic.argv.join("").length <= 8 * 1024);
  assert.equal(oversizedArgumentError.diagnostic.argvTruncated, true);
});

releaseBuildTest("release build times out and terminates a long-running command", async () => {
  const markerRoot = mkdtempSync(join(tmpdir(), "opengrove-release-build-timeout-marker-"));
  const descendantMarkerPath = join(markerRoot, "descendant-finished");
  const appRoot = buildFixture({ hangs: true, descendantMarkerPath });
  try {
    const contract = readAppReleaseBuildContract(appRoot);
    assert.equal(contract.status, "valid");
    if (contract.status !== "valid") return;
    await assert.rejects(
      () =>
        runAppReleaseBuildRecipe({
          appRoot,
          recipe: contract.recipe,
          timeoutMs: 200,
        }),
      /app_release_local_build_timed_out/,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    assert.equal(
      existsSync(descendantMarkerPath),
      false,
      "timeout must terminate descendants before they can outlive the release build",
    );
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build cancellation terminates the running process tree", async () => {
  const markerRoot = mkdtempSync(join(tmpdir(), "opengrove-release-build-cancel-marker-"));
  const descendantMarkerPath = join(markerRoot, "descendant-finished");
  const appRoot = buildFixture({ hangs: true, descendantMarkerPath });
  const controller = new AbortController();
  try {
    const contract = readAppReleaseBuildContract(appRoot);
    assert.equal(contract.status, "valid");
    if (contract.status !== "valid") return;
    const build = runAppReleaseBuildRecipe({
      appRoot,
      recipe: contract.recipe,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200).unref?.();
    await assert.rejects(() => build, /app_release_local_build_cancelled/);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    assert.equal(
      existsSync(descendantMarkerPath),
      false,
      "cancellation must terminate descendants before they can outlive the release build",
    );
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("a successful release build terminates background descendants", async () => {
  const markerRoot = mkdtempSync(join(tmpdir(), "opengrove-release-build-success-marker-"));
  const descendantMarkerPath = join(markerRoot, "descendant-finished");
  const appRoot = buildFixture({ backgroundDescendantMarkerPath: descendantMarkerPath });
  try {
    const contract = readAppReleaseBuildContract(appRoot);
    assert.equal(contract.status, "valid");
    if (contract.status !== "valid") return;
    await runAppReleaseBuildRecipe({
      appRoot,
      recipe: contract.recipe,
      timeoutMs: 10_000,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    assert.equal(
      existsSync(descendantMarkerPath),
      false,
      "background descendants must not outlive a successful release build command",
    );
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("a successful release build force-kills a background descendant that ignores SIGTERM", async () => {
  if (process.platform === "win32") return;
  const markerRoot = mkdtempSync(join(tmpdir(), "opengrove-release-build-resistant-descendant-"));
  const descendantMarkerPath = join(markerRoot, "descendant-finished");
  const appRoot = buildFixture({ resistantBackgroundDescendantMarkerPath: descendantMarkerPath });
  try {
    const contract = readAppReleaseBuildContract(appRoot);
    assert.equal(contract.status, "valid");
    if (contract.status !== "valid") return;
    await runAppReleaseBuildRecipe({ appRoot, recipe: contract.recipe, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(existsSync(descendantMarkerPath), false, "SIGTERM-resistant descendants must not outlive success");
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build rejects a POSIX filename containing a literal backslash", async () => {
  if (process.platform === "win32") return;
  const appRoot = buildFixture({
    customBuildScript: [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("ui", { recursive: true });',
      'writeFileSync("ui/a\\\\b.txt", "not portable\\n");',
      "",
    ].join("\n"),
  });
  try {
    await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_path_collision:ui\/a\\b\.txt/u);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build allows a declared output below its working directory", async () => {
  const appRoot = buildFixture();
  try {
    mkdirSync(join(appRoot, "web", "dist"), { recursive: true });
    writeFileSync(
      join(appRoot, "web", "build.mjs"),
      [
        'import { cpSync, mkdirSync } from "node:fs";',
        'mkdirSync("dist", { recursive: true });',
        'cpSync("index.html", "dist/index.html");',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(appRoot, ".opengrove-build.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          workingDirectory: "web",
          inputs: ["web/index.html", "web/build.mjs"],
          outputs: ["web/dist"],
          commands: [["node", "build.mjs"]],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const contract = readAppReleaseBuildContract(appRoot);
    assert.equal(contract.status, "valid");
    if (contract.status !== "valid") return;

    await runAppReleaseBuildRecipe({
      appRoot,
      recipe: contract.recipe,
      timeoutMs: 10_000,
    });

    assert.equal(readFileSync(join(appRoot, "web", "dist", "index.html"), "utf8"), "fresh UI\n");
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build rejects a declared output that contains no packageable file", async () => {
  const appRoot = buildFixture({
    customBuildScript: ['import { mkdirSync } from "node:fs";', 'mkdirSync("ui", { recursive: true });', ""].join("\n"),
  });
  try {
    await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_empty:ui/u);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
});

releaseBuildTest("release build rejects declared outputs beyond deterministic resource budgets", async (t) => {
  await t.test("file count", async () => {
    const appRoot = buildFixture({
      customBuildScript: [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'mkdirSync("ui", { recursive: true });',
        'for (let index = 0; index < 5001; index += 1) writeFileSync(`ui/${index}.txt`, "x");',
        "",
      ].join("\n"),
    });
    try {
      await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_file_count_exceeded/u);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  await t.test("entry count", async () => {
    const appRoot = buildFixture({
      customBuildScript: [
        'import { mkdirSync } from "node:fs";',
        'mkdirSync("ui", { recursive: true });',
        "for (let index = 0; index < 25000; index += 1) mkdirSync(`ui/d-${index}`);",
        "",
      ].join("\n"),
    });
    try {
      await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_entry_count_exceeded/u, 120_000);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  await t.test("depth", async () => {
    const appRoot = buildFixture({
      customBuildScript: [
        'import { mkdirSync } from "node:fs";',
        'mkdirSync(`ui/${Array.from({ length: 64 }, (_, index) => `d-${index}`).join("/")}`, { recursive: true });',
        "",
      ].join("\n"),
    });
    try {
      await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_depth_exceeded/u);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  await t.test("single file bytes", async () => {
    const appRoot = buildFixture({
      customBuildScript: [
        'import { mkdirSync, truncateSync, writeFileSync } from "node:fs";',
        'mkdirSync("ui", { recursive: true });',
        'writeFileSync("ui/large.bin", "");',
        'truncateSync("ui/large.bin", 100 * 1024 * 1024 + 1);',
        "",
      ].join("\n"),
    });
    try {
      await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_file_too_large/u);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  await t.test("total bytes", async () => {
    const appRoot = buildFixture({
      customBuildScript: [
        'import { mkdirSync, truncateSync, writeFileSync } from "node:fs";',
        'mkdirSync("ui", { recursive: true });',
        'for (const name of ["a.bin", "b.bin", "c.bin"]) writeFileSync(`ui/${name}`, "");',
        'truncateSync("ui/a.bin", 90 * 1024 * 1024);',
        'truncateSync("ui/b.bin", 90 * 1024 * 1024);',
        'truncateSync("ui/c.bin", 76 * 1024 * 1024 + 1);',
        "",
      ].join("\n"),
    });
    try {
      await assertBuildFixtureRejected(appRoot, /app_release_local_build_output_too_large/u);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
});

releaseBuildTest("mounted release builds an exact draft without mutating the live App", async () => {
  const mounted = mountedBuildFixture();
  const extractedRoot = mkdtempSync(join(tmpdir(), "opengrove-built-release-draft-"));
  try {
    const prepared = await prepareMountedAppReleaseBuild({
      state: mounted.state,
      target: mounted.target,
      release: mounted.release,
      packageKey: "opengrove.local-build-app",
      draftStore: mounted.draftStore,
      prebuildDraft: mounted.prebuildDraft,
      timeoutMs: 10_000,
    });

    assert.equal(readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"), "stale UI\n");
    assert.equal(existsSync(join(mounted.appRoot, "ui", "env.txt")), false);
    assert.throws(
      () => readFileSync(join(mounted.appRoot, "cache", "side-effect.txt"), "utf8"),
      /ENOENT/,
      "undeclared build side effects must stay inside the disposed build tree",
    );
    assert.notEqual(prepared.draft.contentDigest, mounted.prebuildDraft.contentDigest);
    assert.equal(mounted.draftStore.read(mounted.target.localAppId)?.contentDigest, prepared.draft.contentDigest);
    const archivePath = mounted.draftStore.archivePath(mounted.target.localAppId);
    assert.ok(archivePath);
    const extractedAppRoot = join(extractedRoot, "app");
    extractAppStoreAppArchive({ archivePath, targetRoot: extractedAppRoot });
    assert.equal(readFileSync(join(extractedAppRoot, "ui", "index.html"), "utf8"), "fresh UI\n");
    assert.equal(readFileSync(join(extractedAppRoot, "ui", "env.txt"), "utf8"), "absent\n");
    assert.equal(existsSync(join(extractedAppRoot, "cache", "side-effect.txt")), false);
    assert.equal(
      existsSync(join(extractedAppRoot, "unexpected-build-side-effect.txt")),
      false,
      "undeclared ordinary files created by the build must not enter the frozen draft",
    );
  } finally {
    rmSync(extractedRoot, { recursive: true, force: true });
    mounted.dispose();
  }
});

releaseBuildTest("a failed built-draft save leaves the live App and prebuild draft untouched", async () => {
  class FailingPostbuildDraftStore extends LocalAppDraftStore {
    private saves = 0;

    override save(input: Parameters<LocalAppDraftStore["save"]>[0]) {
      this.saves += 1;
      if (this.saves === 2) throw new Error("postbuild_draft_save_failed");
      return super.save(input);
    }
  }

  const mounted = mountedBuildFixture((root) => new FailingPostbuildDraftStore(root));
  try {
    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: mounted.prebuildDraft,
          timeoutMs: 10_000,
        }),
      /postbuild_draft_save_failed/,
    );
    assert.equal(readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"), "stale UI\n");
    assert.equal(
      mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
      mounted.prebuildDraft.contentDigest,
      "a failed postbuild save must leave the recoverable prebuild draft current",
    );
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("a deadline reached after built-draft commit leaves the live App unchanged", async () => {
  class DeadlineAfterPostbuildDraftStore extends LocalAppDraftStore {
    postbuildCommitted = false;
    private saves = 0;

    override save(input: Parameters<LocalAppDraftStore["save"]>[0]) {
      const saved = super.save(input);
      this.saves += 1;
      if (this.saves === 2) this.postbuildCommitted = true;
      return saved;
    }
  }

  let store: DeadlineAfterPostbuildDraftStore | undefined;
  const mounted = mountedBuildFixture((root) => {
    store = new DeadlineAfterPostbuildDraftStore(root);
    return store;
  });
  const budget: AppReleaseBuildBudget = {
    checkpoint() {
      if (store?.postbuildCommitted) {
        throw new Error("app_release_local_build_timed_out");
      }
    },
    remainingMs() {
      this.checkpoint();
      return 10_000;
    },
  };
  try {
    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: mounted.prebuildDraft,
          budget,
        }),
      /app_release_local_build_timed_out/u,
    );
    assert.equal(readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"), "stale UI\n");
    const committedDraft = mounted.draftStore.read(mounted.target.localAppId);
    assert.ok(committedDraft);
    assert.notEqual(committedDraft.contentDigest, mounted.prebuildDraft.contentDigest);
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("a live edit during the isolated build wins the CAS and prevents built-draft commit", async () => {
  const mounted = mountedBuildFixture(undefined, {
    mutateLiveSourceDuringBuild: true,
  });
  try {
    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: mounted.prebuildDraft,
          timeoutMs: 10_000,
        }),
      /local_app_draft_working_copy_changed/,
    );
    assert.equal(
      readFileSync(join(mounted.appRoot, "web", "index.html"), "utf8"),
      "concurrent edit\n",
      "the concurrent author edit must be preserved",
    );
    assert.equal(
      readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"),
      "stale UI\n",
      "isolated build outputs must not overwrite a working tree that changed",
    );
    assert.equal(
      mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
      mounted.prebuildDraft.contentDigest,
    );
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("a live mode edit during the isolated build wins the mode-aware CAS", async () => {
  const mounted = mountedBuildFixture(undefined, {
    mutateLiveSourceModeDuringBuild: true,
  });
  try {
    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: mounted.prebuildDraft,
          timeoutMs: 10_000,
        }),
      /local_app_draft_working_copy_changed/u,
    );
    assert.equal(
      chmodMode(join(mounted.appRoot, "web", "index.html")),
      0o755,
      "the concurrent author mode edit must be preserved",
    );
    assert.equal(readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"), "stale UI\n");
    assert.equal(
      mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
      mounted.prebuildDraft.contentDigest,
    );
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("a live manifest edit during the isolated build wins the CAS", async () => {
  const mounted = mountedBuildFixture(undefined, { mutateLiveManifestDuringBuild: true });
  try {
    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: mounted.prebuildDraft,
          timeoutMs: 10_000,
        }),
      /local_app_draft_working_copy_changed/u,
    );
    assert.match(readFileSync(join(mounted.appRoot, "opengrove.app.json"), "utf8"), /Concurrent title/u);
    assert.equal(readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"), "stale UI\n");
    assert.equal(
      mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
      mounted.prebuildDraft.contentDigest,
    );
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("a manifest edit after the recoverable prebuild draft is fenced before local build", async () => {
  const mounted = mountedBuildFixture();
  try {
    const prebuild = saveMountedAppReleasePrebuildDraft({
      state: mounted.state,
      target: mounted.target,
      submission: mounted.release,
      draftStore: mounted.draftStore,
    });
    const manifestPath = join(mounted.appRoot, "opengrove.app.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.title = "Edited while the Registry request was pending";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: prebuild.draft,
          installFence: prebuild.installFence,
          workingCopyFence: prebuild.workingCopyFence,
          timeoutMs: 10_000,
        }),
      /local_app_draft_working_copy_changed/u,
    );
    assert.equal(
      mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
      prebuild.draft.contentDigest,
      "the pre-network recoverable draft must remain current",
    );
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("declared outputs excluded from the formal package fail before built-draft commit", async () => {
  const mounted = mountedBuildFixture(undefined, {
    packExclude: ["ui/env.txt"],
  });
  try {
    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: mounted.prebuildDraft,
          timeoutMs: 10_000,
        }),
      /app_release_local_build_output_not_publishable:ui\/env\.txt/u,
    );
    assert.equal(readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"), "stale UI\n");
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("a source edit at the built-draft commit window restores the prebuild draft", async () => {
  class EditingPostbuildDraftStore extends LocalAppDraftStore {
    private saves = 0;

    constructor(
      root: string,
      private readonly appRoot: string,
    ) {
      super(root);
    }

    override save(input: Parameters<LocalAppDraftStore["save"]>[0]) {
      const saved = super.save(input);
      this.saves += 1;
      if (this.saves === 2) {
        writeFileSync(join(this.appRoot, "web", "index.html"), "commit-window edit\n", "utf8");
      }
      return saved;
    }
  }

  const mounted = mountedBuildFixture((root, appRoot) => new EditingPostbuildDraftStore(root, appRoot));
  try {
    await assert.rejects(
      () =>
        prepareMountedAppReleaseBuild({
          state: mounted.state,
          target: mounted.target,
          release: mounted.release,
          packageKey: "opengrove.local-build-app",
          draftStore: mounted.draftStore,
          prebuildDraft: mounted.prebuildDraft,
          timeoutMs: 10_000,
        }),
      /local_app_draft_working_copy_changed/u,
    );
    assert.equal(readFileSync(join(mounted.appRoot, "web", "index.html"), "utf8"), "commit-window edit\n");
    assert.equal(readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"), "stale UI\n");
    assert.equal(
      mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
      mounted.prebuildDraft.contentDigest,
      "the exact recoverable prebuild draft must be restored before failure",
    );
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest("a Store version switch during a release build fences the old program generation", async () => {
  const mounted = mountedStoreGenerationBuildFixture();
  try {
    const build = prepareMountedAppReleaseBuild({
      state: mounted.state,
      target: mounted.target,
      release: mounted.release,
      packageKey: "opengrove.local-build-app",
      draftStore: mounted.draftStore,
      prebuildDraft: mounted.prebuildDraft,
      timeoutMs: 10_000,
    });
    await waitForPath(mounted.buildStartedPath);

    const nextAppRoot = join(mounted.appProgramsRoot, "0.2.0-next", "app");
    cpSync(mounted.appRoot, nextAppRoot, { recursive: true });
    writeFileSync(join(nextAppRoot, "ui", "index.html"), "next generation UI\n", "utf8");
    const mountedApp = mounted.state.settings.mountedApps.find((item) => item.id === mounted.target.localAppId);
    assert.ok(mountedApp);
    mountedApp.path = nextAppRoot;
    writeFileSync(mounted.continueBuildPath, "continue\n", "utf8");

    await assert.rejects(() => build, /app_release_local_build_install_changed/);
    assert.equal(
      readFileSync(join(nextAppRoot, "ui", "index.html"), "utf8"),
      "next generation UI\n",
      "old-generation build output must never enter the newly selected generation",
    );
    assert.equal(
      readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"),
      "stale UI\n",
      "a fenced build must not modify the obsolete generation either",
    );
    assert.equal(
      mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
      mounted.prebuildDraft.contentDigest,
      "a fenced generation must not replace the recoverable prebuild draft",
    );
  } finally {
    mounted.dispose();
  }
});

releaseBuildTest(
  "a Store reinstall generation created before its mount switch still fences release promotion",
  async () => {
    const mounted = mountedStoreGenerationBuildFixture();
    try {
      const build = prepareMountedAppReleaseBuild({
        state: mounted.state,
        target: mounted.target,
        release: mounted.release,
        packageKey: "opengrove.local-build-app",
        draftStore: mounted.draftStore,
        prebuildDraft: mounted.prebuildDraft,
        timeoutMs: 10_000,
      });
      await waitForPath(mounted.buildStartedPath);

      const reinstallAppRoot = join(mounted.appProgramsRoot, "0.1.0-reinstall", "app");
      cpSync(mounted.appRoot, reinstallAppRoot, { recursive: true });
      writeFileSync(mounted.continueBuildPath, "continue\n", "utf8");

      await assert.rejects(() => build, /app_release_local_build_install_changed/);
      assert.equal(
        readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"),
        "stale UI\n",
        "promotion must fail even in the install window before mountedApps points at the new generation",
      );
      assert.equal(
        mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
        mounted.prebuildDraft.contentDigest,
      );
    } finally {
      mounted.dispose();
    }
  },
);

releaseBuildTest(
  "a stale Store target is rejected before the coordinator changes its draft or either generation",
  async () => {
    const mounted = mountedStoreGenerationBuildFixture();
    try {
      writeFileSync(
        join(mounted.appRoot, "build.mjs"),
        [
          'import { cpSync, mkdirSync } from "node:fs";',
          'mkdirSync("ui", { recursive: true });',
          'cpSync("web/index.html", "ui/index.html");',
          "",
        ].join("\n"),
        "utf8",
      );
      const nextAppRoot = join(mounted.appProgramsRoot, "0.2.0-selected", "app");
      cpSync(mounted.appRoot, nextAppRoot, { recursive: true });
      writeFileSync(join(nextAppRoot, "ui", "index.html"), "selected generation UI\n", "utf8");
      const mountedApp = mounted.state.settings.mountedApps.find((item) => item.id === mounted.target.localAppId);
      assert.ok(mountedApp);
      mountedApp.path = nextAppRoot;

      let registryReads = 0;
      let remoteStarts = 0;
      const registry: AppReleaseRegistryAccess = {
        listVersions: async () => {
          registryReads += 1;
          return [];
        },
        importVersion: async () => {
          throw new Error("unexpected registry import");
        },
      };
      const unexpectedRemote = async () => {
        throw new Error("unexpected remote release access");
      };
      const client: AppReleaseRemoteAccess = {
        findByIdempotencyKey: unexpectedRemote,
        findById: unexpectedRemote,
        start: async () => {
          remoteStarts += 1;
          throw new Error("unexpected remote release start");
        },
        retryCandidate: unexpectedRemote,
        retryBuild: unexpectedRemote,
        abandon: unexpectedRemote,
        finalize: unexpectedRemote,
      };
      const coordinator = new AppReleaseCoordinator({
        state: mounted.state,
        target: mounted.target,
        registry,
        draftStore: mounted.draftStore,
        client,
      });

      await assert.rejects(
        () =>
          coordinator.start({
            release: mounted.release,
            applyToCurrentApp: false,
          }),
        (error: unknown) =>
          error instanceof AppReleaseCoordinatorError &&
          error.message === "app_release_local_build_install_changed" &&
          error.status === 409,
      );
      assert.equal(registryReads, 0, "a stale target must fail before the first remote Registry read");
      assert.equal(remoteStarts, 0, "a stale target must never create a remote release");
      assert.equal(
        mounted.draftStore.read(mounted.target.localAppId)?.contentDigest,
        mounted.prebuildDraft.contentDigest,
        "a stale target must not replace the recoverable draft",
      );
      assert.equal(
        readFileSync(join(mounted.appRoot, "ui", "index.html"), "utf8"),
        "stale UI\n",
        "a stale target must not rebuild the obsolete generation",
      );
      assert.equal(
        readFileSync(join(nextAppRoot, "ui", "index.html"), "utf8"),
        "selected generation UI\n",
        "a stale target must not touch the selected generation",
      );
    } finally {
      mounted.dispose();
    }
  },
);

function mountedBuildFixture(
  createStore: (root: string, appRoot: string) => LocalAppDraftStore = (root) => new LocalAppDraftStore(root),
  options: {
    mutateLiveSourceDuringBuild?: boolean;
    mutateLiveSourceModeDuringBuild?: boolean;
    mutateLiveManifestDuringBuild?: boolean;
    packExclude?: string[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "opengrove-mounted-release-local-build-"));
  const appRoot = join(root, "app");
  const sourceFixture = buildFixture();
  cpSync(sourceFixture, appRoot, { recursive: true });
  rmSync(sourceFixture, { recursive: true, force: true });
  writeFileSync(join(appRoot, "ui", "index.html"), "stale UI\n", "utf8");
  writeFileSync(
    join(appRoot, ".opengrove-store-package.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      source: "local-draft",
      appId: "local-build-app",
    })}\n`,
    "utf8",
  );
  if (options.packExclude) {
    const manifestPath = join(appRoot, "opengrove.app.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.store = { packExclude: options.packExclude };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  if (options.mutateLiveSourceDuringBuild) {
    writeFileSync(
      join(appRoot, "build.mjs"),
      [
        'import { cpSync, mkdirSync, writeFileSync } from "node:fs";',
        'mkdirSync("ui", { recursive: true });',
        'cpSync("web/index.html", "ui/index.html");',
        `writeFileSync(${JSON.stringify(join(appRoot, "web", "index.html"))}, "concurrent edit\\n");`,
        "",
      ].join("\n"),
      "utf8",
    );
  } else if (options.mutateLiveSourceModeDuringBuild) {
    writeFileSync(
      join(appRoot, "build.mjs"),
      [
        'import { chmodSync, cpSync, mkdirSync } from "node:fs";',
        'mkdirSync("ui", { recursive: true });',
        'cpSync("web/index.html", "ui/index.html");',
        `chmodSync(${JSON.stringify(join(appRoot, "web", "index.html"))}, 0o755);`,
        "",
      ].join("\n"),
      "utf8",
    );
  } else if (options.mutateLiveManifestDuringBuild) {
    writeFileSync(
      join(appRoot, "build.mjs"),
      [
        'import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'mkdirSync("ui", { recursive: true });',
        'cpSync("web/index.html", "ui/index.html");',
        `const manifestPath = ${JSON.stringify(join(appRoot, "opengrove.app.json"))};`,
        'const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));',
        'manifest.title = "Concurrent title";',
        "writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\\n`);",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  const state = createBridgeState({ statePath: join(root, "state.json") });
  state.settings.mountedApps = [
    {
      id: "local-build-mount",
      path: appRoot,
      enabled: true,
      title: "Local Build App",
    },
  ];
  recreateBridgeApp(state);
  const target = resolveMountedAppTarget(state, "local-build-app");
  assert.ok(target);
  const draftStore = createStore(join(root, "drafts"), appRoot);
  const prebuildDraft = saveMountedAppDraft({ state, target, store: draftStore });
  const release: MountedAppReleaseDraft = {
    identity: {
      appId: target.id,
      source: "mounted",
      appRoot: target.appRoot,
      workspaceRoot: target.workspaceRoot,
      packageKey: "opengrove.local-build-app",
    },
    app: { title: "Published Local Build App", description: "Built locally" },
    version: "0.1.0",
    releaseNotes: "Local build",
    visibility: "restricted",
    employees: [],
    checks: [],
  };
  return {
    appRoot,
    state,
    target,
    draftStore,
    prebuildDraft,
    release,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function chmodMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function mountedStoreGenerationBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), "opengrove-store-release-generation-"));
  const storeRoot = join(root, "store");
  const appsRoot = join(root, "apps");
  const appsRootEnv = appEnvName("APP_STORE_APPS_DIR");
  const previousAppsRoot = process.env[appsRootEnv];
  process.env[appsRootEnv] = appsRoot;
  const stableInstallRoot = join(appsRoot, "local-build-app");
  const installKey = createHash("sha256").update(stableInstallRoot).digest("hex");
  const appProgramsRoot = join(storeRoot, "programs", installKey);
  const appRoot = join(appProgramsRoot, "0.1.0-current", "app");
  const sourceFixture = buildFixture();
  cpSync(sourceFixture, appRoot, { recursive: true });
  rmSync(sourceFixture, { recursive: true, force: true });
  writeFileSync(join(appRoot, "ui", "index.html"), "stale UI\n", "utf8");
  const buildStartedPath = join(root, "build-started");
  const continueBuildPath = join(root, "continue-build");
  writeFileSync(
    join(appRoot, "build.mjs"),
    [
      'import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(buildStartedPath)}, "started\\n");`,
      `while (!existsSync(${JSON.stringify(continueBuildPath)})) { await new Promise((resolve) => setTimeout(resolve, 5)); }`,
      'mkdirSync("ui", { recursive: true });',
      'cpSync("web/index.html", "ui/index.html");',
      "",
    ].join("\n"),
    "utf8",
  );
  const workspaceRoot = join(stableInstallRoot, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const state = createBridgeState({ statePath: join(root, "state.json") });
  state.settings.mountedApps = [
    {
      id: "local-build-mount",
      path: appRoot,
      workspacePath: workspaceRoot,
      enabled: true,
      title: "Local Build App",
    },
  ];
  recreateBridgeApp(state);
  const target = resolveMountedAppTarget(state, "local-build-app");
  assert.ok(target);
  const draftStore = new LocalAppDraftStore(join(root, "drafts"));
  const prebuildDraft = saveMountedAppDraft({ state, target, store: draftStore });
  const release: MountedAppReleaseDraft = {
    identity: {
      appId: target.id,
      source: "mounted",
      appRoot: target.appRoot,
      workspaceRoot: target.workspaceRoot,
      packageKey: "opengrove.local-build-app",
    },
    app: { title: "Published Local Build App", description: "Built locally" },
    version: "0.1.0",
    releaseNotes: "Local build",
    visibility: "restricted",
    employees: [],
    checks: [],
  };
  return {
    root,
    appRoot,
    appProgramsRoot,
    buildStartedPath,
    continueBuildPath,
    state,
    target,
    draftStore,
    prebuildDraft,
    release,
    dispose: () => {
      if (previousAppsRoot === undefined) delete process.env[appsRootEnv];
      else process.env[appsRootEnv] = previousAppsRoot;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildFixture(
  options: {
    symlinkOutput?: boolean;
    hangs?: boolean;
    fails?: boolean;
    customBuildScript?: string;
    descendantMarkerPath?: string;
    backgroundDescendantMarkerPath?: string;
    resistantBackgroundDescendantMarkerPath?: string;
  } = {},
): string {
  const appRoot = mkdtempSync(join(tmpdir(), "opengrove-release-local-build-"));
  mkdirSync(join(appRoot, "web"), { recursive: true });
  mkdirSync(join(appRoot, "ui"), { recursive: true });
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  writeFileSync(join(appRoot, "web", "index.html"), "fresh UI\n", "utf8");
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "local-build-app",
        title: "Local Build App",
        ui: { surface: "view", workspace: "workspace", view: { protocol: "mcp-app", entry: "ui/index.html" } },
        workspace: { path: "workspace" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(appRoot, "build.mjs"),
    options.customBuildScript ??
      (options.hangs
        ? [
            'import { spawn } from "node:child_process";',
            `spawn(process.execPath, ["-e", ${JSON.stringify(
              [
                `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(options.descendantMarkerPath ?? join(appRoot, "descendant-finished"))}, "finished\\n"), 500);`,
                "setTimeout(() => undefined, 2_000);",
              ].join(" "),
            )}], { stdio: "ignore" });`,
            "setInterval(() => undefined, 1_000);",
            "",
          ].join("\n")
        : options.fails
          ? [
              'process.stdout.write(`build stdout:${"o".repeat(70 * 1024)}`);',
              'process.stderr.write(`build stderr:${"e".repeat(70 * 1024)}`);',
              "process.exitCode = 23;",
            ].join("\n") + "\n"
          : options.backgroundDescendantMarkerPath || options.resistantBackgroundDescendantMarkerPath
            ? [
                'import { cpSync, existsSync, mkdirSync } from "node:fs";',
                'import { spawn } from "node:child_process";',
                'mkdirSync("ui", { recursive: true });',
                'cpSync("web/index.html", "ui/index.html");',
                `spawn(process.execPath, ["-e", ${JSON.stringify(
                  [
                    ...(options.resistantBackgroundDescendantMarkerPath ? ['process.on("SIGTERM", () => {});'] : []),
                    ...(options.resistantBackgroundDescendantMarkerPath
                      ? [
                          `require("node:fs").writeFileSync(${JSON.stringify(`${options.resistantBackgroundDescendantMarkerPath}.ready`)}, "ready\\n");`,
                        ]
                      : []),
                    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(options.backgroundDescendantMarkerPath ?? options.resistantBackgroundDescendantMarkerPath)}, "finished\\n"), 300);`,
                    "setInterval(() => undefined, 1_000);",
                  ].join(" "),
                )}], { stdio: "ignore" }).unref();`,
                ...(options.resistantBackgroundDescendantMarkerPath
                  ? [
                      `while (!existsSync(${JSON.stringify(`${options.resistantBackgroundDescendantMarkerPath}.ready`)})) { await new Promise((resolve) => setTimeout(resolve, 5)); }`,
                    ]
                  : []),
                "",
              ].join("\n")
            : [
                'import { cpSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";',
                'mkdirSync("ui", { recursive: true });',
                'cpSync("web/index.html", "ui/index.html");',
                'writeFileSync("ui/env.txt", `${process.env.OPENGROVE_RELEASE_TEST_SECRET ?? "absent"}\\n`);',
                'mkdirSync("cache", { recursive: true });',
                'writeFileSync("cache/side-effect.txt", "not a declared output\\n");',
                'writeFileSync("unexpected-build-side-effect.txt", "not declared\\n");',
                ...(options.symlinkOutput ? ['symlinkSync("../web/index.html", "ui/linked");'] : []),
              ].join("\n") + "\n"),
    "utf8",
  );
  writeFileSync(
    join(appRoot, ".opengrove-build.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workingDirectory: ".",
        inputs: ["web", "build.mjs"],
        outputs: ["ui"],
        commands: [["node", "build.mjs"]],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return appRoot;
}

async function assertBuildFixtureRejected(appRoot: string, expected: RegExp, timeoutMs = 30_000): Promise<void> {
  const contract = readAppReleaseBuildContract(appRoot);
  assert.equal(contract.status, "valid");
  if (contract.status !== "valid") return;
  await assert.rejects(
    () =>
      runAppReleaseBuildRecipe({
        appRoot,
        recipe: contract.recipe,
        timeoutMs,
      }),
    expected,
  );
}
