import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";

export interface BoundedLogOptions {
  maxBytes: number;
  retainedFiles: number;
}

export class BoundedLogWriter {
  private stream: WriteStream | undefined;
  private bytes: number;
  private queue = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly options: BoundedLogOptions,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    rotateLogIfOversized(path, options);
    this.bytes = fileBytes(path);
  }

  append(text: string): void {
    this.queue = this.queue.then(() => this.appendQueued(text)).catch((error) => this.onError(error));
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async appendQueued(text: string): Promise<void> {
    const encodedBytes = Buffer.byteLength(text, "utf8");
    if (this.bytes + encodedBytes > this.options.maxBytes) {
      await this.closeStream();
      rotateLog(this.path, this.options);
      this.bytes = 0;
      this.stream = this.openStream();
    }
    const stream = this.stream ?? (this.stream = this.openStream());
    await new Promise<void>((resolve, reject) => {
      stream.write(text, "utf8", (error) => (error ? reject(error) : resolve()));
    });
    this.bytes += encodedBytes;
  }

  private openStream(): WriteStream {
    const stream = createWriteStream(this.path, { flags: "a" });
    stream.on("error", this.onError);
    return stream;
  }

  private async closeStream(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve, reject) => {
      stream.once("close", resolve);
      stream.once("error", reject);
      stream.end();
    });
  }
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
  } catch (error) {
    if (!isMissingPathError(error)) {
      console.warn("desktop_bounded_log_stat_failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return 0;
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
  );
}
