import { createReadStream } from "node:fs";

const MASK_64 = 0xffff_ffff_ffff_ffffn;
const REFLECTED_POLYNOMIAL = 0xc96c_5795_d787_0f42n;
const CRC64_XZ_TABLE = buildTable();

export function crc64Xz(bytes) {
  let crc = MASK_64;
  for (const byte of bytes) {
    const index = Number((crc ^ BigInt(byte)) & 0xffn);
    crc = CRC64_XZ_TABLE[index] ^ (crc >> 8n);
  }
  return ((crc ^ MASK_64) & MASK_64).toString(10);
}

export function crc64XzFile(path) {
  return new Promise((resolveHash, reject) => {
    let crc = MASK_64;
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      for (const byte of chunk) {
        const index = Number((crc ^ BigInt(byte)) & 0xffn);
        crc = CRC64_XZ_TABLE[index] ^ (crc >> 8n);
      }
    });
    stream.on("end", () => resolveHash(((crc ^ MASK_64) & MASK_64).toString(10)));
  });
}

function buildTable() {
  return Array.from({ length: 256 }, (_, value) => {
    let crc = BigInt(value);
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1n) === 1n ? (crc >> 1n) ^ REFLECTED_POLYNOMIAL : crc >> 1n;
    }
    return crc & MASK_64;
  });
}
