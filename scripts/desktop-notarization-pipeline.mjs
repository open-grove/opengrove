import { parallelTaskFailures, settleParallelTasks } from "./parallel-release-tasks.mjs";

export async function waitForNotarizationPipelines({
  submissions,
  refreshSubmission,
  persistState,
  onStapled = async () => {},
  once = false,
  timeoutMs,
  pollMs,
  now = Date.now,
  sleep = delay,
}) {
  if (!Array.isArray(submissions) || submissions.length === 0) {
    throw new TypeError("notarization submissions must be a non-empty array");
  }
  if (
    typeof refreshSubmission !== "function" ||
    typeof persistState !== "function" ||
    typeof onStapled !== "function"
  ) {
    throw new TypeError("notarization pipeline callbacks must be functions");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("notarization timeoutMs must be non-negative");
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError("notarization pollMs must be positive");

  const startedAt = now();
  let stopPolling = false;
  const tasks = submissions.map((item) => ({
    id: item.arch,
    run: async () => {
      try {
        while (item.status !== "Accepted" || !item.stapledAt) {
          if (stopPolling) return { pending: true };
          Object.assign(item, await refreshSubmission(item));
          await persistState();
          if (item.status === "Invalid" || item.status === "Rejected") {
            throw new Error(`${item.arch} notarization finished with status ${item.status}`);
          }
          if (item.status === "Accepted" && item.stapledAt) break;
          if (once || now() - startedAt >= timeoutMs) return { pending: true };
          console.log(`${item.arch} notarization is pending; sleeping ${pollMs / 1_000}s...`);
          await sleep(pollMs);
        }
        await onStapled(item);
        return { pending: false };
      } catch (error) {
        stopPolling = true;
        throw error;
      }
    },
  }));
  const results = await settleParallelTasks("App notarization pipelines", tasks);
  const failures = parallelTaskFailures(tasks, results);
  const pending = results.filter((result) => result.status === "fulfilled" && result.value.pending).length;
  return { failures, pending };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
