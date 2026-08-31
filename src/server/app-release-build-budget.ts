import { performance } from "node:perf_hooks";

const DEFAULT_APP_RELEASE_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;

export interface AppReleaseBuildBudget {
  checkpoint(): void;
  remainingMs(): number;
}

export function createAppReleaseBuildBudget(input: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): AppReleaseBuildBudget {
  const timeoutMs = normalizedAppReleaseBuildTimeout(input.timeoutMs);
  const deadline = performance.now() + timeoutMs;
  const checkpoint = (): void => {
    if (input.signal?.aborted) {
      throw new Error("app_release_local_build_cancelled");
    }
    if (performance.now() >= deadline) {
      throw new Error("app_release_local_build_timed_out");
    }
  };
  return {
    checkpoint,
    remainingMs(): number {
      checkpoint();
      return Math.max(1, Math.ceil(deadline - performance.now()));
    },
  };
}

function normalizedAppReleaseBuildTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_APP_RELEASE_BUILD_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("app_release_local_build_timeout_invalid");
  }
  return Math.max(10, Math.min(DEFAULT_APP_RELEASE_BUILD_TIMEOUT_MS, Math.floor(value)));
}
