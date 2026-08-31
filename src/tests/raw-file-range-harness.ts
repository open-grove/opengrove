import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { sendRawFileResponse } from "../server/raw-file-response.js";
import { LocalFilesystemWorkspaceStore } from "../server/workspace-store.js";

// Unix 直接数进程文件描述符；Windows 用独占打开验证目标文件本身是否仍被占用。
const FILE_DESCRIPTOR_DIR = "/dev/fd";
// Node 24 的数字 open flag 会原样传给内置 libuv；Windows 的 UV_FS_O_EXLOCK 会把 CreateFile share mode 设为 0。
// 这是测试专用的内部接缝：若 Node/libuv 将来改值，下面的 pre-busy 自校准会明确失败，不会静默假绿。
const WINDOWS_UV_FS_O_EXLOCK = 0x10000000;

const tempRoot = mkdtempSync(join(tmpdir(), "opengrove-raw-range-"));
const workspaceRoot = join(tempRoot, "workspace");
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(workspaceRoot, "clip.mp4"), Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz"));
// 大到一次塞不进内核缓冲区，客户端不消费时服务端必然停在背压上——复现"读流被遗弃"的前提。
const largeFilePath = join(workspaceRoot, "large.bin");
writeFileSync(largeFilePath, Buffer.alloc(32 * 1024 * 1024));

const store = new LocalFilesystemWorkspaceStore();
const scope = { kind: "local" as const, appId: "range-harness", root: workspaceRoot };
const abandonedResponseClosures: Promise<void>[] = [];
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const rawFile = store.openRawFile(scope, requestUrl.pathname.replace(/^\//u, ""));
  if (!rawFile) {
    response.writeHead(404).end();
    return;
  }
  if (requestUrl.pathname === "/large.bin") {
    abandonedResponseClosures.push(once(response, "close").then(() => undefined));
  }
  sendRawFileResponse(request, response, rawFile, {
    download: requestUrl.searchParams.get("download") === "1",
  });
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/clip.mp4`;

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-disposition"), null);
  assert.equal(await full.text(), "0123456789abcdefghijklmnopqrstuvwxyz");

  const download = await fetch(`${url}?download=1`);
  assert.equal(download.status, 200);
  assert.equal(
    download.headers.get("content-disposition"),
    `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
  );
  assert.equal(await download.text(), "0123456789abcdefghijklmnopqrstuvwxyz");

  const partial = await fetch(url, { headers: { Range: "bytes=10-19" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 10-19/36");
  assert.equal(partial.headers.get("content-length"), "10");
  assert.equal(await partial.text(), "abcdefghij");

  const suffix = await fetch(url, { headers: { Range: "bytes=-4" } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 32-35/36");
  assert.equal(await suffix.text(), "wxyz");

  const unsatisfiable = await fetch(url, { headers: { Range: "bytes=99-100" } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), "bytes */36");

  // 客户端中途断开时，pipe 只解绑读流、不销毁它。少了显式销毁，读流会带着文件句柄
  // 永远停在背压上，只有重启进程才归还——桌面端连接组被占满就是这么攒出来的。
  const abandonCount = 8;
  const descriptorsBefore = existsSync(FILE_DESCRIPTOR_DIR) ? await stableFileDescriptorCount() : undefined;
  for (let index = 0; index < abandonCount; index += 1) {
    await abandonMidStream(
      `http://127.0.0.1:${address.port}/large.bin`,
      index === 0 && process.platform === "win32"
        ? async () => {
            assert.equal(
              await probeWindowsExclusiveFileAccess(largeFilePath, 0),
              "busy",
              "Windows file probe must first prove the target file being read cannot be opened exclusively",
            );
          }
        : undefined,
    );
  }
  assert.equal(abandonedResponseClosures.length, abandonCount);
  await Promise.all(abandonedResponseClosures);

  if (descriptorsBefore !== undefined) {
    const descriptorsAfter = await stableFileDescriptorCount();
    const descriptorDelta = descriptorsAfter - descriptorsBefore;
    assert.ok(
      descriptorDelta >= -1,
      `file descriptor baseline drifted by ${descriptorDelta}; cannot reliably tell whether the media read stream leaked`,
    );
    assert.ok(
      descriptorDelta <= 1,
      `read stream must be destroyed after client disconnect: ${abandonCount} mid-stream aborts grew file descriptors by ${descriptorDelta}`,
    );
  } else {
    assert.equal(
      process.platform,
      "win32",
      `current platform lacks ${FILE_DESCRIPTOR_DIR} and has no file handle probe`,
    );
    assert.equal(
      await probeWindowsExclusiveFileAccess(largeFilePath, 5_000),
      "released",
      `read stream must be destroyed after client disconnect: target file still cannot be opened exclusively after ${abandonCount} mid-stream aborts`,
    );
  }

  console.log("Raw file range harness passed.");
} finally {
  server.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function abandonMidStream(target: string, whilePaused?: () => Promise<void>): Promise<void> {
  const clientRequest = httpRequest(target, {
    agent: false,
    headers: { Range: "bytes=0-33554431" },
  });
  clientRequest.on("error", () => {});
  clientRequest.end();
  const [response] = (await once(clientRequest, "response")) as [IncomingMessage];
  assert.equal(response.statusCode, 206, "abort reproduction must go through the real Range response path");
  response.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    response.once("data", (chunk: Buffer) => {
      response.pause();
      assert.ok(chunk.length > 0, "must actually receive media file content before aborting");
      resolve();
    });
    response.once("error", reject);
  });
  try {
    await whilePaused?.();
  } finally {
    clientRequest.destroy();
    response.destroy();
  }
}

async function probeWindowsExclusiveFileAccess(
  filePath: string,
  waitMilliseconds: number,
): Promise<"busy" | "released"> {
  const deadline = Date.now() + waitMilliseconds;
  do {
    try {
      const handle = await open(filePath, WINDOWS_UV_FS_O_EXLOCK);
      try {
        return "released";
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY") {
        throw error;
      }
    }
    if (Date.now() >= deadline) return "busy";
    await delay(25);
  } while (true);
}

async function stableFileDescriptorCount(): Promise<number> {
  const deadline = Date.now() + 2_000;
  let previous: number | undefined;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const current = readdirSync(FILE_DESCRIPTOR_DIR).length;
    stableSamples = current === previous ? stableSamples + 1 : 1;
    if (stableSamples >= 3) return current;
    previous = current;
    await delay(25);
  }
  throw new Error("文件描述符数在 2 秒内没有稳定，无法可靠判断文件流是否泄漏");
}
