import type { ServerResponse } from "node:http";

const MAX_LONG_POLL_WAIT_MS = 25_000;

export function readLongPollWaitMs(url: URL): number {
  const requested = Number(url.searchParams.get("waitMs") ?? 0);
  if (!Number.isSafeInteger(requested) || requested <= 0) return 0;
  return Math.min(requested, MAX_LONG_POLL_WAIT_MS);
}

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
