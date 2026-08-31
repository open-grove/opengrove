import { promisify } from "node:util";
import { deflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";

const deflateRawAsync = promisify(deflateRaw);

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  modifiedAt?: Date;
}

export function createZipArchive(entries: ZipEntry[]): Buffer {
  return assembleZipArchive(
    entries.map((entry) => prepareZipEntry(entry, deflateRawSync(entryBytes(entry), { level: 6 }))),
  );
}

export async function createZipArchiveAsync(entries: ZipEntry[]): Promise<Buffer> {
  const prepared: PreparedZipEntry[] = [];
  for (const entry of entries) {
    const source = entryBytes(entry);
    prepared.push(prepareZipEntry(entry, await deflateRawAsync(source, { level: 6 }), source));
  }
  return assembleZipArchive(prepared);
}

interface PreparedZipEntry {
  name: Buffer;
  source: Buffer;
  compressed: Buffer;
  method: number;
  checksum: number;
  time: number;
  date: number;
}

function entryBytes(entry: ZipEntry): Buffer {
  return Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
}

function prepareZipEntry(entry: ZipEntry, deflated: Buffer, source = entryBytes(entry)): PreparedZipEntry {
  const compressed = deflated.length < source.length ? deflated : source;
  const { time, date } = dosTimestamp(entry.modifiedAt ?? new Date());
  return {
    name: Buffer.from(normalizeEntryName(entry.name), "utf8"),
    source,
    compressed,
    method: compressed === deflated ? 8 : 0,
    checksum: crc32(source),
    time,
    date,
  };
}

function assembleZipArchive(entries: PreparedZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(entry.method, 8);
    localHeader.writeUInt16LE(entry.time, 10);
    localHeader.writeUInt16LE(entry.date, 12);
    localHeader.writeUInt32LE(entry.checksum, 14);
    localHeader.writeUInt32LE(entry.compressed.length, 18);
    localHeader.writeUInt32LE(entry.source.length, 22);
    localHeader.writeUInt16LE(entry.name.length, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(entry.method, 10);
    centralHeader.writeUInt16LE(entry.time, 12);
    centralHeader.writeUInt16LE(entry.date, 14);
    centralHeader.writeUInt32LE(entry.checksum, 16);
    centralHeader.writeUInt32LE(entry.compressed.length, 20);
    centralHeader.writeUInt32LE(entry.source.length, 24);
    centralHeader.writeUInt16LE(entry.name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localHeader, entry.name, entry.compressed);
    centralParts.push(centralHeader, entry.name);
    localOffset += localHeader.length + entry.name.length + entry.compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readZipArchiveForTest(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function normalizeEntryName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("diagnostic_zip_entry_invalid");
  }
  return normalized;
}

function dosTimestamp(value: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});
