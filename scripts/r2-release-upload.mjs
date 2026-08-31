import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { releaseProxyUrl } from "./release-network.mjs";

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MULTIPART_PART_SIZE = 16 * 1024 * 1024;
const DEFAULT_MULTIPART_QUEUE_SIZE = 4;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_VERIFY_RETRY_DELAY_MS = 1_000;
const MAX_VERIFY_RETRY_DELAY_MS = 5_000;

class R2ObjectIntegrityError extends Error {}

export async function verifyR2ReleaseAccess(input, dependencies = {}) {
  const client = dependencies.client ?? createR2Client(input, dependencies);
  try {
    await client.send(new HeadBucketCommand({ Bucket: input.bucket }));
    return { status: "authenticated" };
  } finally {
    if (!dependencies.client) client.destroy();
  }
}

export async function ensureImmutableR2Object(input, dependencies = {}) {
  const client = dependencies.client ?? createR2Client(input, dependencies);
  try {
    return await ensureImmutableR2ObjectWithClient(input, client, dependencies);
  } finally {
    if (!dependencies.client) client.destroy();
  }
}

async function ensureImmutableR2ObjectWithClient(input, client, dependencies) {
  const expectedSize = statSync(input.localPath).size;
  const expectedSha256 = normalizedSha256(input.sha256);
  const attempts = positiveSafeInteger(input.attempts ?? DEFAULT_ATTEMPTS, "R2 attempts");
  const object = {
    Bucket: input.bucket,
    Key: input.objectKey,
  };

  const existing = await readR2ObjectMetadata(client, object);
  if (existing) {
    assertExistingObject(existing, expectedSize, expectedSha256, input.objectKey);
    await verifyR2ObjectBytes(
      client,
      object,
      expectedSize,
      expectedSha256,
      input.objectKey,
      attempts,
      dependencies.wait ?? delay,
    );
    return { status: "existing", size: expectedSize };
  }

  let uploadedNow = true;
  try {
    await uploadNewObject(input, client, object, expectedSize, expectedSha256);
  } catch (error) {
    if (httpStatus(error) !== 412) throw error;
    uploadedNow = false;
  }

  const uploaded = await readR2ObjectMetadata(client, object);
  if (!uploaded) throw new Error(`R2 object is missing after conditional upload: ${input.objectKey}`);
  assertExistingObject(uploaded, expectedSize, expectedSha256, input.objectKey);
  await verifyR2ObjectBytes(
    client,
    object,
    expectedSize,
    expectedSha256,
    input.objectKey,
    attempts,
    dependencies.wait ?? delay,
  );
  return { status: uploadedNow ? "uploaded" : "existing", size: expectedSize };
}

async function uploadNewObject(input, client, object, expectedSize, expectedSha256) {
  const partSize = positiveSafeInteger(input.partSize ?? DEFAULT_MULTIPART_PART_SIZE, "R2 multipart part size");
  const params = {
    ...object,
    Body: createReadStream(input.localPath),
    ContentLength: expectedSize,
    ContentType: input.contentType,
    ContentDisposition: `attachment; filename="${safeFilename(input.filename)}"`,
    CacheControl: "public, max-age=31536000, immutable",
    IfNoneMatch: "*",
    Metadata: { sha256: expectedSha256 },
  };
  if (expectedSize <= partSize) {
    await client.send(new PutObjectCommand(params));
    return;
  }

  await new Upload({
    client,
    params,
    partSize,
    queueSize: positiveSafeInteger(input.queueSize ?? DEFAULT_MULTIPART_QUEUE_SIZE, "R2 multipart queue size"),
    leavePartsOnError: false,
  }).done();
}

function createR2Client(input, dependencies = {}) {
  const endpoint = input.endpoint ?? `https://${input.accountId}.r2.cloudflarestorage.com`;
  const proxyUrl = releaseProxyUrl(endpoint, {
    env: dependencies.env,
    execArgv: dependencies.execArgv,
  });
  const requestHandlerOptions = {
    connectionTimeout: positiveSafeInteger(
      input.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      "R2 connection timeout",
    ),
    socketTimeout: positiveSafeInteger(input.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS, "R2 socket timeout"),
    requestTimeout: positiveSafeInteger(input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "R2 request timeout"),
    throwOnRequestTimeout: true,
  };
  if (proxyUrl) {
    requestHandlerOptions.httpAgent = new HttpProxyAgent(proxyUrl);
    requestHandlerOptions.httpsAgent = new HttpsProxyAgent(proxyUrl);
  }
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    maxAttempts: positiveSafeInteger(input.attempts ?? DEFAULT_ATTEMPTS, "R2 attempts"),
    requestHandler: new NodeHttpHandler(requestHandlerOptions),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
  });
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

async function readR2ObjectMetadata(client, object) {
  try {
    const response = await client.send(new HeadObjectCommand(object));
    return {
      size: response.ContentLength,
      sha256: response.Metadata?.sha256?.toLowerCase() ?? "",
    };
  } catch (error) {
    if (httpStatus(error) === 404 || error?.name === "NotFound") return null;
    throw error;
  }
}

async function verifyR2ObjectBytes(client, object, expectedSize, expectedSha256, objectKey, attempts, wait) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyR2ObjectBytesOnce(client, object, expectedSize, expectedSha256, objectKey);
      return;
    } catch (error) {
      if (error instanceof R2ObjectIntegrityError) throw error;
      if (attempt === attempts) throw error;
      const delayMs = Math.min(MAX_VERIFY_RETRY_DELAY_MS, DEFAULT_VERIFY_RETRY_DELAY_MS * 2 ** (attempt - 1));
      console.warn(
        `R2 object readback failed for ${objectKey}: ${errorMessage(error)};` +
          ` retrying attempt ${attempt + 1}/${attempts}`,
      );
      await wait(delayMs);
    }
  }
}

async function verifyR2ObjectBytesOnce(client, object, expectedSize, expectedSha256, objectKey) {
  const response = await client.send(new GetObjectCommand(object));
  if (!response.Body) throw new Error(`R2 object has no response body: ${objectKey}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.Body) {
    size += chunk.length;
    hash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (size !== expectedSize || sha256 !== expectedSha256) {
    throw new R2ObjectIntegrityError(
      `R2 object verification failed at ${objectKey}: expected ${expectedSize} bytes / ${expectedSha256},` +
        ` got ${size} bytes / ${sha256}`,
    );
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assertExistingObject(actual, expectedSize, expectedSha256, objectKey) {
  if (actual.size !== expectedSize || actual.sha256 !== expectedSha256) {
    throw new Error(
      `R2 immutable object conflict at ${objectKey}: expected ${expectedSize} bytes / ${expectedSha256},` +
        ` got ${actual.size ?? "unknown"} bytes / ${actual.sha256 || "missing sha256 metadata"}`,
    );
  }
}

function httpStatus(error) {
  return error && typeof error === "object" && "$metadata" in error ? error.$metadata?.httpStatusCode : undefined;
}

function normalizedSha256(value) {
  if (!/^[a-f0-9]{64}$/i.test(value ?? "")) throw new Error("R2 upload requires a hexadecimal SHA-256");
  return value.toLowerCase();
}

function safeFilename(value) {
  if (!value || /["\\\r\n]/.test(value)) throw new Error("R2 upload filename is invalid");
  return value;
}
