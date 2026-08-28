import { createHash, randomBytes } from "node:crypto";
import { lookup as lookupDns } from "node:dns/promises";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { normalizeAppUi } from "../app-builder/ui-runtime.js";
import { MCP_APP_MEDIA_CACHE_WORKSPACE_DIRECTORY } from "../mcp-app-media-cache-path.js";
import type { MountedAppTarget } from "./mounted-apps.js";
import type { WorkspaceRawFileResult } from "./workspace-store.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const CACHE_DIRECTORY_SEGMENTS = MCP_APP_MEDIA_CACHE_WORKSPACE_DIRECTORY.split("/");
const MEDIA_ROUTE_PREFIX = "/mcp-app-media/";
const MEDIA_PUBLIC_PREFIX = "./mcp-app-media/";
const PUBLIC_DOH_ORIGIN = "https://cloudflare-dns.com";
const PUBLIC_DOH_ADDRESS: MediaSourceAddress = { address: "1.1.1.1", family: 4 };

export interface McpAppMediaCacheInput {
  sourceUrl: string;
  cacheKey: string;
  expectedSize: number;
  contentType: string;
}

export interface McpAppMediaCacheResult {
  status: "downloading" | "ready" | "error";
  cachedBytes: number;
  expectedSize: number;
  mediaUrl?: string;
  workspacePath?: string;
  error?: string;
}

export interface McpAppMediaLease {
  rawFile: WorkspaceRawFileResult;
  release: () => void;
}

export interface McpAppMediaCacheCleanupResult {
  removedFiles: number;
  retainedFiles: number;
  reclaimedBytes: number;
}

interface DownloadJob {
  cachedBytes: number;
  expectedSize: number;
}

interface FailedDownload {
  error: string;
  expectedSize: number;
}

interface MediaCapability {
  absolutePath: string;
  fileName: string;
  contentType: string;
}

interface McpAppMediaCacheOptions {
  maxBytes?: number;
  fetch?: MediaSourceFetch;
  resolveAddresses?: MediaSourceAddressResolver;
  resolvePublicAddresses?: MediaSourceAddressResolver;
}

export interface MediaSourceAddress {
  address: string;
  family: 4 | 6;
}

export type MediaSourceAddressResolver = (hostname: string) => Promise<MediaSourceAddress[]>;

export interface PinnedPublicAddress extends MediaSourceAddress {
  lookup: LookupFunction;
}

type MediaSourceFetch = (input: string, init: RequestInit & { dispatcher: Agent }) => Promise<Response>;

export class McpAppMediaCache {
  private readonly maxBytes: number;
  private readonly fetch: MediaSourceFetch;
  private readonly resolveAddresses: MediaSourceAddressResolver;
  private readonly resolvePublicAddresses: MediaSourceAddressResolver;
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly failures = new Map<string, FailedDownload>();
  private readonly capabilities = new Map<string, MediaCapability>();
  private readonly tokenByPath = new Map<string, string>();
  private readonly reservations = new Map<string, Map<string, number>>();
  private readonly activeLeases = new Map<string, number>();

  constructor(options: McpAppMediaCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetch =
      options.fetch ??
      (async (input, init) =>
        (await undiciFetch(
          input,
          init as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>,
        )) as unknown as Response);
    this.resolveAddresses = options.resolveAddresses ?? resolveMediaSourceAddresses;
    this.resolvePublicAddresses = options.resolvePublicAddresses ?? resolvePublicMediaSourceAddresses;
  }

