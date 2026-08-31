import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvName } from "../identity.js";
import { createBridgeState } from "../server/bridge-state.js";
import type { AppStorePackageRecord } from "../server/app-store.js";
import {
  importRegistryAppStorePackageForInstall,
  importRegistryAppStoreVersionForInstall,
  listRegistryAppStorePackages,
  listRegistryAppStoreVersions,
  type AppStoreRegistryConfig,
  type AppStoreFormalVersion,
} from "../server/app-store-registry.js";

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-version-registry-"));
const originalFetch = globalThis.fetch;
const previousUserData = process.env[appEnvName("USER_DATA_DIR")];
const archive = Buffer.from("exact formal version bytes", "utf8");
const digest = createHash("sha256").update(archive).digest("hex");
const config: AppStoreRegistryConfig = {
  baseUrl: "https://ww.test",
  registryToken: "test-session",
};
const catalogPackage: AppStorePackageRecord = {
  id: "story-seed",
  packageId: "story-seed",
  title: "故事种子",
  summary: "Story Seed",
  version: "0.2.23",
  category: "创作",
  publishKind: "app",
  installMode: "workspace",
  appId: "story-seed",
  workspaceName: "故事种子",
  requirements: [],
  capabilities: [],
  backupScopes: [],
  status: "available",
  visibility: "restricted",
  publisher: "OpenGrove Team",
  usageCount: 1,
  source: "registry",
  packageKey: "opengrove.story-seed",
};

