import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeResponseStream } from "./response-stream.js";
import type { WorkspaceRawFileResult } from "./workspace-store.js";

export function sendRawFileResponse(
  request: IncomingMessage,
  response: ServerResponse,
  rawFile: WorkspaceRawFileResult,
  options: { download?: boolean; fileName?: string; head?: boolean } = {},
): void {
  const size = rawFile.entry.size ?? 0;
  const baseHeaders = {
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": rawFile.entry.mimeType ?? "application/octet-stream",
    ...(options.download ? { "content-disposition": contentDisposition(options.fileName || rawFile.entry.name) } : {}),
  };
  const rangeHeader = firstHeader(request.headers.range);
  const range = rangeHeader ? parseRangeHeader(rangeHeader, size) : undefined;

  if (rangeHeader && !range) {
    response.writeHead(416, {
      ...baseHeaders,
      "content-range": `bytes */${size}`,
    });
    response.end();
    return;
  }

  if (range) {
    response.writeHead(206, {
      ...baseHeaders,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    });
    if (options.head) {
      response.end();
      return;
    }
    pipeRawFile(response, rawFile.absolutePath, { start: range.start, end: range.end });
    return;
  }

  response.writeHead(200, {
    ...baseHeaders,
    "content-length": String(size),
  });
  if (options.head) {
    response.end();
    return;
  }
  pipeRawFile(response, rawFile.absolutePath);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseRangeHeader(rawHeader: string, size: number): { start: number; end: number } | undefined {
  if (size <= 0) return undefined;
  const match = rawHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return undefined;

  let start: number;
  let end: number;
  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    return undefined;
  }
  return { start, end: Math.min(end, size - 1) };
}

function pipeRawFile(response: ServerResponse, absolutePath: string, range?: { start: number; end: number }): void {
  pipeResponseStream(createReadStream(absolutePath, range), response);
}

function contentDisposition(fileName: string): string {
  const fallbackName =
    fileName
      .replace(/["\\\r\n]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .trim() || "download";
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