  async prepare(target: MountedAppTarget, input: McpAppMediaCacheInput): Promise<McpAppMediaCacheResult> {
    const source = validateInput(target, input, this.maxBytes);
    const cacheDirectory = join(target.workspaceRoot, ...CACHE_DIRECTORY_SEGMENTS);
    mkdirSync(cacheDirectory, { recursive: true });
    const fileName = cacheFileName(input.cacheKey, input.contentType);
    const absolutePath = join(cacheDirectory, fileName);
    const workspacePath = `${MCP_APP_MEDIA_CACHE_WORKSPACE_DIRECTORY}/${fileName}`;

    const existing = this.existingResult(absolutePath, workspacePath, input);
    if (existing) return existing;

    const pinnedAddress = await resolvePinnedPublicAddress(
      unwrapIpv6Hostname(source.hostname),
      this.resolveAddresses,
      this.resolvePublicAddresses,
    );
    const raced = this.existingResult(absolutePath, workspacePath, input);
    if (raced) return raced;
    rmSync(`${absolutePath}.part`, { force: true });
    this.reserveCapacity(cacheDirectory, absolutePath, input.expectedSize);
    let dispatcher: Agent;
    try {
      dispatcher = new Agent({ connect: { lookup: pinnedAddress.lookup } });
    } catch (error) {
      this.releaseReservation(cacheDirectory, absolutePath);
      throw error;
    }
    const nextJob = { cachedBytes: 0, expectedSize: input.expectedSize };
    this.jobs.set(absolutePath, nextJob);
    void this.download(cacheDirectory, absolutePath, input, nextJob, dispatcher)
      .catch((error) => {
        this.failures.set(absolutePath, {
          error: error instanceof Error ? error.message : String(error),
          expectedSize: input.expectedSize,
        });
      })
      .finally(() => this.jobs.delete(absolutePath));
    return {
      status: "downloading",
      cachedBytes: 0,
      expectedSize: input.expectedSize,
    };
  }

