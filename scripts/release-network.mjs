import { createHash } from "node:crypto";

const DEFAULT_RANGE_THRESHOLD = 16 * 1024 * 1024;
const DEFAULT_RANGE_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 60_000;

export function releaseRequestSignal(timeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  return AbortSignal.timeout(timeoutMs);
}

export function releaseVerificationProxyHosts(urlValues, { env = process.env, execArgv = process.execArgv } = {}) {
  return [
    ...new Set(
      urlValues.flatMap((value) => {
        return releaseProxyUrl(value, { env, execArgv }) ? [new URL(value).hostname] : [];
      }),
    ),
  ];
}

export function releaseProxyUrl(value, { env = process.env, execArgv = process.execArgv } = {}) {
  const envProxyEnabled = env.NODE_USE_ENV_PROXY === "1" || execArgv.includes("--use-env-proxy");
  if (!envProxyEnabled) return null;

  const url = new URL(value);
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
  if (noProxyMatches(url, noProxy)) return null;
  return (
    (url.protocol === "https:"
      ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy)
      : (env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy)) || null
  );
}

export async function readRemoteFileMetadata(url, { connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs <= 0) {
    throw new TypeError("connectionTimeoutMs must be a positive safe integer");
  }
  const request = await openRemoteResponse(
    url,
    {
      method: "HEAD",
      headers: { "accept-encoding": "identity" },
      redirect: "follow",
    },
    connectionTimeoutMs,
  );
  const response = request.response;
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  const size = contentLength(response);
  if (size === null) throw new Error(`remote HEAD response has no valid Content-Length: ${url}`);
  const rawCrc64 = response.headers.get("x-oss-hash-crc64ecma")?.trim();
  if (rawCrc64 && (!/^\d+$/.test(rawCrc64) || BigInt(rawCrc64) > 0xffff_ffff_ffff_ffffn)) {
    throw new Error(`invalid x-oss-hash-crc64ecma response header: ${url}`);
  }
  return {
    size,
    crc64: rawCrc64 ? BigInt(rawCrc64).toString(10) : undefined,
    etag: response.headers.get("etag")?.trim() || undefined,
    url: response.url || url,
  };
}

export async function hashRemoteFile(
  url,
  expectedSize,
  {
    concurrency = 1,
    rangeThreshold = DEFAULT_RANGE_THRESHOLD,
    chunkSize = DEFAULT_RANGE_CHUNK_SIZE,
    connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
    noProgressTimeoutMs = DEFAULT_NO_PROGRESS_TIMEOUT_MS,
    onProgress,
  } = {},
) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
    throw new TypeError("expectedSize must be a non-negative safe integer");
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0)
    throw new TypeError("concurrency must be a positive safe integer");
  if (!Number.isSafeInteger(rangeThreshold) || rangeThreshold < 0)
    throw new TypeError("rangeThreshold must be a non-negative safe integer");
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    throw new TypeError("chunkSize must be a positive safe integer");
  if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs <= 0)
    throw new TypeError("connectionTimeoutMs must be a positive safe integer");
  if (!Number.isSafeInteger(noProgressTimeoutMs) || noProgressTimeoutMs <= 0)
    throw new TypeError("noProgressTimeoutMs must be a positive safe integer");
  if (expectedSize < rangeThreshold || concurrency === 1) {
    return hashRemoteStream(url, expectedSize, { connectionTimeoutMs, noProgressTimeoutMs, onProgress });
  }

  const probeRequest = await openRemoteResponse(
    url,
    {
      headers: { "accept-encoding": "identity", range: "bytes=0-0" },
      redirect: "follow",
    },
    connectionTimeoutMs,
  );
  const probe = probeRequest.response;
  if (probe.status !== 206) {
    await probe.body?.cancel().catch(() => {});
    return hashRemoteStream(url, expectedSize, { connectionTimeoutMs, noProgressTimeoutMs, onProgress });
  }
  const probeBytes = await readResponseBytes(probe, undefined, {
    url,
    controller: probeRequest.controller,
    noProgressTimeoutMs,
  });
  if (probeBytes.byteLength !== 1 || probe.headers.get("content-range") !== `bytes 0-0/${expectedSize}`) {
    throw new Error(`invalid byte-range probe: HTTP ${probe.status} ${url}`);
  }

  const etag = strongEntityTag(probe.headers.get("etag"));
  if (!etag) {
    return hashRemoteStream(url, expectedSize, { connectionTimeoutMs, noProgressTimeoutMs, onProgress });
  }
  const hash = createHash("sha256");
  const reportProgress = progressReporter({
    mode: "ranges",
    rangeConcurrency: concurrency,
    totalBytes: expectedSize,
    onProgress,
  });
  let size = 0;
  let downloadedSize = 0;
  reportProgress(0, true);
  for (let windowStart = 0; windowStart < expectedSize; windowStart += chunkSize * concurrency) {
    const ranges = Array.from({ length: concurrency }, (_, index) => {
      const start = windowStart + index * chunkSize;
      if (start >= expectedSize) return null;
      return { start, end: Math.min(start + chunkSize - 1, expectedSize - 1) };
    }).filter(Boolean);
    const chunks = await Promise.all(
      ranges.map(({ start, end }) =>
        fetchRemoteRange({
          url,
          start,
          end,
          expectedSize,
          etag,
          connectionTimeoutMs,
          noProgressTimeoutMs,
          onBytes: (count) => {
            downloadedSize += count;
            reportProgress(downloadedSize, downloadedSize === expectedSize);
          },
        }),
      ),
    );
    for (const chunk of chunks) {
      size += chunk.byteLength;
      hash.update(chunk);
    }
  }

  reportProgress(downloadedSize, true);

  return { size, sha256: hash.digest("hex"), mode: "ranges" };
}

