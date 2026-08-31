import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { prepareAppReleaseSourceSnapshot } from "../server/app-release-source-snapshot.js";
import type { MountedAppReleaseDraft } from "../server/app-release.js";
import { packAppStoreArchive } from "../server/app-store.js";
import { LocalAppDraftStore } from "../server/local-app-drafts.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-release-source-snapshot-"));
try {
  const appRoot = join(root, "app");
  mkdirSync(join(appRoot, "workspace"), { recursive: true });
  mkdirSync(join(appRoot, "bin"), { recursive: true });
  mkdirSync(join(appRoot, "web"), { recursive: true });
  writeFileSync(
    join(appRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "snapshot-app",
        title: "Draft App",
        description: "Draft description",
        version: "1.0.0",
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: {
          packExclude: ["build.mjs", "web/**", "package-lock.json"],
          visibility: "restricted",
          employeeDefaults: [
            {
              memberId: "member-app-snapshot-app-writer",
              name: "Draft Writer",
              role: "Writes.",
              kernel: "codex",
              model: "native",
              color: "#2563eb",
              availableSkillIds: [],
              defaultSkillIds: [],
              visibility: "private",
              publicSkills: [],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(appRoot, "source.txt"), "saved draft source\n", "utf8");
  writeFileSync(join(appRoot, "build.mjs"), "// trusted build entry\n", "utf8");
  writeFileSync(join(appRoot, "package.json"), '{"scripts":{"build":"node build.mjs"}}\n', "utf8");
  writeFileSync(join(appRoot, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  writeFileSync(join(appRoot, "web", "source.ts"), "export const source = true;\n", "utf8");
  writeFileSync(join(appRoot, "🎬.md"), "emoji sorts by UTF-8 bytes\n", "utf8");
  writeFileSync(join(appRoot, "（终）.md"), "full-width punctuation sorts first\n", "utf8");
  writeFileSync(join(appRoot, "bin", "run"), "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  writeFileSync(join(appRoot, "workspace", "private.md"), "never publish me\n", "utf8");

  const employees = [
    {
      memberId: "member-app-snapshot-app-writer",
      name: "Publish Writer",
      role: "Writes the published App.",
      kernel: "claude-code",
      model: "deepseek-v4-pro",
      reasoningEffort: "high" as const,
      contextTokenBudget: 200_000,
      accessMode: "full-access" as const,
      color: "#148a47",
      availableSkillIds: ["app:snapshot-app/writing"],
      defaultSkillIds: ["app:snapshot-app/writing"],
      visibility: "public" as const,
      publicDescription: "Published writer",
      publicSkills: ["writing"],
      inputSpec: "A story brief",
      outputSpec: "A finished story",
    },
  ];
  const draftArchive = packAppStoreArchive({
    appRoot,
    allowSetup: true,
    purpose: "local-draft",
  });
  const draftStore = new LocalAppDraftStore(join(root, "drafts"));
  const draft = draftStore.save({
    localAppId: "local-snapshot-app",
    appId: "snapshot-app",
    archive: draftArchive,
    employees,
  });

  writeFileSync(join(appRoot, "source.txt"), "unsaved content after draft save\n", "utf8");
  writeFileSync(join(appRoot, "workspace", "private.md"), "newer private data\n", "utf8");

  const release: MountedAppReleaseDraft = {
    identity: {
      appId: "snapshot-app",
      source: "mounted",
      appRoot,
      workspaceRoot: join(appRoot, "workspace"),
    },
    app: {
      title: "Published Snapshot App",
      description: "Projected from the release page",
      icon: "🌱",
    },
    version: "1.2.0",
    releaseNotes: "The first Git-backed release",
    visibility: "public",
    employees,
    checks: [],
  };
  const modeStore = new LocalAppDraftStore(join(root, "mode-drafts"));
  const modePrebuildArchive = packAppStoreArchive({
    appRoot,
    allowSetup: true,
    purpose: "local-draft",
  });
  const modePrebuild = modeStore.save({
    localAppId: "local-snapshot-app",
    appId: "snapshot-app",
    archive: modePrebuildArchive,
    employees,
  });
  chmodSync(join(appRoot, "bin", "run"), 0o700);
  const modeChanged = modeStore.save({
    localAppId: "local-snapshot-app",
    appId: "snapshot-app",
    archive: packAppStoreArchive({
      appRoot,
      allowSetup: true,
      purpose: "local-draft",
    }),
    employees,
  });
  chmodSync(join(appRoot, "bin", "run"), 0o755);
  assert.equal(
    modeChanged.contentDigest,
    modePrebuild.contentDigest,
    "file mode changes intentionally do not redefine the existing content digest",
  );
  assert.notEqual(modeChanged.archiveSha256, modePrebuild.archiveSha256);
  assert.throws(
    () =>
      prepareAppReleaseSourceSnapshot({
        draftStore: modeStore,
        localAppId: "local-snapshot-app",
        expectedDraftDigest: modePrebuild.contentDigest,
        expectedDraftArchiveSha256: modePrebuild.archiveSha256,
        release,
      }),
    /app_store_publish_draft_changed/u,
    "the exact draft binding must include archive identity so mode-only replacement cannot pass",
  );
  assert.throws(
    () =>
      prepareAppReleaseSourceSnapshot({
        draftStore,
        localAppId: "local-snapshot-app",
        expectedDraftDigest: draft.contentDigest,
        expectedDraftArchiveSha256: draft.archiveSha256,
        release: {
          ...release,
          identity: {
            ...release.identity,
            appId: "another-app",
          },
        },
      }),
    /app_release_draft_identity_mismatch/,
    "a saved draft must not be projected onto another App identity",
  );
  const first = prepareAppReleaseSourceSnapshot({
    draftStore,
    localAppId: "local-snapshot-app",
    expectedDraftDigest: draft.contentDigest,
    expectedDraftArchiveSha256: draft.archiveSha256,
    release,
  });
  const second = prepareAppReleaseSourceSnapshot({
    draftStore,
    localAppId: "local-snapshot-app",
    expectedDraftDigest: draft.contentDigest,
    expectedDraftArchiveSha256: draft.archiveSha256,
    release,
  });
  assert.throws(
    () =>
      prepareAppReleaseSourceSnapshot({
        draftStore,
        localAppId: "local-snapshot-app",
        expectedDraftDigest: "f".repeat(64),
        expectedDraftArchiveSha256: draft.archiveSha256,
        release,
      }),
    /app_store_publish_draft_changed/,
    "a snapshot must never mix a saved intent digest with another local draft's bytes",
  );

  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sha256, createHash("sha256").update(first.bytes).digest("hex"));
  assert.equal(first.size, first.bytes.byteLength);
  assert.notEqual(first.sha256, draft.contentDigest, "draft and source snapshot identities are independent");
  assert.equal(second.sha256, first.sha256, "the same saved draft and release intent must be byte stable");
  assert.deepEqual(second.bytes, first.bytes);
  assert.deepEqual(
    first.files.map((file) => [file.path, file.mode]),
    [
      ["bin/run", "100755"],
      ["build.mjs", "100644"],
      ["opengrove.app.json", "100644"],
      ["package-lock.json", "100644"],
      ["package.json", "100644"],
      ["source.txt", "100644"],
      ["web/source.ts", "100644"],
      ["（终）.md", "100644"],
      ["🎬.md", "100644"],
    ],
  );

  const files = readTarFiles(gunzipSync(first.bytes));
  assert.equal(files.get("source.txt")?.toString("utf8"), "saved draft source\n");
  assert.equal(files.has("workspace/private.md"), false);
  assert.equal(files.has(".opengrove-package-manifest.json"), false);
  assert.equal(files.has(".opengrove-store-package.json"), false);
  assert.equal(files.has("build.mjs"), true, "runtime packExclude must not remove source build inputs");
  assert.equal(files.has("web/source.ts"), true, "candidate source must retain excluded runtime sources");
  const manifest = JSON.parse(files.get("opengrove.app.json")!.toString("utf8"));
  assert.equal(manifest.id, "snapshot-app");
  assert.equal(manifest.version, "1.2.0");
  assert.equal(manifest.title, "Published Snapshot App");
  assert.equal(manifest.description, "Projected from the release page");
  assert.equal(manifest.icon, "🌱");
  assert.equal(manifest.store.packageKey, "opengrove.snapshot-app");
  assert.equal(manifest.store.visibility, "public");
  assert.equal(manifest.store.releaseNotes, "The first Git-backed release");
  assert.deepEqual(manifest.store.employeeDefaults, employees);

  const savedArchivePath = draftStore.archivePath("local-snapshot-app");
  assert.ok(savedArchivePath);
  const savedArchiveBytes = readFileSync(savedArchivePath);
  const tamperedArchiveBytes = Buffer.from(savedArchiveBytes);
  const finalByteIndex = tamperedArchiveBytes.length - 1;
  tamperedArchiveBytes[finalByteIndex] = tamperedArchiveBytes[finalByteIndex]! ^ 0xff;
  writeFileSync(savedArchivePath, tamperedArchiveBytes);
  assert.throws(
    () =>
      prepareAppReleaseSourceSnapshot({
        draftStore,
        localAppId: "local-snapshot-app",
        expectedDraftDigest: draft.contentDigest,
        expectedDraftArchiveSha256: draft.archiveSha256,
        release,
      }),
    /local_app_draft_archive_invalid/,
    "source materialization must reject changed archive bytes even when the archive size is unchanged",
  );
  writeFileSync(savedArchivePath, savedArchiveBytes);

  const setupRoot = join(root, "setup-app");
  mkdirSync(join(setupRoot, "workspace"), { recursive: true });
  writeFileSync(
    join(setupRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "setup-app",
        title: "Setup App",
        version: "0.1.0",
        ui: { surface: "setup", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: { employeeDefaults: [] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const setupStore = new LocalAppDraftStore(join(root, "setup-drafts"));
  const setupDraft = setupStore.save({
    localAppId: "local-setup-app",
    appId: "setup-app",
    archive: packAppStoreArchive({
      appRoot: setupRoot,
      allowSetup: true,
      purpose: "local-draft",
    }),
    employees: [],
  });
  assert.throws(
    () =>
      prepareAppReleaseSourceSnapshot({
        draftStore: setupStore,
        localAppId: "local-setup-app",
        expectedDraftDigest: setupDraft.contentDigest,
        expectedDraftArchiveSha256: setupDraft.archiveSha256,
        release: {
          identity: {
            appId: "setup-app",
            source: "mounted",
            appRoot: setupRoot,
            workspaceRoot: join(setupRoot, "workspace"),
          },
          app: { title: "Setup App", description: "" },
          version: "0.1.0",
          releaseNotes: "",
          visibility: "restricted",
          employees: [],
          checks: [],
        },
      }),
    /app_setup_not_publishable/,
    "the exact saved draft must still be rejected before upload when it remains in setup mode",
  );

  const boundaryRoot = join(root, "boundary-app");
  mkdirSync(join(boundaryRoot, "workspace"), { recursive: true });
  mkdirSync(join(boundaryRoot, "src"), { recursive: true });
  writeFileSync(
    join(boundaryRoot, "opengrove.app.json"),
    `${JSON.stringify(
      {
        id: "boundary-app",
        title: "Boundary App",
        version: "0.1.0",
        ui: { surface: "none", workspace: "workspace" },
        workspace: { path: "workspace" },
        store: { employeeDefaults: [] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  for (let index = 0; index < 4_999; index += 1) {
    writeFileSync(join(boundaryRoot, "src", `${String(index).padStart(4, "0")}.txt`), `${index}\n`, "utf8");
  }
  const boundaryStore = new LocalAppDraftStore(join(root, "boundary-drafts"));
  const saveBoundaryDraft = () =>
    boundaryStore.save({
      localAppId: "local-boundary-app",
      appId: "boundary-app",
      archive: packAppStoreArchive({
        appRoot: boundaryRoot,
        allowSetup: true,
        purpose: "local-draft",
      }),
      employees: [],
    });
  let boundaryDraft = saveBoundaryDraft();
  const boundaryRelease: MountedAppReleaseDraft = {
    identity: {
      appId: "boundary-app",
      source: "mounted",
      appRoot: boundaryRoot,
      workspaceRoot: join(boundaryRoot, "workspace"),
    },
    app: { title: "Boundary App", description: "" },
    version: "0.1.0",
    releaseNotes: "",
    visibility: "restricted",
    employees: [],
    checks: [],
  };
  assert.equal(
    prepareAppReleaseSourceSnapshot({
      draftStore: boundaryStore,
      localAppId: "local-boundary-app",
      expectedDraftDigest: boundaryDraft.contentDigest,
      expectedDraftArchiveSha256: boundaryDraft.archiveSha256,
      release: boundaryRelease,
    }).files.length,
    5_000,
    "the Host must accept Release Control's exact 5,000-file source limit",
  );
  writeFileSync(join(boundaryRoot, "src", "5000.txt"), "5000\n", "utf8");
  boundaryDraft = saveBoundaryDraft();
  assert.throws(
    () =>
      prepareAppReleaseSourceSnapshot({
        draftStore: boundaryStore,
        localAppId: "local-boundary-app",
        expectedDraftDigest: boundaryDraft.contentDigest,
        expectedDraftArchiveSha256: boundaryDraft.archiveSha256,
        release: boundaryRelease,
      }),
    /app_release_source_file_count_exceeded/,
    "the Host must fail before upload when a source snapshot exceeds Release Control's realizable limit",
  );

  process.stdout.write("app release source snapshot harness passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function readTarFiles(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(tarText(header, 124, 12) || "0", 8);
    const bodyOffset = offset + 512;
    files.set(path, bytes.subarray(bodyOffset, bodyOffset + size));
    offset = bodyOffset + Math.ceil(size / 512) * 512;
  }
  return files;
}

function tarText(bytes: Buffer, offset: number, length: number): string {
  const value = bytes.subarray(offset, offset + length);
  const end = value.indexOf(0);
  return value
    .subarray(0, end >= 0 ? end : value.byteLength)
    .toString("utf8")
    .trim();
}
