import { spawn } from "node:child_process";

export async function runParallelTasks(label, tasks, options) {
  const results = await settleParallelTasks(label, tasks, options);
  if (results.length === 0) return [];
  const failures = parallelTaskFailures(tasks, results);
  if (failures.length > 0) {
    const detail = failures.map(({ id, reason }) => `${id}: ${errorMessage(reason)}`).join("; ");
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${label} failed: ${detail}`,
    );
  }
  return results.map((result) => result.value);
}

export async function settleParallelTasks(label, tasks, options = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const concurrency = options.concurrency ?? tasks.length;
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new TypeError(`${label} concurrency must be a positive safe integer`);
  }

  const workerCount = Math.min(concurrency, tasks.length);
  const results = new Array(tasks.length);
  let nextIndex = 0;
  console.log(`\n${label}: starting ${tasks.map((task) => task.id).join(", ")} with concurrency ${workerCount}`);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex;
        nextIndex += 1;
        const task = tasks[index];
        const startedAt = Date.now();
        try {
          const value = await task.run();
          results[index] = { status: "fulfilled", value };
          console.log(`${label}: ${task.id} completed in ${formatDuration(Date.now() - startedAt)}`);
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );

  return results;
}

export function parallelTaskFailures(tasks, results) {
  return results.flatMap((result, index) =>
    result.status === "rejected" ? [{ id: tasks[index].id, reason: result.reason }] : [],
  );
}

export function runCommand(
  command,
  args,
  { cwd, env, captureStdout = false, inheritStderr = true, allowFailure = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", captureStdout ? "pipe" : "inherit", inheritStderr ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0 || allowFailure) {
        resolve({ stdout, stderr, status, signal });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${status ?? `signal ${signal}`}` +
            (stdout ? `\n${stdout}` : "") +
            (stderr ? `\n${stderr}` : ""),
        ),
      );
    });
  });
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