try {
  process.env[appEnvName("USER_DATA_DIR")] = tempRoot;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, "Bearer test-session");
    if (url.endsWith("/v1/app-store/packages/opengrove.story-seed/versions")) {
      return new Response(
        JSON.stringify({
          versions: [
            {
              packageKey: "opengrove.story-seed",
              packageId: "story-seed",
              appId: "story-seed",
              title: "故事种子",
              version: "0.2.22",
              publishedBy: "Admin",
              publishedAt: "2026-07-29T10:00:00Z",
              releaseCommitSha: "b".repeat(40),
              releaseNotes: "Rollback target",
              artifactSource: "github-release",
              archiveName: "story-seed-0.2.22.tgz",
              archiveSize: archive.byteLength,
              archiveSha256: digest,
              minHostReleaseNumber: 10022,
              availability: "available",
              downloadReference: `/v1/app-store/packages/opengrove.story-seed/versions/0.2.22/download?archiveSha256=${digest}`,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/versions/0.2.22/download")) {
      return new Response(archive, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const versions = await listRegistryAppStoreVersions(config, "opengrove.story-seed");
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.version, "0.2.22");
  assert.equal(versions[0]?.archiveSha256, digest);

  const state = createBridgeState({ statePath: join(tempRoot, "state.json") });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, "Bearer test-session");
    if (url.endsWith("/v1/app-store/packages/opengrove.story-seed")) {
      return new Response(
        JSON.stringify({
          package: {
            ...catalogPackage,
            version: "0.2.22",
            archiveName: "story-seed-0.2.22.tgz",
            archiveSize: archive.byteLength,
            archiveSha256: digest,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/v1/app-store/packages/opengrove.story-seed/versions/0.2.22")) {
      return new Response(JSON.stringify({ version: versions[0] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/versions/0.2.22/download")) {
      return new Response(archive, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      });
    }
    if (url.endsWith("/v1/app-store/packages/opengrove.story-seed/download-url")) {
      return new Response(
        JSON.stringify({
          url: "/v1/app-store/packages/opengrove.story-seed/legacy-download",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/v1/app-store/packages/opengrove.story-seed/legacy-download")) {
      return new Response(archive, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  const importedLatest = await importRegistryAppStorePackageForInstall(
    state,
    { headers: {} } as never,
    "opengrove.story-seed",
    config,
  );
  assert.equal(importedLatest?.version, "0.2.22");
  assert.equal(
    importedLatest?.releaseCommitSha,
    "b".repeat(40),
    "installing the current Store package must retain the formal Git release identity",
  );
  assert.equal(
    requests.some((url) => url.endsWith("/v1/app-store/packages/opengrove.story-seed/versions/0.2.22")),
    true,
  );

  const contractMismatches: Array<[string, Partial<AppStoreFormalVersion>]> = [
    ["packageKey", { packageKey: "opengrove.other-app" }],
    ["packageId", { packageId: "other-app" }],
    ["appId", { appId: "other-app" }],
    ["version", { version: "0.2.21" }],
    ["archiveName", { archiveName: "other-app-0.2.22.tgz" }],
    ["archiveSize", { archiveSize: archive.byteLength + 1 }],
    ["archiveSha256", { archiveSha256: "f".repeat(64) }],
  ];
  for (const [field, mismatch] of contractMismatches) {
    let downloadAttempted = false;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/app-store/packages/opengrove.story-seed")) {
        return new Response(
          JSON.stringify({
            package: {
              ...catalogPackage,
              version: "0.2.22",
              archiveName: "story-seed-0.2.22.tgz",
              archiveSize: archive.byteLength,
              archiveSha256: digest,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/app-store/packages/opengrove.story-seed/versions/0.2.22")) {
        return new Response(JSON.stringify({ version: { ...versions[0], ...mismatch } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/download")) downloadAttempted = true;
      return new Response("unexpected request", { status: 500 });
    };
    await assert.rejects(
      importRegistryAppStorePackageForInstall(state, { headers: {} } as never, "opengrove.story-seed", config),
      /app_store_version_contract_invalid/,
      `a ${field} mismatch between the catalog and formal version must fail closed`,
    );
    assert.equal(downloadAttempted, false, `${field} mismatch must fail before archive download`);
  }

  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    assert.equal(url.includes("/versions/0.2.22/download"), true);
    return new Response(archive, {
      status: 200,
      headers: { "content-length": String(archive.byteLength) },
    });
  };
  const imported = await importRegistryAppStoreVersionForInstall(state, versions[0]!, catalogPackage, config);
  assert.equal(imported.version, "0.2.22");
  assert.equal(imported.archiveSha256, digest);
  assert.equal(imported.releaseCommitSha, "b".repeat(40));
  assert.equal(
    requests.some((url) => url.includes("/versions/0.2.22/download")),
    true,
  );

  let progressiveOffset = 0;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
          if (progressiveOffset >= archive.byteLength) {
            controller.close();
            return;
          }
          const nextOffset = Math.min(progressiveOffset + 5, archive.byteLength);
          controller.enqueue(archive.subarray(progressiveOffset, nextOffset));
          progressiveOffset = nextOffset;
        },
      }),
      {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      },
    );
  const progressivelyImported = await importRegistryAppStoreVersionForInstall(
    state,
    versions[0]!,
    catalogPackage,
    config,
    { transferIdleTimeoutMs: 100 },
  );
  assert.equal(
    progressivelyImported.archiveSha256,
    digest,
    "a large archive that keeps making progress must not fail a wall-clock transfer deadline",
  );

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(archive.subarray(0, 1));
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    importRegistryAppStoreVersionForInstall(state, versions[0]!, catalogPackage, config, { transferIdleTimeoutMs: 5 }),
    /app_store_archive_transfer_timeout/,
    "an archive stream that stops making progress must still fail quickly",
  );

  globalThis.fetch = async () =>
    new Response(Buffer.from("tampered"), {
      status: 200,
      headers: { "content-length": String("tampered".length) },
    });
  await assert.rejects(
    importRegistryAppStoreVersionForInstall(
      state,
      {
        ...versions[0]!,
        archiveSize: "tampered".length,
      },
      catalogPackage,
      config,
    ),
    /app_store_archive_checksum_mismatch/,
  );

  globalThis.fetch = async () =>
    new Response(Buffer.concat([archive, Buffer.from("overflow")]), {
      status: 200,
    });
  await assert.rejects(
    importRegistryAppStoreVersionForInstall(state, versions[0]!, catalogPackage, config),
    /app_store_archive_size_mismatch/,
  );

  globalThis.fetch = async () =>
    new Response(archive.subarray(0, archive.byteLength - 1), {
      status: 200,
    });
  await assert.rejects(
    importRegistryAppStoreVersionForInstall(state, versions[0]!, catalogPackage, config),
    /app_store_archive_size_mismatch/,
  );

  await assert.rejects(
    importRegistryAppStoreVersionForInstall(
      state,
      {
        ...versions[0]!,
        availability: "artifact_unavailable",
        archiveSize: 0,
        archiveSha256: "",
        downloadReference: null,
      },
      catalogPackage,
      config,
    ),
    /app_store_version_artifact_unavailable/,
  );

  globalThis.fetch = ((_input, init) =>
    new Promise((_resolve, reject) => {
      assert.ok(init?.signal, "formal version requests must always have a timeout signal");
      const guard = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
      init.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(guard);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    })) as typeof fetch;
  await assert.rejects(
    listRegistryAppStoreVersions(config, "opengrove.story-seed", { timeoutMs: 5 }),
    /TimeoutError|timed out|aborted/i,
  );
  await assert.rejects(
    importRegistryAppStoreVersionForInstall(state, versions[0]!, catalogPackage, config, { timeoutMs: 5 }),
    /TimeoutError|timed out|aborted/i,
  );

  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal, "catalog requests must always have a bounded timeout");
    return new Response(JSON.stringify({ packages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  assert.deepEqual(await listRegistryAppStorePackages(config, { headers: {} } as never), []);

  process.stdout.write("app store version registry harness passed\n");
} finally {
  globalThis.fetch = originalFetch;
  if (previousUserData === undefined) delete process.env[appEnvName("USER_DATA_DIR")];
  else process.env[appEnvName("USER_DATA_DIR")] = previousUserData;
  rmSync(tempRoot, { recursive: true, force: true });
}
