import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpAppMediaCache,
  resolvePinnedPublicAddress,
  resolvePublicMediaSourceAddresses,
  type McpAppMediaCacheResult,
} from "../server/mcp-app-media-cache.js";
import type { MountedAppTarget } from "../server/mounted-apps.js";

const root = mkdtempSync(join(tmpdir(), "opengrove-mcp-media-cache-"));
const target = {
  localAppId: "media-cache-app",
  id: "media-cache-app",
  title: "Media cache app",
  appRoot: root,
  workspaceRoot: join(root, "workspace"),
  workspace: {
    kind: "local",
    appId: "media-cache-app",
    root: join(root, "workspace"),
  },
  manifest: {
    id: "media-cache-app",
    title: "Media cache app",
    ui: {
      surface: "view",
      view: {
        protocol: "mcp-app",
        entry: "ui/index.html",
        tools: ["opengrove.app.media.cache"],
        csp: {
          connectDomains: ["https://media.example.test"],
          resourceDomains: ["https://media.example.test"],
        },
      },
    },
  },
} satisfies MountedAppTarget;

let requests = 0;
const payloads = new Map([
  ["https://media.example.test/one.mp4", Buffer.from("abcdefgh")],
  ["https://media.example.test/two.mp4", Buffer.from("ijklmnop")],
]);
const cache = new McpAppMediaCache({
  maxBytes: 12,
  resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
  fetch: async (input, init) => {
    requests += 1;
    assert.equal(
      new Headers(init?.headers).get("range"),
      "bytes=0-",
      "Feishu playback URLs require Range downloads of the original file",
    );
    assert.equal(
      new Headers(init?.headers).get("origin"),
      "null",
      "the opaque View playback data plane only accepts Origin:null",
    );
    const url = String(input);
    const body = payloads.get(url);
    if (!body) return new Response("missing", { status: 404 });
    return new Response(body, {
      status: 206,
      headers: {
        "content-range": `bytes 0-${body.byteLength - 1}/${body.byteLength}`,
        "content-type": "video/mp4",
      },
    });
  },
});

