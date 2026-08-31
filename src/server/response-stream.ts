import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";

/**
 * Pipe a response body while keeping ownership of the source stream explicit.
 * Node's pipe cleanup only detaches a closed destination; without this close
 * handler a backpressured file stream can keep its descriptor indefinitely.
 */
export function pipeResponseStream(stream: Readable, response: ServerResponse): void {
  stream.once("error", () => {
    if (!response.destroyed) response.end();
  });
  response.once("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(response);
}
