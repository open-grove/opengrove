import type { ServerResponse } from "node:http";

export async function waitForLongPoll(
  response: ServerResponse,
  wait: (signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  try {
    await wait(controller.signal);
  } finally {
    response.off("close", abort);
  }
  return !response.destroyed && !response.writableEnded;
}
