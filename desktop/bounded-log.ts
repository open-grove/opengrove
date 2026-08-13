import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

export interface BoundedLogOptions {
  maxBytes: number;
  retainedFiles: number;
}

export function appendBoundedLog(path: string, text: string, options: BoundedLogOptions): void {
  const encodedBytes = Buffer.byteLength(text, "utf8");
  if (fileBytes(path) + encodedBytes > options.maxBytes) rotateLog(path, options);
  appendFileSync(path, text, "utf8");
}

export function rotateLogIfOversized(path: string, options: BoundedLogOptions): void {
  if (fileBytes(path) >= options.maxBytes) rotateLog(path, options);
}

function rotateLog(path: string, options: BoundedLogOptions): void {
  const retained = Math.max(0, Math.floor(options.retainedFiles));
  if (retained === 0) {
    rmSync(path, { force: true });
    return;
  }
  rmSync(`${path}.${retained}`, { force: true });
  for (let index = retained - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  if (existsSync(path)) {
    trimLogToRecentBytes(path, options.maxBytes);
    renameSync(path, `${path}.1`);
  }
}

function trimLogToRecentBytes(path: string, maxBytes: number): void {
  const bytes = fileBytes(path);
  if (bytes <= maxBytes) return;
  const retainedBytes = Math.max(0, Math.floor(maxBytes));
  const buffer = Buffer.alloc(retainedBytes);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, buffer, 0, retainedBytes, bytes - retainedBytes);
  } finally {
    closeSync(descriptor);
  }
  writeFileSync(path, buffer);
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
