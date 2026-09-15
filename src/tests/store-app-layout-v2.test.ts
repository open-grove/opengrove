import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  appStoreDataRoot,
  cleanupUnreferencedAppStoreProgramGenerations,
  currentAppStoreProgramsRoot,
  inspectSeparatedStoreManagedAppInstallation,
  trashSeparatedStoreManagedAppInstallation,
} from "../server/app-store.js";
import { appStoreAppDirectoryName, isAppStoreAppDirectoryName } from "../server/app-store-app-id.js";
import { loadBridgeSettings, saveBridgeSettings } from "../server/bridge-settings-store.js";
import { createBridgeState } from "../server/bridge-state.js";
import { inspectStoreAppLayoutV2Diagnostics } from "../server/migrations/store-app-layout-v2-diagnostics.js";
import {
  legacyAppStoreProgramsRoot,
  migrateStoreAppLayoutsV2,
  retireLegacyStoreAppLayoutsV2,
  validateStoreAppLayoutWorkspaceCopiesV2,
} from "../server/migrations/store-app-layout-v2.js";

test("Store layout migration copies, validates, renames, and only then switches paths", () => {
  const fixture = createLegacyFixture("story-seed");
  try {
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(result.changed, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.migratedAppIds, ["story-seed"]);

    const migrated = result.mountedApps[0];
    assert.equal(migrated?.path, join(fixture.roots.programsRoot, "story-seed", "0.2.49-2f902d7c2cf6", "app"));
    assert.equal(migrated?.workspacePath, join(fixture.roots.workspacesRoot, "story-seed", "workspace"));
    assert.equal(readFileSync(join(migrated?.workspacePath ?? "", "story.md"), "utf8"), "user-owned\n");
    assert.equal(existsSync(fixture.legacyProgramRoot), true, "the old program remains before health succeeds");
    assert.equal(
      resolve(realpathSync.native(join(fixture.legacyProgramRoot, "workspace"))),
      resolve(realpathSync.native(fixture.legacyWorkspaceRoot)),
    );
    assert.equal(
      existsSync(fixture.legacyWorkspaceContainer),
      true,
      "the old Workspace remains before health succeeds",
    );

    const retirement = retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.equal(retirement.retained.length, 0);
    assert.equal(existsSync(fixture.legacyProgramRoot), false);
    assert.equal(existsSync(`${dirname(fixture.legacyProgramRoot)}.legacy-v2`), true);
    assert.equal(
      existsSync(fixture.legacyWorkspaceContainer),
      false,
      `legacy Workspace was not retired: ${JSON.stringify(retirement)}`,
    );
    assert.equal(existsSync(`${fixture.legacyWorkspaceContainer}.legacy-v2`), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("direct OpenGrove 0.6.4 Store layout migrates and retires the old App directory", () => {
  const fixture = createDirectLegacyFixture("direct-legacy-app");
  try {
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(result.changed, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.migratedAppIds, ["direct-legacy-app"]);

    const migrated = result.mountedApps[0];
    assert.equal(
      migrated?.path,
      join(fixture.roots.programsRoot, "direct-legacy-app", `0.1.32-${"b".repeat(12)}-legacy-v1`, "app"),
    );
    assert.equal(migrated?.workspacePath, join(fixture.roots.workspacesRoot, "direct-legacy-app", "workspace"));
    assert.equal(readFileSync(join(migrated?.workspacePath ?? "", "story.md"), "utf8"), "user-owned\n");
    assert.equal(readFileSync(join(migrated?.path ?? "", "index.js"), "utf8"), "export default true;\n");
    assert.equal(
      resolve(realpathSync.native(join(migrated?.path ?? "", "workspace"))),
      resolve(realpathSync.native(migrated?.workspacePath ?? "")),
    );
    assert.deepEqual(
      validateStoreAppLayoutWorkspaceCopiesV2({
        appIds: result.migratedAppIds,
        previousMountedApps: [fixture.mount],
        mountedApps: result.mountedApps,
        roots: fixture.roots,
      }),
      [],
    );

    const retirement = retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.deepEqual(retirement.retained, []);
    assert.equal(existsSync(fixture.legacyProgramRoot), false);
    assert.equal(existsSync(`${fixture.legacyProgramRoot}.legacy-v2`), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("OpenGrove 0.6.5 side-by-side mount migrates while retiring a mixed 0.6.4 direct installation", () => {
  const fixture = createLegacyFixture("mixed-generation-app");
  try {
    writeFileSync(join(fixture.legacyProgramRoot, "index.js"), "export const version = 'new';\n", "utf8");
    writeFileSync(
      join(fixture.legacyWorkspaceContainer, "opengrove.app.json"),
      JSON.stringify({
        id: "mixed-generation-app",
        title: "Old direct fixture",
        ui: { surface: "file-workbench", workspace: "workspace" },
      }),
      "utf8",
    );
    writeFileSync(join(fixture.legacyWorkspaceContainer, "index.js"), "export const version = 'old';\n", "utf8");
    writeFileSync(
      join(fixture.legacyWorkspaceContainer, ".opengrove-store-package.json"),
      JSON.stringify({
        schemaVersion: 1,
        source: "registry",
        appId: "mixed-generation-app",
        packageId: "mixed-generation-app",
        version: "0.1.32",
        archiveSha256: "b".repeat(64),
      }),
      "utf8",
    );

    const migration = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(migration.changed, true);
    assert.deepEqual(migration.failures, []);
    assert.deepEqual(migration.migratedAppIds, ["mixed-generation-app"]);

    const migrated = migration.mountedApps[0];
    assert.equal(
      migrated?.path,
      join(fixture.roots.programsRoot, "mixed-generation-app", "0.2.49-2f902d7c2cf6", "app"),
    );
    assert.equal(readFileSync(join(migrated?.path ?? "", "index.js"), "utf8"), "export const version = 'new';\n");
    assert.equal(migrated?.workspacePath, join(fixture.roots.workspacesRoot, "mixed-generation-app", "workspace"));
    assert.equal(readFileSync(join(migrated?.workspacePath ?? "", "story.md"), "utf8"), "user-owned\n");

    const legacyGenerationRoot = dirname(fixture.legacyProgramRoot);
    const retirement = retireLegacyStoreAppLayoutsV2({ mountedApps: migration.mountedApps, roots: fixture.roots });
    assert.deepEqual(retirement.retained, []);
    assert.equal(existsSync(fixture.legacyWorkspaceContainer), false);
    assert.equal(existsSync(`${fixture.legacyWorkspaceContainer}.legacy-v2`), true);
    assert.equal(
      readFileSync(join(`${fixture.legacyWorkspaceContainer}.legacy-v2`, "index.js"), "utf8"),
      "export const version = 'old';\n",
    );
    assert.equal(
      readFileSync(join(`${fixture.legacyWorkspaceContainer}.legacy-v2`, "workspace", "story.md"), "utf8"),
      "user-owned\n",
    );
    assert.equal(existsSync(legacyGenerationRoot), false);
    assert.equal(existsSync(`${legacyGenerationRoot}.legacy-v2`), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("direct legacy migration leaves both Workspace candidates untouched when the saved binding conflicts", () => {
  const fixture = createDirectLegacyFixture("conflicting-workspace-app");
  const separatelyBoundWorkspace = join(fixture.root, "separately-bound-workspace");
  try {
    mkdirSync(separatelyBoundWorkspace, { recursive: true });
    writeFileSync(join(separatelyBoundWorkspace, "story.md"), "separately-bound\n", "utf8");
    const mount = { ...fixture.mount, workspacePath: separatelyBoundWorkspace };

    const migration = migrateStoreAppLayoutsV2({ mountedApps: [mount], roots: fixture.roots });
    assert.equal(migration.changed, false);
    assert.equal(migration.mountedApps[0]?.path, fixture.legacyProgramRoot);
    assert.equal(migration.mountedApps[0]?.workspacePath, separatelyBoundWorkspace);
    assert.equal(readFileSync(join(fixture.legacyWorkspaceRoot, "story.md"), "utf8"), "user-owned\n");
    assert.equal(readFileSync(join(separatelyBoundWorkspace, "story.md"), "utf8"), "separately-bound\n");
    assert.equal(existsSync(join(fixture.roots.programsRoot, "conflicting-workspace-app")), false);
    assert.equal(existsSync(join(fixture.roots.workspacesRoot, "conflicting-workspace-app")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("direct legacy directories without a verified Store marker remain untouched", () => {
  const fixture = createDirectLegacyFixture("manual-direct-app");
  try {
    writeFileSync(
      join(fixture.legacyProgramRoot, ".opengrove-store-package.json"),
      JSON.stringify({ schemaVersion: 1, source: "manual", appId: "manual-direct-app" }),
      "utf8",
    );
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(result.changed, false);
    assert.deepEqual(result.failures, []);
    assert.equal(result.mountedApps[0]?.path, fixture.legacyProgramRoot);
    assert.equal(existsSync(fixture.legacyProgramRoot), true);
    assert.equal(existsSync(join(fixture.roots.programsRoot, "manual-direct-app")), false);
    assert.equal(existsSync(join(fixture.roots.workspacesRoot, "manual-direct-app")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Store layout migration keeps legacy paths authoritative when a Windows-style rename fails", () => {
  const fixture = createLegacyFixture("rename-failure-app");
  try {
    const result = migrateStoreAppLayoutsV2({
      mountedApps: [fixture.mount],
      roots: fixture.roots,
      rename() {
        const error = new Error("EPERM: file is in use") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
    });
    assert.equal(result.changed, false);
    assert.equal(result.mountedApps[0]?.path, fixture.legacyProgramRoot);
    assert.equal(result.mountedApps[0]?.workspacePath, fixture.legacyWorkspaceRoot);
    assert.equal(existsSync(fixture.legacyProgramRoot), true);
    assert.equal(existsSync(fixture.legacyWorkspaceRoot), true);
    assert.equal(existsSync(join(fixture.roots.workspacesRoot, "rename-failure-app")), false);
    assert.equal(
      readdirSync(fixture.roots.workspacesRoot).some((name) => name.startsWith(".migrating-")),
      false,
      "failed staging directories are safe to discard",
    );
    assert.match(result.failures[0]?.reason ?? "", /EPERM/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Store layout migration does not switch the pointer when the second rename fails", () => {
  const fixture = createLegacyFixture("second-rename-failure-app");
  let renameCount = 0;
  try {
    const result = migrateStoreAppLayoutsV2({
      mountedApps: [fixture.mount],
      roots: fixture.roots,
      rename(source, target) {
        renameCount += 1;
        if (renameCount === 2) {
          const error = new Error("EPERM: antivirus holds the program") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        renameSync(source, target);
      },
    });
    assert.equal(result.changed, false);
    assert.equal(result.mountedApps[0]?.path, fixture.legacyProgramRoot);
    assert.equal(result.mountedApps[0]?.workspacePath, fixture.legacyWorkspaceRoot);
    assert.equal(existsSync(fixture.legacyProgramRoot), true);
    assert.equal(existsSync(fixture.legacyWorkspaceRoot), true);
    assert.equal(existsSync(join(fixture.roots.workspacesRoot, "second-rename-failure-app", "workspace")), true);
    assert.equal(existsSync(join(fixture.roots.programsRoot, "second-rename-failure-app")), true);
    assert.equal(
      readdirSync(join(fixture.roots.programsRoot, "second-rename-failure-app")).length,
      0,
      "an unactivated program staging directory is removed without touching the copied Workspace",
    );
    assert.match(result.failures[0]?.reason ?? "", /EPERM/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("final validation keeps the legacy pointer authoritative when the source Workspace changes", () => {
  const fixture = createLegacyFixture("late-workspace-change-app");
  try {
    const migration = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(migration.changed, true);
    writeFileSync(join(fixture.legacyWorkspaceRoot, "story.md"), "changed-after-copy\n", "utf8");
    const failures = validateStoreAppLayoutWorkspaceCopiesV2({
      appIds: migration.migratedAppIds,
      previousMountedApps: [fixture.mount],
      mountedApps: migration.mountedApps,
      roots: fixture.roots,
    });
    assert.equal(failures[0]?.reason, "store_app_layout_copy_validation_failed");
    assert.equal(readFileSync(join(fixture.legacyWorkspaceRoot, "story.md"), "utf8"), "changed-after-copy\n");
    assert.equal(readFileSync(join(migration.mountedApps[0]?.workspacePath ?? "", "story.md"), "utf8"), "user-owned\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Store layout migration preserves external absolute Workspace links without copying their target", () => {
  const fixture = createLegacyFixture("absolute-link-app");
  try {
    const externalRoot = join(fixture.root, "external-content");
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(join(externalRoot, "external.md"), "outside the migration\n");
    symlinkSync(
      externalRoot,
      join(fixture.legacyWorkspaceRoot, "external-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(result.failures, []);
    assert.equal(result.changed, true);
    const copiedLink = join(result.mountedApps[0]!.workspacePath!, "external-link");
    assert.equal(resolve(realpathSync(copiedLink)), resolve(realpathSync(externalRoot)));
    assert.equal(readlinkSync(copiedLink), readlinkSync(join(fixture.legacyWorkspaceRoot, "external-link")));
    retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.equal(readFileSync(join(copiedLink, "external.md"), "utf8"), "outside the migration\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("internal directory links and Windows junctions point into the new Workspace", () => {
  const fixture = createLegacyFixture("directory-links-app");
  try {
    const source = join(fixture.legacyWorkspaceRoot, "documents");
    mkdirSync(source);
    writeFileSync(join(source, "kept.txt"), "kept");
    symlinkSync(
      source,
      join(fixture.legacyWorkspaceRoot, "documents-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(result.failures, []);
    const workspace = result.mountedApps[0]!.workspacePath!;
    assert.equal(realpathSync(join(workspace, "documents-link")), realpathSync(join(workspace, "documents")));
    assert.deepEqual(
      validateStoreAppLayoutWorkspaceCopiesV2({
        appIds: result.migratedAppIds,
        previousMountedApps: [fixture.mount],
        mountedApps: result.mountedApps,
        roots: fixture.roots,
      }),
      [],
    );
    retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.equal(readFileSync(join(workspace, "documents-link", "kept.txt"), "utf8"), "kept");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("links between split Program and Workspace and external relative links survive retirement", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createDirectLegacyFixture("mapped-links-app");
  try {
    const program = fixture.legacyProgramRoot;
    const workspace = fixture.legacyWorkspaceRoot;
    const external = join(fixture.root, "external.txt");
    writeFileSync(external, "external\n");
    symlinkSync(join(workspace, "story.md"), join(program, "story-link"));
    symlinkSync("../index.js", join(workspace, "program-link"));
    symlinkSync(relative(workspace, external), join(workspace, "external-relative"));
    symlinkSync(join(workspace, "later.txt"), join(workspace, "dangling-internal"));
    symlinkSync(join(fixture.root, "missing-external"), join(program, "dangling-external"));
    symlinkSync("cycle-b", join(program, "cycle-a"));
    symlinkSync("cycle-a", join(program, "cycle-b"));
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(result.failures, []);
    const moved = result.mountedApps[0]!;
    assert.equal(readlinkSync(join(moved.path, "story-link")), join(moved.workspacePath!, "story.md"));
    assert.equal(
      resolve(moved.workspacePath!, readlinkSync(join(moved.workspacePath!, "program-link"))),
      join(moved.path, "index.js"),
    );
    assert.equal(
      readlinkSync(join(moved.workspacePath!, "dangling-internal")),
      join(moved.workspacePath!, "later.txt"),
    );
    assert.equal(readlinkSync(join(moved.path, "dangling-external")), join(fixture.root, "missing-external"));
    assert.equal(readlinkSync(join(moved.path, "cycle-a")), "cycle-b");
    assert.deepEqual(
      validateStoreAppLayoutWorkspaceCopiesV2({
        appIds: result.migratedAppIds,
        previousMountedApps: [fixture.mount],
        mountedApps: result.mountedApps,
        roots: fixture.roots,
      }),
      [],
    );
    const retry = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(retry.failures, []);
    assert.deepEqual(retry.mountedApps, result.mountedApps);
    retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.equal(readFileSync(join(moved.path, "story-link"), "utf8"), "user-owned\n");
    assert.equal(readFileSync(join(moved.workspacePath!, "program-link"), "utf8"), "export default true;\n");
    assert.equal(readFileSync(join(moved.workspacePath!, "external-relative"), "utf8"), "external\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a link into an unmapped legacy App is retained at the source before copying", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createDirectLegacyFixture("foreign-link-app");
  try {
    const other = join(fixture.roots.legacyWorkspacesRoot, "other-app", "workspace");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "other.txt"), "keep\n");
    symlinkSync(other, join(fixture.legacyProgramRoot, "other-app-link"));
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(result.changed, false);
    assert.equal(result.failures[0]?.reason, "store_app_layout_unmapped_legacy_link");
    assert.equal(existsSync(fixture.roots.workspacesRoot), false);
    assert.equal(readFileSync(join(other, "other.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unsupported program entries fail preflight before a Workspace copy is created", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createDirectLegacyFixture("preflight-app");
  try {
    execFileSync("mkfifo", [join(fixture.legacyProgramRoot, "pipe")]);
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(result.changed, false);
    assert.equal(result.failures[0]?.reason, "store_app_layout_entry_type_invalid");
    assert.equal(existsSync(fixture.roots.workspacesRoot), false);
    assert.equal(existsSync(fixture.roots.programsRoot), false);
    assert.equal(readFileSync(join(fixture.legacyWorkspaceRoot, "story.md"), "utf8"), "user-owned\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("copied Python environment launchers use the final path after legacy retirement", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createDirectLegacyFixture("python-paths-app");
  try {
    const env = join(fixture.legacyProgramRoot, "skills", "skill with spaces", ".venv");
    mkdirSync(join(env, "bin"), { recursive: true });
    mkdirSync(join(env, "lib"), { recursive: true });
    const interpreter = join(fixture.root, "system-python");
    writeFileSync(interpreter, "#!/bin/sh\nprintf 'python-target-ok\\n'\n", { mode: 0o755 });
    symlinkSync(interpreter, join(env, "bin", "python3.13"));
    symlinkSync("python3.13", join(env, "bin", "python"));
    const config = `home = ${fixture.root}\ninclude-system-site-packages = false\nversion = 3.13.0\ncommand = ${interpreter} -m venv ${env}\n`;
    writeFileSync(join(env, "pyvenv.cfg"), config);
    const wrapper = `#!/bin/sh\n'''exec' "${env}/bin/python" "$0" "$@"\n' '''\n`;
    writeFileSync(join(env, "bin", "pip"), wrapper, { mode: 0o755 });
    writeFileSync(join(env, "bin", "jp.py"), `#!${env}/bin/python\nprint('entry')\n`, { mode: 0o755 });
    writeFileSync(join(env, "bin", "activate"), `VIRTUAL_ENV="${env}"\nexport VIRTUAL_ENV\n`);
    writeFileSync(join(env, "lib", "user-data.txt"), env);
    writeFileSync(join(fixture.legacyWorkspaceRoot, "note.txt"), env);
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(result.failures, []);
    const moved = result.mountedApps[0]!;
    const targetEnv = join(moved.path, "skills", "skill with spaces", ".venv");
    assert.equal(
      readFileSync(join(targetEnv, "bin", "activate"), "utf8"),
      `VIRTUAL_ENV="${targetEnv}"\nexport VIRTUAL_ENV\n`,
    );
    assert.equal(
      readFileSync(join(targetEnv, "pyvenv.cfg"), "utf8"),
      `home = ${fixture.root}\ninclude-system-site-packages = false\nversion = 3.13.0\ncommand = ${interpreter} -m venv ${targetEnv}\n`,
    );
    assert.equal(readFileSync(join(env, "bin", "pip"), "utf8"), wrapper, "source launcher stays untouched");
    assert.equal(readFileSync(join(targetEnv, "lib", "user-data.txt"), "utf8"), env);
    assert.equal(readFileSync(join(moved.workspacePath!, "note.txt"), "utf8"), env);
    assert.deepEqual(migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots }).failures, []);
    retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.equal(existsSync(env), false);
    assert.equal(execFileSync(join(targetEnv, "bin", "pip"), { encoding: "utf8" }), "python-target-ok\n");
    assert.equal(execFileSync(join(targetEnv, "bin", "jp.py"), { encoding: "utf8" }), "python-target-ok\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("bundled Python configuration and base-interpreter launchers survive legacy retirement", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createDirectLegacyFixture("bundled-python-app");
  try {
    const env = join(fixture.legacyProgramRoot, "skill with spaces", ".venv");
    const home = join(fixture.legacyProgramRoot, "runtime", "python", "bin");
    const interpreter = join(home, "python3");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(env, "bin"), { recursive: true });
    writeFileSync(interpreter, "#!/bin/sh\nprintf 'bundled-python-ok\\n'\n", { mode: 0o755 });
    symlinkSync(interpreter, join(env, "bin", "python3"));
    const config = `home = ${home}\ninclude-system-site-packages = false\nexecutable = ${interpreter}\ncommand = ${interpreter} -m venv ${env}\n`;
    writeFileSync(join(env, "pyvenv.cfg"), config);
    const launcher = `#!${interpreter} -I\nprint('entry')\n`;
    writeFileSync(join(env, "bin", "entry"), launcher, { mode: 0o755 });
    writeFileSync(join(env, "bin", "wrapped"), `#!/bin/sh\n'''exec' "${interpreter}" "$0" "$@"\n' '''\n`, {
      mode: 0o755,
    });
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(result.failures, []);
    const targetEnv = join(result.mountedApps[0]!.path, "skill with spaces", ".venv");
    const targetHome = join(result.mountedApps[0]!.path, "runtime", "python", "bin");
    const targetInterpreter = join(targetHome, "python3");
    assert.equal(
      readFileSync(join(targetEnv, "pyvenv.cfg"), "utf8"),
      `home = ${targetHome}\ninclude-system-site-packages = false\nexecutable = ${targetInterpreter}\ncommand = ${targetInterpreter} -m venv ${targetEnv}\n`,
    );
    assert.equal(readFileSync(join(env, "pyvenv.cfg"), "utf8"), config);
    assert.equal(readFileSync(join(env, "bin", "entry"), "utf8"), launcher);
    assert.deepEqual(migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots }).failures, []);
    assert.deepEqual(
      validateStoreAppLayoutWorkspaceCopiesV2({
        appIds: result.migratedAppIds,
        previousMountedApps: [fixture.mount],
        mountedApps: result.mountedApps,
        roots: fixture.roots,
      }),
      [],
    );
    retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(targetHome), true);
    assert.equal(execFileSync(join(targetEnv, "bin", "entry"), { encoding: "utf8" }), "bundled-python-ok\n");
    assert.equal(execFileSync(join(targetEnv, "bin", "wrapped"), { encoding: "utf8" }), "bundled-python-ok\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const field of ["home", "executable", "command", "shebang", "wrapper"] as const) {
  test(`unmapped legacy Python ${field} fails before copying either tree`, () => {
    const fixture = createDirectLegacyFixture(`unmapped-python-${field}`);
    try {
      const env = join(fixture.legacyProgramRoot, ".venv");
      const foreignHome = join(fixture.roots.legacyWorkspacesRoot, "another-app", "runtime", "bin");
      const foreignPython = join(foreignHome, "python3");
      mkdirSync(join(env, "bin"), { recursive: true });
      let config = `home = ${fixture.root}\ninclude-system-site-packages = false\n`;
      if (field === "home") config = `home = ${foreignHome}\ninclude-system-site-packages = false\n`;
      if (field === "executable") config += `executable = ${foreignPython}\n`;
      if (field === "command") config += `command = "${foreignPython}" -m venv ${env}\n`;
      writeFileSync(join(env, "pyvenv.cfg"), config);
      if (field === "shebang") writeFileSync(join(env, "bin", "entry"), `#!${foreignPython}\nprint('entry')\n`);
      if (field === "wrapper")
        writeFileSync(join(env, "bin", "entry"), `#!/bin/sh\n'''exec' "${foreignPython}" "$0" "$@"\n' '''\n`);
      const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
      assert.equal(result.failures[0]?.reason, "store_app_layout_unmapped_legacy_path");
      assert.equal(result.changed, false);
      assert.equal(existsSync(fixture.roots.programsRoot), false);
      assert.equal(existsSync(fixture.roots.workspacesRoot), false);
      assert.equal(readFileSync(join(env, "pyvenv.cfg"), "utf8"), config);
      assert.equal(existsSync(fixture.legacyWorkspaceRoot), true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("a real Python with a bundled home starts after both its base and venv move", {
  skip: process.platform === "win32",
}, (context) => {
  if (spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 is unavailable");
    return;
  }
  const fixture = createDirectLegacyFixture("real-bundled-python-app");
  try {
    const details = execFileSync(
      "python3",
      [
        "-c",
        "import sys, sysconfig; print(sys.executable); print(sysconfig.get_path('stdlib')); print(sysconfig.get_config_var('LDVERSION') or sysconfig.get_python_version())",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const env = join(fixture.legacyProgramRoot, "skill with spaces", ".venv");
    const runtime = join(fixture.legacyProgramRoot, "runtime", "python");
    mkdirSync(join(runtime, "bin"), { recursive: true });
    mkdirSync(join(runtime, "lib"), { recursive: true });
    // Reuse the host stdlib instead of copying it. Framework builds on macOS
    // also retain their host framework, so this is not a standalone distribution.
    copyFileSync(details[0]!, join(runtime, "bin", "python3"));
    symlinkSync(details[1]!, join(runtime, "lib", `python${details[2]!}`), "dir");
    execFileSync(join(runtime, "bin", "python3"), ["-m", "venv", "--without-pip", env]);
    const configFile = join(env, "pyvenv.cfg");
    writeFileSync(
      configFile,
      readFileSync(configFile, "utf8").replace(/^home = .+$/m, `home = ${realpathSync(join(runtime, "bin"))}`),
    );
    writeFileSync(join(env, "bin", "show-prefix"), `#!${env}/bin/python\nimport sys\nprint(sys.prefix)\n`, {
      mode: 0o755,
    });
    writeFileSync(join(env, "bin", "show-base"), `#!${runtime}/bin/python3\nimport sys\nprint(sys.executable)\n`, {
      mode: 0o755,
    });
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(result.failures, []);
    const targetEnv = join(result.mountedApps[0]!.path, "skill with spaces", ".venv");
    const targetRuntime = join(result.mountedApps[0]!.path, "runtime", "python");
    const targetHome = readFileSync(join(targetEnv, "pyvenv.cfg"), "utf8").match(/^home = (.+)$/m)?.[1];
    assert.equal(targetHome, join(targetRuntime, "bin"));
    retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    assert.equal(existsSync(runtime), false);
    assert.equal(existsSync(targetHome!), true);
    const actual = execFileSync(join(targetEnv, "bin", "show-prefix"), { encoding: "utf8" }).trim();
    assert.equal(realpathSync(actual), realpathSync(targetEnv));
    const base = execFileSync(join(targetEnv, "bin", "show-base"), { encoding: "utf8" }).trim();
    assert.equal(realpathSync(base), realpathSync(join(targetRuntime, "bin", "python3")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a real Python venv still runs from a path with spaces after migration and retirement", {
  skip: process.platform === "win32",
}, (context) => {
  if (spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 is unavailable");
    return;
  }
  const fixture = createDirectLegacyFixture("real-python-app");
  try {
    const env = join(fixture.legacyProgramRoot, "skill with spaces", ".venv");
    execFileSync("python3", ["-m", "venv", "--without-pip", env]);
    writeFileSync(join(env, "bin", "show-prefix"), `#!${env}/bin/python\nimport sys\nprint(sys.prefix)\n`, {
      mode: 0o755,
    });
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.deepEqual(result.failures, []);
    const targetEnv = join(result.mountedApps[0]!.path, "skill with spaces", ".venv");
    retireLegacyStoreAppLayoutsV2({ mountedApps: result.mountedApps, roots: fixture.roots });
    const actual = execFileSync(join(targetEnv, "bin", "show-prefix"), { encoding: "utf8" }).trim();
    assert.equal(realpathSync(actual), realpathSync(targetEnv));
    assert.equal(existsSync(env), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy retirement keeps attribution evidence when Windows defers the Workspace rename", () => {
  const fixture = createLegacyFixture("retirement-retry-app");
  try {
    const migration = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    const deferred = retireLegacyStoreAppLayoutsV2({
      mountedApps: migration.mountedApps,
      roots: fixture.roots,
      rename() {
        const error = new Error("EPERM: Workspace is open") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
    });
    assert.equal(deferred.retained.length, 1);
    assert.equal(existsSync(fixture.legacyWorkspaceContainer), true);
    assert.equal(existsSync(fixture.legacyProgramRoot), true, "the verified binding must remain for the retry");

    const retried = retireLegacyStoreAppLayoutsV2({ mountedApps: migration.mountedApps, roots: fixture.roots });
    assert.equal(retried.retained.length, 0);
    assert.equal(existsSync(`${fixture.legacyWorkspaceContainer}.legacy-v2`), true);
    assert.equal(existsSync(`${dirname(fixture.legacyProgramRoot)}.legacy-v2`), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Store layout migration defers an unreadable legacy mount instead of throwing", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createLegacyFixture("unreadable-migration-app");
  const legacyBucketRoot = dirname(dirname(fixture.legacyProgramRoot));
  try {
    chmodSync(legacyBucketRoot, 0o000);
    const result = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(result.changed, false);
    assert.equal(result.mountedApps[0]?.path, fixture.legacyProgramRoot);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.reason ?? "", /EACCES|EPERM/);
  } finally {
    chmodSync(legacyBucketRoot, 0o700);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy retirement reports an unreadable Programs root instead of throwing", {
  skip: process.platform === "win32",
}, () => {
  const fixture = createLegacyFixture("unreadable-retirement-app");
  try {
    const migration = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots: fixture.roots });
    assert.equal(migration.changed, true);
    chmodSync(fixture.roots.legacyProgramsRoot, 0o000);
    const result = retireLegacyStoreAppLayoutsV2({ mountedApps: migration.mountedApps, roots: fixture.roots });
    chmodSync(fixture.roots.legacyProgramsRoot, 0o700);
    assert.equal(result.renamed.length, 0);
    assert.equal(result.retained.length, 1);
    assert.match(result.retained[0]?.reason ?? "", /EACCES|EPERM/);
    assert.equal(existsSync(fixture.legacyWorkspaceRoot), true);
    assert.equal(existsSync(fixture.legacyProgramRoot), true);
  } finally {
    chmodSync(fixture.roots.legacyProgramsRoot, 0o700);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("verified legacy Store programs remain manageable while the new Programs root is active", () => {
  const fixture = createLegacyFixture("legacy-program-root-app");
  const storeRoot = dirname(fixture.roots.legacyProgramsRoot);
  const previousEnv = captureEnv(["OPENGROVE_PROGRAMS_DIR", "OPENGROVE_LEGACY_APPS_DIR"]);
  try {
    process.env.OPENGROVE_PROGRAMS_DIR = fixture.roots.programsRoot;
    process.env.OPENGROVE_LEGACY_APPS_DIR = fixture.roots.legacyWorkspacesRoot;
    assert.equal(
      inspectSeparatedStoreManagedAppInstallation({
        appId: fixture.mount.id,
        mountedApp: fixture.mount,
        storeRoot,
      }),
      "verified",
    );
  } finally {
    restoreEnv(previousEnv);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy Store uninstall keeps the Workspace recoverable while the new roots are active", () => {
  const fixture = createLegacyFixture("legacy-uninstall-app");
  const storeRoot = dirname(fixture.roots.legacyProgramsRoot);
  const trashRoot = join(fixture.root, "trash");
  const previousEnv = captureEnv([
    "OPENGROVE_PROGRAMS_DIR",
    "OPENGROVE_WORKSPACES_DIR",
    "OPENGROVE_LEGACY_APPS_DIR",
    "OPENGROVE_TRASH_DIR",
  ]);
  try {
    process.env.OPENGROVE_PROGRAMS_DIR = fixture.roots.programsRoot;
    process.env.OPENGROVE_WORKSPACES_DIR = fixture.roots.workspacesRoot;
    process.env.OPENGROVE_LEGACY_APPS_DIR = fixture.roots.legacyWorkspacesRoot;
    process.env.OPENGROVE_TRASH_DIR = trashRoot;
    const trashedPath = trashSeparatedStoreManagedAppInstallation({
      appId: fixture.mount.id,
      mountedApp: fixture.mount,
      storeRoot,
    });
    assert.ok(trashedPath);
    assert.equal(readFileSync(join(trashedPath, "workspace", "story.md"), "utf8"), "user-owned\n");
    assert.equal(existsSync(fixture.legacyWorkspaceContainer), false);
    assert.equal(existsSync(dirname(fixture.legacyProgramRoot)), false);
  } finally {
    restoreEnv(previousEnv);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("deferred cleanup scans verified legacy Programs generations", () => {
  const fixture = createLegacyFixture("legacy-cleanup-app");
  const storeRoot = dirname(fixture.roots.legacyProgramsRoot);
  const orphanProgramRoot = join(fixture.roots.legacyProgramsRoot, "b".repeat(64), "0.1.0-orphan", "app");
  const orphanGenerationRoot = dirname(orphanProgramRoot);
  const previousEnv = captureEnv(["OPENGROVE_PROGRAMS_DIR"]);
  try {
    process.env.OPENGROVE_PROGRAMS_DIR = fixture.roots.programsRoot;
    mkdirSync(orphanProgramRoot, { recursive: true });
    writeFileSync(join(orphanProgramRoot, "opengrove.app.json"), JSON.stringify({ id: "orphan-app" }), "utf8");
    writeFileSync(
      join(orphanGenerationRoot, ".opengrove-cleanup-pending"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "program-generation-cleanup",
        appRoot: resolve(orphanProgramRoot),
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const result = cleanupUnreferencedAppStoreProgramGenerations(storeRoot, { mountedApps: [fixture.mount] });
    assert.deepEqual(result.removed, [resolve(orphanProgramRoot)]);
    assert.equal(existsSync(orphanGenerationRoot), false);
    assert.equal(existsSync(fixture.legacyProgramRoot), true);
  } finally {
    restoreEnv(previousEnv);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Store program buckets stay readable and Windows-safe", () => {
  assert.equal(appStoreAppDirectoryName("story-seed"), "story-seed");
  assert.equal(appStoreAppDirectoryName("publisher:story-seed"), "publisher%3Astory-seed");
  assert.equal(appStoreAppDirectoryName("con"), "%00con");
  assert.equal(appStoreAppDirectoryName("story-seed."), "story-seed%2E");
  assert.equal(isAppStoreAppDirectoryName("publisher%3Astory-seed"), true);
  assert.equal(isAppStoreAppDirectoryName("%00con"), true);
  assert.equal(isAppStoreAppDirectoryName("unknown%bucket"), false);
});

test("Store layout diagnostics expose versions, bindings, and migration remnants without file contents", () => {
  const fixture = createLegacyFixture("diagnostic-story-seed");
  try {
    const stagingRoot = join(fixture.roots.programsRoot, "diagnostic-story-seed", ".migrating-generation-test");
    const retiredRoot = `${fixture.legacyWorkspaceContainer}.legacy-v2`;
    mkdirSync(stagingRoot, { recursive: true });
    mkdirSync(retiredRoot, { recursive: true });
    const diagnostics = inspectStoreAppLayoutV2Diagnostics({
      roots: fixture.roots,
      mountedApps: [fixture.mount],
    });
    const serialized = JSON.stringify(diagnostics);
    assert.match(serialized, /"id":"store-app-layout-v2"/);
    assert.match(serialized, /"introducedIn":"0\.6\.6"/);
    assert.match(serialized, /"location":"legacy"/);
    assert.match(serialized, /\.migrating-generation-test/);
    assert.match(serialized, /\.legacy-v2/);
    assert.match(serialized, /store_app_layout_post_activation_state_persist_deferred/);
    assert.doesNotMatch(serialized, /user-owned/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Store layout diagnostics classify a direct OpenGrove 0.6.4 program as legacy", () => {
  const fixture = createDirectLegacyFixture("diagnostic-direct-app");
  try {
    const diagnostics = inspectStoreAppLayoutV2Diagnostics({
      roots: fixture.roots,
      mountedApps: [fixture.mount],
    });
    assert.deepEqual(diagnostics.mountedApps, [
      {
        appId: "diagnostic-direct-app",
        enabled: true,
        program: {
          location: "legacy",
          state: { path: fixture.legacyProgramRoot, kind: "directory" },
        },
        workspace: { location: "unset" },
      },
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the default Programs root stays distinct from the legacy Store root without a desktop override", () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-store-roots-"));
  const previousEnv = captureEnv(["OPENGROVE_DATA_DIR", "OPENGROVE_PROGRAMS_DIR"]);
  try {
    process.env.OPENGROVE_DATA_DIR = join(root, "state");
    delete process.env.OPENGROVE_PROGRAMS_DIR;
    const storeRoot = join(root, "state", "app-store");
    assert.notEqual(currentAppStoreProgramsRoot(storeRoot), legacyAppStoreProgramsRoot(storeRoot));
  } finally {
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration leaves legacy data authoritative when configured roots collapse", () => {
  const fixture = createLegacyFixture("collapsed-root-app");
  try {
    const roots = {
      ...fixture.roots,
      programsRoot: fixture.roots.legacyProgramsRoot,
    };
    const migration = migrateStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots });
    assert.equal(migration.changed, false);
    assert.equal(migration.mountedApps[0]?.path, fixture.legacyProgramRoot);
    assert.equal(migration.failures[0]?.reason, "store_app_layout_roots_not_separated");
    const retirement = retireLegacyStoreAppLayoutsV2({ mountedApps: [fixture.mount], roots });
    assert.deepEqual(retirement.renamed, []);
    assert.equal(retirement.retained[0]?.reason, "store_app_layout_roots_not_separated");
    assert.equal(existsSync(fixture.legacyWorkspaceRoot), true);
    assert.equal(existsSync(fixture.legacyProgramRoot), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Bridge startup persists the new pointer before retiring legacy paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-store-layout-startup-"));
  const statePath = join(root, "state", "local-state.sqlite");
  const legacyWorkspacesRoot = join(root, "legacy-apps");
  const programsRoot = join(root, "local-data", "programs");
  const workspacesRoot = join(root, "user", "OpenGrove", "workspaces");
  const previousEnv = captureEnv([
    "OPENGROVE_PROGRAMS_DIR",
    "OPENGROVE_WORKSPACES_DIR",
    "OPENGROVE_LEGACY_APPS_DIR",
    "OPENGROVE_APP_STORE_APPS_DIR",
    "OPENGROVE_BRIDGE_SETTINGS_PATH",
  ]);
  let seedState: ReturnType<typeof createBridgeState> | undefined;
  let migratedState: ReturnType<typeof createBridgeState> | undefined;
  try {
    delete process.env.OPENGROVE_PROGRAMS_DIR;
    delete process.env.OPENGROVE_WORKSPACES_DIR;
    delete process.env.OPENGROVE_BRIDGE_SETTINGS_PATH;
    process.env.OPENGROVE_LEGACY_APPS_DIR = legacyWorkspacesRoot;
    process.env.OPENGROVE_APP_STORE_APPS_DIR = legacyWorkspacesRoot;
    seedState = createBridgeState({ statePath });
    const fixture = writeLegacyFixture(root, {
      appId: "startup-story-seed",
      legacyProgramsRoot: join(appStoreDataRoot(seedState), "programs"),
      legacyWorkspacesRoot,
      programsRoot,
      workspacesRoot,
    });
    seedState.settings.mountedApps = [fixture.mount];
    const migrationPrecondition = migrateStoreAppLayoutsV2({
      mountedApps: [fixture.mount],
      roots: fixture.roots,
      rename() {
        throw new Error("precondition-only");
      },
    });
    assert.equal(migrationPrecondition.failures[0]?.reason, "precondition-only");
    saveBridgeSettings(seedState);
    assert.equal(loadBridgeSettings(seedState).providerSetupVersion, 4);
    await seedState.store.close?.();
    seedState = undefined;

    process.env.OPENGROVE_PROGRAMS_DIR = programsRoot;
    process.env.OPENGROVE_WORKSPACES_DIR = workspacesRoot;
    process.env.OPENGROVE_APP_STORE_APPS_DIR = workspacesRoot;
    const startupActivities: string[] = [];
    migratedState = createBridgeState({
      statePath,
      onStartupActivity(activity) {
        startupActivities.push(activity);
        throw new Error("startup activity observer must be fail-open");
      },
    });
    assert.deepEqual(startupActivities, ["migrating_local_data"]);
    const mount = migratedState.settings.mountedApps.find((item) => item.id === "startup-story-seed");
    assert.ok(mount);
    assert.equal(mount.path, join(programsRoot, "startup-story-seed", "0.2.49-2f902d7c2cf6", "app"));
    assert.equal(mount.workspacePath, join(workspacesRoot, "startup-story-seed", "workspace"));
    assert.equal(loadBridgeSettings(migratedState).mountedApps[0]?.path, mount.path);
    assert.equal(existsSync(`${fixture.legacyWorkspaceContainer}.legacy-v2`), true);
    assert.equal(existsSync(`${dirname(fixture.legacyProgramRoot)}.legacy-v2`), true);
  } finally {
    await seedState?.store.close?.();
    await migratedState?.store.close?.();
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge startup migrates a direct OpenGrove 0.6.4 Store mount", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengrove-store-layout-direct-startup-"));
  const statePath = join(root, "state", "local-state.sqlite");
  const legacyWorkspacesRoot = join(root, "legacy-apps");
  const programsRoot = join(root, "local-data", "programs");
  const workspacesRoot = join(root, "user", "OpenGrove", "workspaces");
  const previousEnv = captureEnv([
    "OPENGROVE_PROGRAMS_DIR",
    "OPENGROVE_WORKSPACES_DIR",
    "OPENGROVE_LEGACY_APPS_DIR",
    "OPENGROVE_APP_STORE_APPS_DIR",
    "OPENGROVE_BRIDGE_SETTINGS_PATH",
  ]);
  let seedState: ReturnType<typeof createBridgeState> | undefined;
  let migratedState: ReturnType<typeof createBridgeState> | undefined;
  try {
    delete process.env.OPENGROVE_PROGRAMS_DIR;
    delete process.env.OPENGROVE_WORKSPACES_DIR;
    delete process.env.OPENGROVE_BRIDGE_SETTINGS_PATH;
    process.env.OPENGROVE_LEGACY_APPS_DIR = legacyWorkspacesRoot;
    process.env.OPENGROVE_APP_STORE_APPS_DIR = legacyWorkspacesRoot;
    seedState = createBridgeState({ statePath });
    const fixture = writeDirectLegacyFixture(root, {
      appId: "startup-direct-app",
      legacyProgramsRoot: join(appStoreDataRoot(seedState), "programs"),
      legacyWorkspacesRoot,
      programsRoot,
      workspacesRoot,
    });
    seedState.settings.mountedApps = [fixture.mount];
    saveBridgeSettings(seedState);
    await seedState.store.close?.();
    seedState = undefined;

    process.env.OPENGROVE_PROGRAMS_DIR = programsRoot;
    process.env.OPENGROVE_WORKSPACES_DIR = workspacesRoot;
    process.env.OPENGROVE_APP_STORE_APPS_DIR = workspacesRoot;
    migratedState = createBridgeState({ statePath });
    const mount = migratedState.settings.mountedApps.find((item) => item.id === "startup-direct-app");
    assert.ok(mount);
    assert.equal(mount.path, join(programsRoot, "startup-direct-app", `0.1.32-${"b".repeat(12)}-legacy-v1`, "app"));
    assert.equal(mount.workspacePath, join(workspacesRoot, "startup-direct-app", "workspace"));
    assert.equal(loadBridgeSettings(migratedState).mountedApps[0]?.path, mount.path);
    assert.equal(existsSync(fixture.legacyProgramRoot), false);
    assert.equal(existsSync(`${fixture.legacyProgramRoot}.legacy-v2`), true);
  } finally {
    await seedState?.store.close?.();
    await migratedState?.store.close?.();
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

function createLegacyFixture(appId: string) {
  const root = mkdtempSync(join(tmpdir(), "opengrove-store-layout-v2-"));
  const roots = {
    legacyProgramsRoot: join(root, "state", "app-store", "programs"),
    legacyWorkspacesRoot: join(root, "apps"),
    programsRoot: join(root, "local-data", "programs"),
    workspacesRoot: join(root, "user", "OpenGrove", "workspaces"),
  };
  return writeLegacyFixture(root, { appId, ...roots });
}

function createDirectLegacyFixture(appId: string) {
  const root = mkdtempSync(join(tmpdir(), "opengrove-store-layout-v2-direct-"));
  const roots = {
    legacyProgramsRoot: join(root, "state", "app-store", "programs"),
    legacyWorkspacesRoot: join(root, "apps"),
    programsRoot: join(root, "local-data", "programs"),
    workspacesRoot: join(root, "user", "OpenGrove", "workspaces"),
  };
  return writeDirectLegacyFixture(root, { appId, ...roots });
}

function writeDirectLegacyFixture(
  root: string,
  input: {
    appId: string;
    legacyProgramsRoot: string;
    legacyWorkspacesRoot: string;
    programsRoot: string;
    workspacesRoot: string;
  },
) {
  const { appId, ...roots } = input;
  const legacyProgramRoot = join(roots.legacyWorkspacesRoot, appId);
  const legacyWorkspaceRoot = join(legacyProgramRoot, "workspace");
  mkdirSync(legacyWorkspaceRoot, { recursive: true });
  writeFileSync(join(legacyWorkspaceRoot, "story.md"), "user-owned\n", "utf8");
  writeFileSync(
    join(legacyProgramRoot, "opengrove.app.json"),
    JSON.stringify({ id: appId, title: "Fixture", ui: { surface: "file-workbench", workspace: "workspace" } }),
    "utf8",
  );
  writeFileSync(join(legacyProgramRoot, "index.js"), "export default true;\n", "utf8");
  writeFileSync(
    join(legacyProgramRoot, ".opengrove-store-package.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: "registry",
      appId,
      packageId: appId,
      version: "0.1.32",
      archiveSha256: "b".repeat(64),
    }),
    "utf8",
  );
  return {
    root,
    roots,
    legacyProgramRoot: resolve(legacyProgramRoot),
    legacyWorkspaceRoot: resolve(legacyWorkspaceRoot),
    mount: {
      id: appId,
      path: resolve(legacyProgramRoot),
      enabled: true,
    },
  };
}

function writeLegacyFixture(
  root: string,
  input: {
    appId: string;
    legacyProgramsRoot: string;
    legacyWorkspacesRoot: string;
    programsRoot: string;
    workspacesRoot: string;
  },
) {
  const { appId, ...roots } = input;
  const legacyProgramRoot = join(roots.legacyProgramsRoot, "a".repeat(64), "0.2.49-2f902d7c2cf6", "app");
  const legacyWorkspaceContainer = join(roots.legacyWorkspacesRoot, appId);
  const legacyWorkspaceRoot = join(legacyWorkspaceContainer, "workspace");
  mkdirSync(legacyProgramRoot, { recursive: true });
  mkdirSync(legacyWorkspaceRoot, { recursive: true });
  writeFileSync(join(legacyWorkspaceRoot, "story.md"), "user-owned\n", "utf8");
  writeFileSync(
    join(legacyProgramRoot, "opengrove.app.json"),
    JSON.stringify({ id: appId, title: "Fixture", ui: { surface: "file-workbench", workspace: "workspace" } }),
    "utf8",
  );
  writeFileSync(join(legacyProgramRoot, "index.js"), "export default true;\n", "utf8");
  writeFileSync(
    join(legacyProgramRoot, ".opengrove-store-package.json"),
    JSON.stringify({ schemaVersion: 1, source: "registry", appId }),
    "utf8",
  );
  symlinkSync(
    legacyWorkspaceRoot,
    join(legacyProgramRoot, "workspace"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return {
    root,
    roots,
    legacyProgramRoot: resolve(legacyProgramRoot),
    legacyWorkspaceContainer: resolve(legacyWorkspaceContainer),
    legacyWorkspaceRoot: resolve(legacyWorkspaceRoot),
    mount: {
      id: appId,
      path: resolve(legacyProgramRoot),
      workspacePath: resolve(legacyWorkspaceRoot),
      enabled: true,
    },
  };
}

function captureEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(values: Map<string, string | undefined>): void {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
