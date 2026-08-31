import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appCandidateContentDigest,
  MountedAppVersionStateStore,
  selectedFormalVersionFromMarker,
} from "../server/app-version-state.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-app-version-state-"));

try {
  const store = new MountedAppVersionStateStore(root);
  assert.equal(store.read("story-seed"), undefined);

  const formal = store.write({
    localAppId: "story-seed",
    activeContent: "formal",
    activeContentDigest: "c".repeat(64),
    selectedVersion: {
      packageKey: "opengrove.story-seed",
      version: "0.2.22",
      archiveSha256: "a".repeat(64),
      releaseCommitSha: "b".repeat(40),
    },
  });
  assert.deepEqual(store.read("story-seed")?.selectedVersion, formal.selectedVersion);
  assert.equal(store.read("story-seed")?.activeContentDigest, "c".repeat(64));

  const draft = store.write({
    localAppId: "story-seed",
    activeContent: "local-draft",
    selectedVersion: formal.selectedVersion,
  });
  assert.equal(draft.activeContent, "local-draft");
  assert.equal(draft.selectedVersion?.version, "0.2.22");

  store.restore("story-seed", formal);
  assert.equal(store.read("story-seed")?.activeContent, "formal");
  store.restore("story-seed", undefined);
  assert.equal(store.read("story-seed"), undefined);

  assert.deepEqual(
    selectedFormalVersionFromMarker({
      source: "registry",
      packageKey: "OPENGROVE.STORY-SEED",
      version: "0.2.22",
      archiveSha256: "A".repeat(64),
      releaseCommitSha: "b".repeat(40),
    }),
    {
      packageKey: "opengrove.story-seed",
      version: "0.2.22",
      archiveSha256: "a".repeat(64),
      releaseCommitSha: "b".repeat(40),
    },
  );
  assert.deepEqual(
    selectedFormalVersionFromMarker({
      source: "registry",
      packageKey: "opengrove.story-seed",
      appId: "story-seed",
      activeContent: "local-draft",
      draftContentDigest: "c".repeat(64),
      selectedVersion: {
        packageKey: "OPENGROVE.STORY-SEED",
        version: "0.2.22",
        archiveSha256: "A".repeat(64),
        releaseCommitSha: "b".repeat(40),
      },
    }),
    {
      packageKey: "opengrove.story-seed",
      version: "0.2.22",
      archiveSha256: "a".repeat(64),
      releaseCommitSha: "b".repeat(40),
    },
  );

  const digestA = appCandidateContentDigest({
    schemaVersion: 1,
    packageKey: "opengrove.story-seed",
    packageId: "story-seed",
    appId: "story-seed",
    version: "0.2.22",
    workspacePath: "workspace",
    files: {
      "opengrove.app.json": `sha256:${"1".repeat(64)}`,
      "ui/index.html": `sha256:${"2".repeat(64)}`,
    },
    provenance: { commit: "ignored" },
  });
  const digestB = appCandidateContentDigest({
    schemaVersion: 1,
    packageKey: "opengrove.story-seed",
    packageId: "story-seed",
    appId: "story-seed",
    version: "0.2.22",
    workspacePath: "workspace",
    files: {
      "ui/index.html": `sha256:${"2".repeat(64)}`,
      "opengrove.app.json": `sha256:${"1".repeat(64)}`,
    },
    provenance: { commit: "different-but-not-runtime-content" },
  });
  assert.equal(digestA, digestB, "file ordering and Git provenance must not create false dirty state");
  const nonAsciiFilesA = appCandidateContentDigest({
    schemaVersion: 1,
    packageKey: "opengrove.story-seed",
    packageId: "story-seed",
    appId: "story-seed",
    version: "0.2.22",
    workspacePath: "workspace",
    files: {
      "🎬.md": `sha256:${"4".repeat(64)}`,
      "（终）.md": `sha256:${"5".repeat(64)}`,
    },
  });
  const nonAsciiFilesB = appCandidateContentDigest({
    schemaVersion: 1,
    packageKey: "opengrove.story-seed",
    packageId: "story-seed",
    appId: "story-seed",
    version: "0.2.22",
    workspacePath: "workspace",
    files: {
      "（终）.md": `sha256:${"5".repeat(64)}`,
      "🎬.md": `sha256:${"4".repeat(64)}`,
    },
  });
  assert.equal(nonAsciiFilesA, nonAsciiFilesB, "non-ASCII paths must use one locale-independent byte order");
  assert.notEqual(
    digestA,
    appCandidateContentDigest({
      schemaVersion: 1,
      packageKey: "opengrove.story-seed",
      packageId: "story-seed",
      appId: "story-seed",
      version: "0.2.22",
      workspacePath: "workspace",
      files: {
        "opengrove.app.json": `sha256:${"3".repeat(64)}`,
        "ui/index.html": `sha256:${"2".repeat(64)}`,
      },
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("app version state harness passed\n");