async function hashRemoteStream(url, expectedSize, { connectionTimeoutMs, noProgressTimeoutMs, onProgress } = {}) {
  const request = await openRemoteResponse(
    url,
    {
      headers: { "accept-encoding": "identity" },
      redirect: "follow",
    },
    connectionTimeoutMs,
  );
  const response = request.response;
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} ${url}`);
  }

  const hash = createHash("sha256");
  const totalBytes = contentLength(response) ?? expectedSize;
  const reportProgress = progressReporter({
    mode: "stream",
    rangeConcurrency: 1,
    totalBytes,
    onProgress,
  });
  const reader = response.body.getReader();
  let size = 0;
  reportProgress(0, true);
  while (true) {
    const { done, value } = await readWithNoProgressTimeout(reader, {
      url,
      controller: request.controller,
      noProgressTimeoutMs,
    });
    if (done) break;
    size += value.byteLength;
    hash.update(value);
    reportProgress(size, false);
  }
  reportProgress(size, true);
  return { size, sha256: hash.digest("hex"), mode: "stream" };
}

function progressReporter({ mode, rangeConcurrency, totalBytes, onProgress }) {
  if (typeof onProgress !== "function") return () => {};
  const startedAt = Date.now();
  let lastReportedAt = startedAt;
  let lastReportedBytes = 0;

  return (bytesProcessed, force) => {
    const now = Date.now();
    if (!force && now - lastReportedAt < 1_000) return;
    const elapsedMs = Math.max(1, now - startedAt);
    const intervalMs = Math.max(1, now - lastReportedAt);
    onProgress({
      mode,
      rangeConcurrency,
      bytesProcessed,
      totalBytes,
      elapsedMs,
      intervalBytesPerSecond: Math.round(((bytesProcessed - lastReportedBytes) * 1_000) / intervalMs),
      averageBytesPerSecond: Math.round((bytesProcessed * 1_000) / elapsedMs),
      completed: bytesProcessed === totalBytes,
    });
    lastReportedAt = now;
    lastReportedBytes = bytesProcessed;
  };
}

function contentLength(response) {
  const value = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function fetchRemoteRange({
  url,
  start,
  end,
  expectedSize,
  etag,
  connectionTimeoutMs,
  noProgressTimeoutMs,
  onBytes,
}) {
  const request = await openRemoteResponse(
    url,
    {
      headers: {
        "accept-encoding": "identity",
        "if-match": etag,
        range: `bytes=${start}-${end}`,
      },
      redirect: "follow",
    },
    connectionTimeoutMs,
  );
  const response = request.response;
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`remote server stopped honoring byte ranges: HTTP ${response.status} ${url}`);
  }
  if (response.headers.get("content-range") !== `bytes ${start}-${end}/${expectedSize}`) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`remote server returned an invalid Content-Range for ${url}`);
  }
  if (strongEntityTag(response.headers.get("etag")) !== etag) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`remote file changed during byte-range verification: ${url}`);
  }
  const bytes = await readResponseBytes(response, onBytes, {
    url,
    controller: request.controller,
    noProgressTimeoutMs,
  });
  if (bytes.byteLength !== end - start + 1) throw new Error(`remote byte range has the wrong size: ${url}`);
  return bytes;
}

async function readResponseBytes(response, onBytes, options) {
  if (!response.body) throw new Error(`HTTP response has no body: ${response.url}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await readWithNoProgressTimeout(reader, options);
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    onBytes?.(value.byteLength);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function openRemoteResponse(url, init, connectionTimeoutMs) {
  const controller = new AbortController();
  const timeoutError = new Error(`remote connection timed out after ${connectionTimeoutMs}ms: ${url}`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, connectionTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, controller };
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readWithNoProgressTimeout(reader, { url, controller, noProgressTimeoutMs }) {
  const timeoutError = new Error(`remote transfer timed out after ${noProgressTimeoutMs}ms without progress: ${url}`);
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, noProgressTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function strongEntityTag(value) {
  const normalized = value?.trim();
  return normalized && !/^W\//i.test(normalized) ? normalized : null;
}

function noProxyMatches(url, value) {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return value.split(",").some((rawEntry) => {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;

    let entryPort = "";
    const portSeparator = entry.lastIndexOf(":");
    if (portSeparator > 0 && entry.indexOf(":") === portSeparator) {
      entryPort = entry.slice(portSeparator + 1);
      entry = entry.slice(0, portSeparator);
    }
    if (entryPort && entryPort !== port) return false;
    const suffix = entry.replace(/^\*?\./, "");
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
}
