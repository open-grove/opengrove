import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const BLOB_MARKER_KEY = "$opengroveBlob";
const ESCAPED_OBJECT_KEY = "$opengroveEscapedObject";
// A 170 MB real-world OpenGrove migration balanced file count, migration
// latency, and active-state size best at 8 KiB (about 1,300 deduplicated Blobs).
const DEFAULT_BLOB_THRESHOLD_BYTES = 8 * 1024;

export type ContentBlobKind = "json" | "text";

export interface ContentBlobMetadata {
  hash: string;
  kind: ContentBlobKind;
  byteSize: number;
  storedSize: number;
  relativePath: string;
}

export interface EncodedStorageValue {
  payload: string;
  blobs: ContentBlobMetadata[];
}

interface ContentBlobReference {
  version: 1;
  hash: string;
  kind: ContentBlobKind;
  encoding: "gzip";
  byteSize: number;
  storedSize: number;
}

export class ContentBlobStore {
  readonly root: string;
  private readonly thresholdBytes: number;

  constructor(root: string, options: { thresholdBytes?: number } = {}) {
    this.root = resolve(root);
    this.thresholdBytes = Math.max(1_024, options.thresholdBytes ?? DEFAULT_BLOB_THRESHOLD_BYTES);
    mkdirSync(this.root, { recursive: true });
  }

  encode(value: unknown): EncodedStorageValue {
    const blobs = new Map<string, ContentBlobMetadata>();
    const encoded = this.encodeValue(value, blobs);
    return { payload: JSON.stringify(encoded), blobs: [...blobs.values()] };
  }

  decode(payload: string): unknown {
    return this.decodeValue(JSON.parse(payload));
  }

  delete(hash: string): boolean {
    const path = this.pathForHash(hash);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  sizeOnDisk(hash: string): number {
    const path = this.pathForHash(hash);
    return existsSync(path) ? statSync(path).size : 0;
  }

  listHashes(): string[] {
    if (!existsSync(this.root)) return [];
    const hashes = new Set<string>();
    for (const entry of readdirSync(this.root, { recursive: true, encoding: "utf8" })) {
      const match = /(?:^|[/\\])([a-f0-9]{64})\.gz$/.exec(entry);
      if (match?.[1]) hashes.add(match[1]);
    }
    return [...hashes];
  }

  private encodeValue(value: unknown, blobs: Map<string, ContentBlobMetadata>): unknown {
    if (typeof value === "string") {
      const bytes = Buffer.from(value, "utf8");
      return bytes.byteLength >= this.thresholdBytes ? this.storeReference(bytes, "text", blobs) : value;
    }
    if (!value || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      const before = blobs.size;
      const encoded = value.map((item) => this.encodeValue(item, blobs));
      if (blobs.size === before) {
        const bytes = Buffer.from(JSON.stringify(encoded), "utf8");
        if (bytes.byteLength >= this.thresholdBytes) {
          return this.storeReference(bytes, "json", blobs);
        }
      }
      return encoded;
    }

    const before = blobs.size;
    const input = value as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(input, BLOB_MARKER_KEY) ||
      Object.prototype.hasOwnProperty.call(input, ESCAPED_OBJECT_KEY)
    ) {
      return {
        [ESCAPED_OBJECT_KEY]: Object.entries(input).map(([key, child]) => [key, this.encodeValue(child, blobs)]),
      };
    }
    const encoded: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      encoded[key] = this.encodeValue(child, blobs);
    }
    if (blobs.size === before) {
      const bytes = Buffer.from(JSON.stringify(encoded), "utf8");
      if (bytes.byteLength >= this.thresholdBytes) {
        return this.storeReference(bytes, "json", blobs);
      }
    }
    return encoded;
  }

  private decodeValue(value: unknown): unknown {
    const escaped = readEscapedObject(value);
    if (escaped) {
      return Object.fromEntries(escaped.map(([key, child]) => [key, this.decodeValue(child)]));
    }
    const reference = readBlobReference(value);
    if (reference) {
      const compressed = readFileSync(this.pathForHash(reference.hash));
      const bytes = gunzipSync(compressed);
      const actualHash = contentHash(reference.kind, bytes);
      if (actualHash !== reference.hash || bytes.byteLength !== reference.byteSize) {
        throw new Error(`state_blob_integrity_error: ${reference.hash}`);
      }
      const decoded = reference.kind === "text" ? bytes.toString("utf8") : JSON.parse(bytes.toString("utf8"));
      return this.decodeValue(decoded);
    }
    if (Array.isArray(value)) return value.map((item) => this.decodeValue(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, this.decodeValue(child)]),
    );
  }

  private storeReference(
    bytes: Buffer,
    kind: ContentBlobKind,
    blobs: Map<string, ContentBlobMetadata>,
  ): { [BLOB_MARKER_KEY]: ContentBlobReference } {
    const hash = contentHash(kind, bytes);
    let metadata = blobs.get(hash);
    if (!metadata) {
      const path = this.pathForHash(hash);
      if (!existsSync(path)) {
        const compressed = gzipSync(bytes, { level: 6 });
        mkdirSync(dirname(path), { recursive: true });
        const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tempPath, compressed);
        renameSync(tempPath, path);
      }
      metadata = {
        hash,
        kind,
        byteSize: bytes.byteLength,
        storedSize: statSync(path).size,
        relativePath: relative(this.root, path),
      };
      blobs.set(hash, metadata);
    }
    return {
      [BLOB_MARKER_KEY]: {
        version: 1,
        hash: metadata.hash,
        kind: metadata.kind,
        encoding: "gzip",
        byteSize: metadata.byteSize,
        storedSize: metadata.storedSize,
      },
    };
  }

  private pathForHash(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid_state_blob_hash");
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.gz`);
  }
}

function contentHash(kind: ContentBlobKind, bytes: Buffer): string {
  return createHash("sha256").update(kind).update("\0").update(bytes).digest("hex");
}

function readBlobReference(value: unknown): ContentBlobReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1) return undefined;
  const candidate = record[BLOB_MARKER_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const reference = candidate as Partial<ContentBlobReference>;
  if (
    reference.version !== 1 ||
    (reference.kind !== "json" && reference.kind !== "text") ||
    reference.encoding !== "gzip" ||
    typeof reference.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(reference.hash) ||
    typeof reference.byteSize !== "number" ||
    typeof reference.storedSize !== "number"
  )
    return undefined;
  return reference as ContentBlobReference;
}

function readEscapedObject(value: unknown): Array<[string, unknown]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record[ESCAPED_OBJECT_KEY])) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const entry of record[ESCAPED_OBJECT_KEY]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") return undefined;
    entries.push([entry[0], entry[1]]);
  }
  return entries;
}