try {
  await assert.rejects(
    cache.prepare(withSourceDomains(target, ["https://127.0.0.1"]), {
      sourceUrl: "https://127.0.0.1/private.mp4",
      cacheKey: "blocked-loopback",
      expectedSize: 8,
      contentType: "video/mp4",
    }),
    /media_source_not_allowed/u,
    "manifest CSP must not extend Host download capability to loopback addresses",
  );
  assert.equal(requests, 0, "loopback addresses must be rejected before reaching fetch");
  await assert.rejects(
    cache.prepare(withSourceDomains(target, ["https://[::1]"]), {
      sourceUrl: "https://[::1]/private.mp4",
      cacheKey: "blocked-ipv6-loopback",
      expectedSize: 8,
      contentType: "video/mp4",
    }),
    /media_source_not_allowed/u,
    "IPv6 loopback must also be rejected before reaching fetch",
  );
  assert.equal(requests, 0);

  for (const blockedOrigin of [
    "https://0.0.0.0",
    "https://10.0.0.1",
    "https://100.64.0.1",
    "https://169.254.169.254",
    "https://172.16.0.1",
    "https://192.0.2.1",
    "https://198.18.0.1",
    "https://198.51.100.1",
    "https://203.0.113.1",
    "https://224.0.0.1",
    "https://240.0.0.1",
    "https://[::]",
    "https://[::ffff:127.0.0.1]",
    "https://[fc00::1]",
    "https://[fe80::1]",
    "https://[ff00::1]",
  ]) {
    await assert.rejects(
      cache.prepare(withSourceDomains(target, [blockedOrigin]), {
        sourceUrl: `${blockedOrigin}/private.mp4`,
        cacheKey: `blocked-${blockedOrigin}`,
        expectedSize: 8,
        contentType: "video/mp4",
      }),
      /media_source_not_allowed/u,
      `${blockedOrigin} must not enter the Host download channel`,
    );
  }
  assert.equal(requests, 0, "private, link-local, multicast, and reserved addresses must all be rejected before fetch");

  let privateDnsRequests = 0;
  const privateDnsCache = new McpAppMediaCache({
    resolveAddresses: async () => [{ address: "192.168.1.20", family: 4 }],
    fetch: async () => {
      privateDnsRequests += 1;
      return new Response(Buffer.from("abcdefgh"), {
        status: 200,
        headers: { "content-length": "8" },
      });
    },
  });
  await assert.rejects(
    privateDnsCache.prepare(target, {
      sourceUrl: "https://media.example.test/private.mp4",
      cacheKey: "blocked-private-dns",
      expectedSize: 8,
      contentType: "video/mp4",
    }),
    /media_source_not_allowed/u,
    "public hostnames resolving to private addresses must be rejected",
  );
  assert.equal(privateDnsRequests, 0, "the DNS safety check must happen before fetch");

  await assert.rejects(
    resolvePinnedPublicAddress("media.example.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.20", family: 4 },
    ]),
    /media_source_not_allowed/u,
    "a hostname must be rejected as a whole if any resolved address falls in a private range",
  );

  let publicFallbackCalls = 0;
  const fakeIpPinned = await resolvePinnedPublicAddress(
    "media.example.test",
    async () => [{ address: "198.18.2.76", family: 4 }],
    async () => {
      publicFallbackCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  );
  assert.equal(
    fakeIpPinned.address,
    "93.184.216.34",
    "Fake-IP environments must switch to the trusted public resolver result",
  );
  assert.equal(
    publicFallbackCalls,
    1,
    "the public resolver is only queried when system resolution hits a Fake-IP range",
  );

  let fakeIpCacheRequests = 0;
  const fakeIpCache = new McpAppMediaCache({
    resolveAddresses: async () => [{ address: "198.18.2.76", family: 4 }],
    resolvePublicAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => {
      fakeIpCacheRequests += 1;
      return new Response(Buffer.from("abcdefgh"), {
        status: 200,
        headers: { "content-length": "8", "content-type": "video/mp4" },
      });
    },
  });
  await waitForReady(fakeIpCache, target, {
    sourceUrl: "https://media.example.test/fake-ip.mp4",
    cacheKey: "fake-ip-fallback",
    expectedSize: 8,
    contentType: "video/mp4",
  });
  assert.equal(
    fakeIpCacheRequests,
    1,
    "Fake-IP must not block media downloads already re-verified via public resolution",
  );

  let unsafeFallbackRequests = 0;
  const unsafeFallbackCache = new McpAppMediaCache({
    resolveAddresses: async () => [{ address: "198.18.2.76", family: 4 }],
    resolvePublicAddresses: async () => [{ address: "192.168.1.20", family: 4 }],
    fetch: async () => {
      unsafeFallbackRequests += 1;
      return new Response(Buffer.from("abcdefgh"), { status: 200 });
    },
  });
  await assert.rejects(
    unsafeFallbackCache.prepare(target, {
      sourceUrl: "https://media.example.test/unsafe-fallback.mp4",
      cacheKey: "unsafe-fallback",
      expectedSize: 8,
      contentType: "video/mp4",
    }),
    /media_source_not_allowed/u,
    "public re-verification results must still pass the full SSRF address check",
  );
  assert.equal(
    unsafeFallbackRequests,
    0,
    "when public re-verification returns a private address, the download channel must not be entered",
  );

  const dohRequests: string[] = [];
  const dohAddresses = await resolvePublicMediaSourceAddresses("media.example.test", async (input, init) => {
    dohRequests.push(input);
    assert.equal(new Headers(init.headers).get("accept"), "application/dns-json");
    const recordType = new URL(input).searchParams.get("type");
    return Response.json({
      Status: 0,
      Answer:
        recordType === "A"
          ? [
              { name: "media.example.test.", type: 5, data: "cdn.example.test." },
              { name: "cdn.example.test.", type: 1, data: "93.184.216.34" },
            ]
          : [],
    });
  });
  assert.deepEqual(dohAddresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.deepEqual(
    dohRequests.map((request) => new URL(request).searchParams.get("type")),
    ["A", "AAAA"],
    "the public resolver must re-verify both IPv4 and IPv6 results",
  );

  let rebindingResolverCalls = 0;
  let nextResolvedAddress = "93.184.216.34";
  const pinned = await resolvePinnedPublicAddress("media.example.test", async () => {
    rebindingResolverCalls += 1;
    return [{ address: nextResolvedAddress, family: 4 }];
  });
  nextResolvedAddress = "127.0.0.1";
  assert.equal(await lookupAddress(pinned.lookup, "media.example.test"), "93.184.216.34");
  assert.equal(await lookupAddress(pinned.lookup, "media.example.test"), "93.184.216.34");
  assert.equal(
    rebindingResolverCalls,
    1,
    "the connection phase must reuse the verified IP and never re-resolve the hostname",
  );

  await assert.rejects(
    cache.prepare(target, {
      sourceUrl: "https://attacker.example.test/video.mp4",
      cacheKey: "blocked",
      expectedSize: 8,
      contentType: "video/mp4",
    }),
    /media_source_not_allowed/u,
  );

  const first = await cache.prepare(target, {
    sourceUrl: "https://media.example.test/one.mp4",
    cacheKey: "version-one",
    expectedSize: 8,
    contentType: "video/mp4",
  });
  assert.equal(first.status, "downloading");
  const readyOne = await waitForReady(cache, target, {
    sourceUrl: "https://media.example.test/one.mp4",
    cacheKey: "version-one",
    expectedSize: 8,
    contentType: "video/mp4",
  });
  assert.equal(requests, 1, "polling on the same cache key must not download again");
  assert.equal(readyOne.cachedBytes, 8);
  assert.match(readyOne.mediaUrl ?? "", /^\.\/mcp-app-media\/[A-Za-z0-9_-]+$/u);
  assert.match(
    readyOne.workspacePath ?? "",
    /^\.cache\/opengrove-media\/[0-9a-f]{64}\.mp4$/u,
    "the ready result must give this App's declarative CLI a workspace-relative path",
  );
  assert.equal(
    readyOne.workspacePath?.includes(root),
    false,
    "media cache results must not expose local absolute paths to the View",
  );
  const openedOne = cache.open(readyOne.mediaUrl ?? "");
  assert.equal(openedOne?.entry.size, 8);
  assert.equal(openedOne?.entry.mimeType, "video/mp4");

  const readyOneAgain = await cache.prepare(target, {
    sourceUrl: "https://media.example.test/one.mp4",
    cacheKey: "version-one",
    expectedSize: 8,
    contentType: "video/mp4",
  });
  assert.equal(readyOneAgain.status, "ready");
  assert.equal(readyOneAgain.mediaUrl, readyOne.mediaUrl, "the capability URL must stay stable within one process");
  assert.equal(readyOneAgain.workspacePath, readyOne.workspacePath);
  assert.equal(requests, 1, "a local cache hit must not reach the remote");

  await waitForReady(cache, target, {
    sourceUrl: "https://media.example.test/two.mp4",
    cacheKey: "version-two",
    expectedSize: 8,
    contentType: "video/mp4",
  });
  assert.equal(requests, 2);
  assert.equal(
    cache.open(readyOne.mediaUrl ?? ""),
    undefined,
    "exceeding the limit should evict the least recently used entry",
  );

  await waitForReady(cache, target, {
    sourceUrl: "https://media.example.test/one.mp4",
    cacheKey: "version-one",
    expectedSize: 8,
    contentType: "video/mp4",
  });
  assert.equal(requests, 3, "an LRU-evicted version is re-downloaded only when opened again");
  assert.deepEqual(
    readdirSync(join(target.workspaceRoot, ".cache", "opengrove-media")).filter((name) => name.endsWith(".part")),
    [],
    "no partial files may be left behind after success",
  );

  const sameKeyWorkspace = join(root, "same-key-workspace");
  const sameKeyTarget = {
    ...target,
    id: "same-key-media-cache-app",
    workspaceRoot: sameKeyWorkspace,
    workspace: {
      kind: "local",
      appId: "same-key-media-cache-app",
      root: sameKeyWorkspace,
    },
  } satisfies MountedAppTarget;
  let releaseSameKeyDownload: () => void = () => {};
  const sameKeyGate = new Promise<void>((resolvePromise) => {
    releaseSameKeyDownload = resolvePromise;
  });
  let sameKeyRequests = 0;
  const sameKeyCache = new McpAppMediaCache({
    maxBytes: 12,
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => {
      sameKeyRequests += 1;
      await sameKeyGate;
      return new Response(Buffer.from("abcdefgh"), {
        status: 200,
        headers: { "content-length": "8", "content-type": "video/mp4" },
      });
    },
  });
  const sameKeyInput = {
    sourceUrl: "https://media.example.test/same-key.mp4",
    cacheKey: "same-key",
    expectedSize: 8,
    contentType: "video/mp4",
  };
  const sameKeyResults = await Promise.all([
    sameKeyCache.prepare(sameKeyTarget, sameKeyInput),
    sameKeyCache.prepare(sameKeyTarget, sameKeyInput),
  ]);
  releaseSameKeyDownload();
  assert.deepEqual(
    sameKeyResults.map((result) => result.status),
    ["downloading", "downloading"],
  );
  assert.equal(sameKeyRequests, 1, "concurrent calls on the same cache key may start only one download task");
  await waitForReady(sameKeyCache, sameKeyTarget, sameKeyInput);

  const concurrentWorkspace = join(root, "concurrent-workspace");
  const concurrentTarget = {
    ...target,
    id: "concurrent-media-cache-app",
    workspaceRoot: concurrentWorkspace,
    workspace: {
      kind: "local",
      appId: "concurrent-media-cache-app",
      root: concurrentWorkspace,
    },
  } satisfies MountedAppTarget;
  let releaseConcurrentDownloads: () => void = () => {};
  const concurrentGate = new Promise<void>((resolvePromise) => {
    releaseConcurrentDownloads = resolvePromise;
  });
  let concurrentRequests = 0;
  const concurrentCache = new McpAppMediaCache({
    maxBytes: 12,
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => {
      concurrentRequests += 1;
      await concurrentGate;
      return new Response(Buffer.from("abcdefgh"), {
        status: 200,
        headers: { "content-length": "8", "content-type": "video/mp4" },
      });
    },
  });
  const concurrentInputs = [
    {
      sourceUrl: "https://media.example.test/concurrent-a.mp4",
      cacheKey: "concurrent-a",
      expectedSize: 8,
      contentType: "video/mp4",
    },
    {
      sourceUrl: "https://media.example.test/concurrent-b.mp4",
      cacheKey: "concurrent-b",
      expectedSize: 8,
      contentType: "video/mp4",
    },
  ];
  const concurrentResults = await Promise.allSettled(
    concurrentInputs.map((input) => concurrentCache.prepare(concurrentTarget, input)),
  );
  releaseConcurrentDownloads();
  const acceptedIndex = concurrentResults.findIndex((result) => result.status === "fulfilled");
  assert.notEqual(acceptedIndex, -1);
  await waitForReady(concurrentCache, concurrentTarget, concurrentInputs[acceptedIndex]!);
  const rejected = concurrentResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected.length, 1, "concurrent tasks must reserve capacity atomically before downloading");
  assert.match(String(rejected[0]!.reason), /media_cache_capacity_exceeded/u);
  assert.equal(concurrentRequests, 1, "tasks without a capacity reservation must not enter fetch");
  const concurrentCacheDirectory = join(concurrentWorkspace, ".cache", "opengrove-media");
  const concurrentBytes = readdirSync(concurrentCacheDirectory).reduce(
    (total, name) => total + statSync(join(concurrentCacheDirectory, name)).size,
    0,
  );
  assert.ok(
    concurrentBytes <= 12,
    `cache holds ${concurrentBytes} bytes after concurrent downloads, exceeding the 12 byte limit`,
  );

  const orphanWorkspace = join(root, "orphan-part-workspace");
  const orphanTarget = {
    ...target,
    id: "orphan-part-media-cache-app",
    workspaceRoot: orphanWorkspace,
    workspace: {
      kind: "local",
      appId: "orphan-part-media-cache-app",
      root: orphanWorkspace,
    },
  } satisfies MountedAppTarget;
  const orphanCacheDirectory = join(orphanWorkspace, ".cache", "opengrove-media");
  mkdirSync(orphanCacheDirectory, { recursive: true });
  writeFileSync(join(orphanCacheDirectory, "abandoned.mp4.part"), Buffer.from("12345678"));
  const orphanCache = new McpAppMediaCache({
    maxBytes: 12,
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () =>
      new Response(Buffer.from("abcdefgh"), {
        status: 200,
        headers: { "content-length": "8", "content-type": "video/mp4" },
      }),
  });
  await waitForReady(orphanCache, orphanTarget, {
    sourceUrl: "https://media.example.test/orphan-replacement.mp4",
    cacheKey: "orphan-replacement",
    expectedSize: 8,
    contentType: "video/mp4",
  });
  assert.deepEqual(
    readdirSync(orphanCacheDirectory).filter((name) => name.endsWith(".part")),
    [],
    "capacity accounting must include and clean up leftover .part files",
  );
  assert.ok(
    readdirSync(orphanCacheDirectory).reduce(
      (total, name) => total + statSync(join(orphanCacheDirectory, name)).size,
      0,
    ) <= 12,
    "leftover .part files must not let the cache exceed the limit",
  );

  const leasedWorkspace = join(root, "leased-workspace");
  const leasedTarget = {
    ...target,
    id: "leased-media-cache-app",
    workspaceRoot: leasedWorkspace,
    workspace: {
      kind: "local",
      appId: "leased-media-cache-app",
      root: leasedWorkspace,
    },
  } satisfies MountedAppTarget;
  const leasedCache = new McpAppMediaCache({
    maxBytes: 12,
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () =>
      new Response(Buffer.from("abcdefgh"), {
        status: 200,
        headers: { "content-length": "8", "content-type": "video/mp4" },
      }),
  });
  const leasedInput = {
    sourceUrl: "https://media.example.test/leased.mp4",
    cacheKey: "leased",
    expectedSize: 8,
    contentType: "video/mp4",
  };
  const replacementInput = {
    sourceUrl: "https://media.example.test/replacement.mp4",
    cacheKey: "replacement",
    expectedSize: 8,
    contentType: "video/mp4",
  };
  const leasedReady = await waitForReady(leasedCache, leasedTarget, leasedInput);
  const lease = leasedCache.acquire(leasedReady.mediaUrl ?? "");
  assert.ok(lease);
  await assert.rejects(
    leasedCache.prepare(leasedTarget, replacementInput),
    /media_cache_capacity_exceeded/u,
    "when all evictable files are being played, capacity exhaustion must be reported",
  );
  assert.ok(
    leasedCache.open(leasedReady.mediaUrl ?? ""),
    "the original capability must stay available during active playback",
  );
  lease.release();
  await waitForReady(leasedCache, leasedTarget, replacementInput);
  assert.equal(
    leasedCache.open(leasedReady.mediaUrl ?? ""),
    undefined,
    "the file becomes eligible for LRU only after the response ends",
  );

  let retryRequests = 0;
  const retryCache = new McpAppMediaCache({
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => {
      retryRequests += 1;
      if (retryRequests === 1) return new Response("temporary failure", { status: 503 });
      return new Response(Buffer.from("abcdefgh"), {
        status: 200,
        headers: { "content-length": "8", "content-type": "video/mp4" },
      });
    },
  });
  const retryInput = {
    sourceUrl: "https://media.example.test/retry.mp4",
    cacheKey: "retry-after-failure",
    expectedSize: 8,
    contentType: "video/mp4",
  };
  await retryCache.prepare(target, retryInput);
  await waitForError(retryCache, target, retryInput);
  const retryReady = await waitForReady(retryCache, target, retryInput);
  assert.equal(retryReady.status, "ready", "reopening after a transient download failure must re-download");
  assert.equal(retryRequests, 2);
  console.log("MCP App media cache harness passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function waitForError(
  instance: McpAppMediaCache,
  app: MountedAppTarget,
  input: {
    sourceUrl: string;
    cacheKey: string;
    expectedSize: number;
    contentType: string;
  },
): Promise<McpAppMediaCacheResult> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await instance.prepare(app, input);
    if (result.status === "error") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("media cache did not report the expected failure");
}

async function waitForReady(
  instance: McpAppMediaCache,
  app: MountedAppTarget,
  input: {
    sourceUrl: string;
    cacheKey: string;
    expectedSize: number;
    contentType: string;
  },
): Promise<McpAppMediaCacheResult> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await instance.prepare(app, input);
    if (result.status === "ready") return result;
    if (result.status === "error") assert.fail(result.error ?? "media cache failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("media cache did not become ready");
}

function withSourceDomains(targetApp: MountedAppTarget, domains: string[]): MountedAppTarget {
  return {
    ...targetApp,
    manifest: {
      ...targetApp.manifest,
      ui: {
        surface: "view",
        view: {
          protocol: "mcp-app",
          entry: "ui/index.html",
          tools: ["opengrove.app.media.cache"],
          csp: {
            connectDomains: domains,
            resourceDomains: domains,
          },
        },
      },
    },
  };
}

function lookupAddress(
  lookup: NonNullable<Awaited<ReturnType<typeof resolvePinnedPublicAddress>>["lookup"]>,
  hostname: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    lookup(hostname, { all: false }, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof address !== "string") {
        reject(new Error("pinned lookup unexpectedly returned multiple addresses"));
        return;
      }
      resolvePromise(address);
    });
  });
}