  open(mediaUrl: string): WorkspaceRawFileResult | undefined {
    const prefix = mediaUrl.startsWith(MEDIA_ROUTE_PREFIX)
      ? MEDIA_ROUTE_PREFIX
      : mediaUrl.startsWith(MEDIA_PUBLIC_PREFIX)
        ? MEDIA_PUBLIC_PREFIX
        : undefined;
    if (!prefix) return undefined;
    const token = mediaUrl.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]{20,}$/u.test(token)) return undefined;
    const capability = this.capabilities.get(token);
    if (!capability || !existsSync(capability.absolutePath)) {
      if (capability) this.revokePath(capability.absolutePath);
      return undefined;
    }
    const stat = statSync(capability.absolutePath);
    if (!stat.isFile()) return undefined;
    touch(capability.absolutePath);
    return {
      entry: {
        name: capability.fileName,
        path: capability.fileName,
        kind: "file",
        size: stat.size,
        mimeType: capability.contentType,
        updatedAt: stat.mtime.toISOString(),
      },
      absolutePath: capability.absolutePath,
    };
  }

  acquire(mediaUrl: string): McpAppMediaLease | undefined {
    const rawFile = this.open(mediaUrl);
    if (!rawFile) return undefined;
    const absolutePath = rawFile.absolutePath;
    this.activeLeases.set(absolutePath, (this.activeLeases.get(absolutePath) ?? 0) + 1);
    let released = false;
    return {
      rawFile,
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.activeLeases.get(absolutePath) ?? 1) - 1;
        if (remaining > 0) this.activeLeases.set(absolutePath, remaining);
        else this.activeLeases.delete(absolutePath);
      },
    };
  }

  clearWorkspaceCaches(workspaceRoots: readonly string[]): McpAppMediaCacheCleanupResult {
    const result: McpAppMediaCacheCleanupResult = { removedFiles: 0, retainedFiles: 0, reclaimedBytes: 0 };
    const visited = new Set<string>();
    for (const workspaceRoot of workspaceRoots) {
      const root = resolve(workspaceRoot);
      const cacheParent = join(root, CACHE_DIRECTORY_SEGMENTS[0]!);
      const cacheDirectory = join(root, ...CACHE_DIRECTORY_SEGMENTS);
      if (visited.has(cacheDirectory)) continue;
      visited.add(cacheDirectory);
      if (!isOrdinaryDirectory(cacheParent) || !isOrdinaryDirectory(cacheDirectory)) continue;
      for (const entry of readdirSync(cacheDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          result.retainedFiles += 1;
          continue;
        }
        const absolutePath = join(cacheDirectory, entry.name);
        const destination = entry.name.endsWith(".part") ? absolutePath.slice(0, -".part".length) : absolutePath;
        if (this.cacheFileIsActive(destination)) {
          result.retainedFiles += 1;
          continue;
        }
        try {
          const bytes = lstatSync(absolutePath).size;
          rmSync(absolutePath, { force: false });
          result.removedFiles += 1;
          result.reclaimedBytes += bytes;
          this.failures.delete(destination);
          this.revokePath(destination);
        } catch {
          result.retainedFiles += 1;
        }
      }
    }
    return result;
  }

  private existingResult(
    absolutePath: string,
    workspacePath: string,
    input: McpAppMediaCacheInput,
  ): McpAppMediaCacheResult | undefined {
    if (isCompleteFile(absolutePath, input.expectedSize)) {
      touch(absolutePath);
      this.failures.delete(absolutePath);
      return {
        status: "ready",
        cachedBytes: input.expectedSize,
        expectedSize: input.expectedSize,
        mediaUrl: this.issueCapability(absolutePath, input.contentType),
        workspacePath,
      };
    }
    const job = this.jobs.get(absolutePath);
    if (job) {
      return {
        status: "downloading",
        cachedBytes: job.cachedBytes,
        expectedSize: job.expectedSize,
      };
    }
    const failed = this.failures.get(absolutePath);
    if (!failed) return undefined;
    this.failures.delete(absolutePath);
    return {
      status: "error",
      cachedBytes: 0,
      expectedSize: failed.expectedSize,
      error: failed.error,
    };
  }

  private async download(
    cacheDirectory: string,
    absolutePath: string,
    input: McpAppMediaCacheInput,
    job: DownloadJob,
    dispatcher: Agent,
  ): Promise<void> {
    const partialPath = `${absolutePath}.part`;
    rmSync(partialPath, { force: true });
    try {
      const response = await this.fetch(input.sourceUrl, {
        method: "GET",
        headers: { Origin: "null", Range: "bytes=0-" },
        redirect: "error",
        signal: AbortSignal.timeout(30 * 60 * 1000),
        dispatcher,
      });
      if (!response.ok || ![200, 206].includes(response.status) || !response.body) {
        throw new Error(`media_download_http_${response.status}`);
      }
      if (response.status === 206) {
        const match = response.headers.get("content-range")?.match(/^bytes 0-(\d+)\/(\d+)$/u);
        if (!match || Number(match[1]) + 1 !== input.expectedSize || Number(match[2]) !== input.expectedSize) {
          throw new Error("media_download_range_mismatch");
        }
      }
      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength !== input.expectedSize) {
        throw new Error("media_download_size_mismatch");
      }
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          job.cachedBytes += chunk.byteLength;
          if (job.cachedBytes > input.expectedSize) {
            callback(new Error("media_download_size_mismatch"));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        counter,
        createWriteStream(partialPath, { flags: "wx" }),
      );
      if (job.cachedBytes !== input.expectedSize) {
        throw new Error("media_download_size_mismatch");
      }
      renameSync(partialPath, absolutePath);
      this.failures.delete(absolutePath);
    } finally {
      rmSync(partialPath, { force: true });
      this.releaseReservation(cacheDirectory, absolutePath);
      await dispatcher.destroy();
    }
  }

  private reserveCapacity(cacheDirectory: string, destination: string, expectedSize: number): void {
    const reservations = this.reservations.get(cacheDirectory) ?? new Map<string, number>();
    const reservedBytes = [...reservations.values()].reduce((total, bytes) => total + bytes, 0);
    const activePartialPaths = new Set([...reservations.keys()].map((path) => `${path}.part`));
    const files = readdirSync(cacheDirectory)
      .flatMap((name) => {
        const absolutePath = join(cacheDirectory, name);
        try {
          const stat = statSync(absolutePath);
          return stat.isFile()
            ? [{ absolutePath, size: stat.size, mtimeMs: stat.mtimeMs, partial: name.endsWith(".part") }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    let occupiedBytes = files.reduce(
      (total, file) => (activePartialPaths.has(file.absolutePath) ? total : total + file.size),
      0,
    );
    for (const file of files) {
      if (occupiedBytes + reservedBytes + expectedSize <= this.maxBytes) break;
      const reservedPath = file.partial ? file.absolutePath.slice(0, -".part".length) : file.absolutePath;
      if (
        reservedPath === destination ||
        reservations.has(reservedPath) ||
        this.jobs.has(reservedPath) ||
        this.activeLeases.has(reservedPath)
      )
        continue;
      rmSync(file.absolutePath, { force: true });
      occupiedBytes -= file.size;
      if (!file.partial) this.revokePath(file.absolutePath);
    }
    if (occupiedBytes + reservedBytes + expectedSize > this.maxBytes) {
      throw new Error("media_cache_capacity_exceeded");
    }
    reservations.set(destination, expectedSize);
    this.reservations.set(cacheDirectory, reservations);
  }

  private releaseReservation(cacheDirectory: string, destination: string): void {
    const reservations = this.reservations.get(cacheDirectory);
    if (!reservations) return;
    reservations.delete(destination);
    if (reservations.size === 0) this.reservations.delete(cacheDirectory);
  }

  private cacheFileIsActive(destination: string): boolean {
    if (this.jobs.has(destination) || this.activeLeases.has(destination)) return true;
    return [...this.reservations.values()].some((reservations) => reservations.has(destination));
  }

  private issueCapability(absolutePath: string, contentType: string): string {
    const existing = this.tokenByPath.get(absolutePath);
    if (existing && this.capabilities.has(existing)) return `${MEDIA_PUBLIC_PREFIX}${existing}`;
    const token = randomBytes(24).toString("base64url");
    this.tokenByPath.set(absolutePath, token);
    this.capabilities.set(token, {
      absolutePath,
      fileName: absolutePath.split(/[\\/]/u).pop() || "media",
      contentType,
    });
    return `${MEDIA_PUBLIC_PREFIX}${token}`;
  }

  private revokePath(absolutePath: string): void {
    const token = this.tokenByPath.get(absolutePath);
    if (token) this.capabilities.delete(token);
    this.tokenByPath.delete(absolutePath);
  }
}

export const mcpAppMediaCache = new McpAppMediaCache();

function validateInput(target: MountedAppTarget, input: McpAppMediaCacheInput, maxBytes: number): URL {
  if (!input.cacheKey || Buffer.byteLength(input.cacheKey, "utf8") > 1_024) {
    throw new Error("media_cache_key_invalid");
  }
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1) {
    throw new Error("media_expected_size_invalid");
  }
  if (input.expectedSize > maxBytes) throw new Error("media_exceeds_cache_capacity");
  if (!/^(?:video|audio)\/[a-z0-9.+-]+$/iu.test(input.contentType)) {
    throw new Error("media_content_type_invalid");
  }
  let source: URL;
  try {
    source = new URL(input.sourceUrl);
  } catch {
    throw new Error("media_source_invalid");
  }
  if (
    source.protocol !== "https:" ||
    source.username ||
    source.password ||
    isBlockedLiteralAddress(source.hostname) ||
    !sourceAllowedByManifest(target, source)
  ) {
    throw new Error("media_source_not_allowed");
  }
  return source;
}

const BLOCKED_MEDIA_SOURCE_ADDRESSES = new BlockList();
const SYNTHETIC_PROXY_ADDRESSES = new BlockList();
SYNTHETIC_PROXY_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("192.0.0.0", 24, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("192.0.2.0", 24, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("198.51.100.0", 24, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("203.0.113.0", 24, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("224.0.0.0", 4, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("240.0.0.0", 4, "ipv4");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addAddress("::", "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addAddress("::1", "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("64:ff9b::", 96, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("64:ff9b:1::", 48, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("100::", 64, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("2001::", 23, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("2001:db8::", 32, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("2002::", 16, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("3ffe::", 16, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("fc00::", 7, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("fe80::", 10, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("fec0::", 10, "ipv6");
BLOCKED_MEDIA_SOURCE_ADDRESSES.addSubnet("ff00::", 8, "ipv6");

function isBlockedLiteralAddress(hostname: string): boolean {
  const address = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(address);
  if (family === 4) return BLOCKED_MEDIA_SOURCE_ADDRESSES.check(address, "ipv4");
  if (family === 6) return BLOCKED_MEDIA_SOURCE_ADDRESSES.check(address, "ipv6");
  return false;
}

export async function resolvePinnedPublicAddress(
  hostname: string,
  resolveAddresses: MediaSourceAddressResolver = resolveMediaSourceAddresses,
  resolvePublicAddresses?: MediaSourceAddressResolver,
): Promise<PinnedPublicAddress> {
  let addresses: MediaSourceAddress[];
  try {
    addresses = await resolveAddresses(hostname);
    if (resolvePublicAddresses && addresses.length > 0 && addresses.every(isSyntheticProxyAddress)) {
      addresses = await resolvePublicAddresses(hostname);
    }
  } catch {
    throw new Error("media_source_not_allowed");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => isIP(address) !== family || isBlockedIpAddress(address, family))
  ) {
    throw new Error("media_source_not_allowed");
  }
  const selected = addresses[0];
  if (!selected) throw new Error("media_source_not_allowed");
  return { ...selected, lookup: createPinnedLookup(selected) };
}

async function resolveMediaSourceAddresses(hostname: string): Promise<MediaSourceAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const addresses = await lookupDns(hostname, { all: true, verbatim: true });
  return addresses.flatMap(({ address, family: resolvedFamily }) =>
    resolvedFamily === 4 || resolvedFamily === 6 ? [{ address, family: resolvedFamily }] : [],
  );
}

export async function resolvePublicMediaSourceAddresses(
  hostname: string,
  fetchDns: MediaSourceFetch = async (input, init) =>
    (await undiciFetch(
      input,
      init as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>,
    )) as unknown as Response,
): Promise<MediaSourceAddress[]> {
  const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(PUBLIC_DOH_ADDRESS) } });
  try {
    const records = await Promise.all(
      ["A", "AAAA"].map(async (recordType) => {
        const query = new URL("/dns-query", PUBLIC_DOH_ORIGIN);
        query.searchParams.set("name", hostname);
        query.searchParams.set("type", recordType);
        const response = await fetchDns(query.toString(), {
          method: "GET",
          headers: { Accept: "application/dns-json" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          dispatcher,
        });
        if (!response.ok) throw new Error(`media_public_dns_http_${response.status}`);
        const payload = (await response.json()) as {
          Status?: unknown;
          Answer?: Array<{ type?: unknown; data?: unknown }>;
        };
        if (payload.Status !== 0 || !Array.isArray(payload.Answer)) return [];
        return payload.Answer.flatMap(({ type, data }) => {
          const family: 4 | 6 | undefined = type === 1 ? 4 : type === 28 ? 6 : undefined;
          return family && typeof data === "string" && isIP(data) === family ? [{ address: data, family }] : [];
        });
      }),
    );
    return records.flat();
  } finally {
    await dispatcher.destroy();
  }
}

function createPinnedLookup({ address, family }: MediaSourceAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function isBlockedIpAddress(address: string, family: 4 | 6): boolean {
  return BLOCKED_MEDIA_SOURCE_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function isSyntheticProxyAddress({ address, family }: MediaSourceAddress): boolean {
  return family === 4 && SYNTHETIC_PROXY_ADDRESSES.check(address, "ipv4");
}

function unwrapIpv6Hostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function sourceAllowedByManifest(target: MountedAppTarget, source: URL): boolean {
  const csp = normalizeAppUi(target.manifest).view?.csp;
  const declared = [...(csp?.connectDomains ?? []), ...(csp?.resourceDomains ?? [])];
  return declared.some((value) => sourceMatches(value, source));
}

function sourceMatches(value: string, source: URL): boolean {
  const wildcard = value.startsWith("https://*.");
  try {
    const declared = new URL(wildcard ? value.replace("https://*.", "https://wildcard.") : value);
    if (declared.protocol !== source.protocol || declared.port !== source.port) return false;
    if (!wildcard) return declared.hostname === source.hostname;
    const suffix = declared.hostname.replace(/^wildcard\./u, "");
    return source.hostname === suffix || source.hostname.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function cacheFileName(cacheKey: string, contentType: string): string {
  const extension = contentType.toLowerCase() === "video/mp4" ? ".mp4" : ".media";
  return `${createHash("sha256").update(cacheKey).digest("hex")}${extension}`;
}

function isCompleteFile(path: string, expectedSize: number): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size === expectedSize;
  } catch {
    return false;
  }
}

function isOrdinaryDirectory(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function touch(path: string): void {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    // non-critical-fallback: 缓存命中不应因更新时间失败而阻断播放。
  }
}
