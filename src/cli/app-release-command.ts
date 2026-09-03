import type { OpenGroveClient } from "#client";
import type { AppReleaseProgress } from "#protocol";
import type { CompiledHostOperation } from "#protocol/compiler";
import {
  compiledHostOperation,
  findHostOperationCommand,
  prepareHostOperationCommand,
  renderHostOperationCommandHelp,
  requestHostOperation,
  type HostOperationCliOptions,
} from "./host-operation-command.js";
import { OpenGroveCliError } from "./errors.js";
import { HostOperationCliUsageError, type HostOperationDecodedCall } from "./host-operation-input.js";
import {
  HOST_OPERATION_CLI_EXIT,
  hostOperationCliError,
  hostOperationCliFailure,
  hostOperationCliSuccess,
  type HostOperationCliResult,
} from "./host-operation-output.js";

const PUBLISH_OPERATION_ID = "app.release.publish";
const STATUS_OPERATION_ID = "app.release.status";
const RECONCILE_OPERATION_ID = "app.release.reconcile";

export const APP_RELEASE_PUBLISH_DEFAULT_WAIT_TIMEOUT_SECONDS = 900;
export const APP_RELEASE_PUBLISH_DEFAULT_POLL_INTERVAL_SECONDS = 2;

const WORKFLOW_HELP = [
  "Workflow options:",
  "  --no-wait                     Return the first progress snapshot without waiting for a terminal state.",
  `  --wait-timeout <seconds>      Stop waiting after this many seconds. Default: ${APP_RELEASE_PUBLISH_DEFAULT_WAIT_TIMEOUT_SECONDS}.`,
  `  --poll-interval <seconds>     Seconds between status refreshes while waiting. Default: ${APP_RELEASE_PUBLISH_DEFAULT_POLL_INTERVAL_SECONDS}.`,
  "",
  "Workflow:",
  "  By default the command keeps refreshing `app release status` and reconciles the release",
  "  (the same automatic recovery the OpenGrove UI performs) until the release reaches a terminal",
  "  state. Exit 0 with state `published` or `closed`; exit 1 with the last progress when the",
  "  release is blocked, needs a retry, exhausts automatic recovery, or times out.",
].join("\n");

export type AppReleasePublishWaitOptions = Readonly<{
  wait: boolean;
  waitTimeoutMs: number;
  pollIntervalMs: number;
}>;

export type AppReleaseCliOptions = HostOperationCliOptions &
  Readonly<{
    /** Test seam: replaces the real clock between status refreshes. */
    sleep?: (milliseconds: number) => Promise<void>;
    /** Test seam: monotonic clock in milliseconds. */
    now?: () => number;
  }>;

export function isAppReleasePublishCommand(args: readonly string[]): boolean {
  const operation = findHostOperationCommand(args);
  return operation?.id === PUBLISH_OPERATION_ID;
}

/**
 * Mirrors the OpenGrove UI: a release is only driven automatically while
 * Release Control still expects the local side to act and the progress says a
 * retry is safe.
 */
export function appReleaseNeedsAutomaticRecovery(progress: AppReleaseProgress): boolean {
  const recoverable = progress.retryable && (progress.state === "publishing" || progress.state === "registry-ready");
  if (!recoverable) return false;
  if (progress.state === "registry-ready") return true;
  return (
    progress.remoteStatus === "awaiting_candidate" ||
    progress.remoteStatus === "artifact_accepted" ||
    progress.remoteStatus === "finalizing"
  );
}

/** Same recovery budget as the OpenGrove UI: keyed per remote transition. */
export function appReleaseAutomaticRecoveryBudget(progress: AppReleaseProgress): { key: string; limit: number } {
  return {
    key:
      progress.remoteIntentId && progress.remoteStatus
        ? `${progress.remoteIntentId}:${progress.remoteStatus}:${progress.phase}`
        : "",
    limit: progress.remoteStatus === "artifact_accepted" ? 2 : 1,
  };
}

export function isAppReleaseTerminal(progress: AppReleaseProgress): boolean {
  return progress.state === "published" || progress.state === "closed";
}

export function isAppReleaseStalled(progress: AppReleaseProgress): boolean {
  return progress.state === "blocked" || progress.state === "needs-retry";
}

export async function runAppReleasePublishCommand(
  args: readonly string[],
  options: AppReleaseCliOptions = {},
): Promise<HostOperationCliResult> {
  const publish = compiledHostOperation(PUBLISH_OPERATION_ID, options.catalog);
  if (args.includes("--help") || args.includes("-h")) {
    return {
      handled: true,
      exitCode: HOST_OPERATION_CLI_EXIT.success,
      stdout: `${renderHostOperationCommandHelp(publish)}\n\n${WORKFLOW_HELP}`,
    };
  }

  let workflow: { wait: AppReleasePublishWaitOptions; operationArgs: string[] };
  try {
    workflow = splitWorkflowOptions(args);
  } catch (error) {
    return hostOperationCliFailure(PUBLISH_OPERATION_ID, error);
  }

  const prepared = await prepareHostOperationCommand(workflow.operationArgs, options);
  if (prepared.kind === "result") return prepared.result;
  const { client, call } = prepared;

  let progress: AppReleaseProgress;
  try {
    progress = readProgress(await requestHostOperation(client, publish.operation, call));
  } catch (error) {
    return hostOperationCliFailure(PUBLISH_OPERATION_ID, error);
  }
  if (!workflow.wait.wait) {
    return hostOperationCliSuccess({ ok: true, operation: PUBLISH_OPERATION_ID, data: { ok: true, progress } });
  }
  return waitForAppRelease({
    client,
    catalog: options.catalog,
    params: call.params,
    initial: progress,
    wait: workflow.wait,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? (() => Date.now()),
  });
}

async function waitForAppRelease(input: {
  client: OpenGroveClient;
  catalog: HostOperationCliOptions["catalog"];
  params: HostOperationDecodedCall["params"];
  initial: AppReleaseProgress;
  wait: AppReleasePublishWaitOptions;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}): Promise<HostOperationCliResult> {
  const status = compiledHostOperation(STATUS_OPERATION_ID, input.catalog);
  const reconcile = compiledHostOperation(RECONCILE_OPERATION_ID, input.catalog);
  const startedAt = input.now();
  const attempts = new Map<string, number>();
  const summary = { polls: 0, reconciles: 0 };
  let progress = input.initial;
  let lastOperation: CompiledHostOperation = status;

  const finish = (): HostOperationCliResult =>
    hostOperationCliSuccess({
      ok: true,
      operation: PUBLISH_OPERATION_ID,
      data: { ok: true, progress },
      wait: { ...summary, elapsedMs: input.now() - startedAt },
    });
  const fail = (subtype: string, message: string): HostOperationCliResult =>
    hostOperationCliError(HOST_OPERATION_CLI_EXIT.api, "api", subtype, message, {
      operation: PUBLISH_OPERATION_ID,
      progress,
      wait: { ...summary, elapsedMs: input.now() - startedAt },
    });

  try {
    for (;;) {
      if (isAppReleaseTerminal(progress)) return finish();
      if (isAppReleaseStalled(progress)) {
        return fail(
          "app_release_blocked",
          `Release ${progress.version} of ${progress.appId} is ${progress.state}; inspect progress.buildFailure and progress.allowedActions, then use \`app release reconcile --retry-failed-build\` or \`app release abandon\`.`,
        );
      }
      if (appReleaseNeedsAutomaticRecovery(progress)) {
        const budget = appReleaseAutomaticRecoveryBudget(progress);
        const used = budget.key ? (attempts.get(budget.key) ?? 0) : budget.limit;
        if (used >= budget.limit) {
          return fail(
            "app_release_recovery_exhausted",
            `Release ${progress.version} of ${progress.appId} stayed at ${progress.remoteStatus ?? progress.phase} after automatic recovery; run \`app release status\` and \`app release reconcile\` manually.`,
          );
        }
        attempts.set(budget.key, used + 1);
        summary.reconciles += 1;
        lastOperation = reconcile;
        progress = readProgress(
          await requestHostOperation(input.client, reconcile.operation, {
            params: input.params,
            body: { retryFailedBuild: false },
          }),
        );
        continue;
      }
      if (input.now() - startedAt >= input.wait.waitTimeoutMs) {
        return fail(
          "app_release_wait_timeout",
          `Release ${progress.version} of ${progress.appId} did not reach a terminal state within ${Math.round(input.wait.waitTimeoutMs / 1000)}s; keep polling with \`app release status\` and reconcile when remoteStatus is awaiting_candidate, artifact_accepted, or finalizing.`,
        );
      }
      await input.sleep(input.wait.pollIntervalMs);
      summary.polls += 1;
      lastOperation = status;
      progress = readProgress(await requestHostOperation(input.client, status.operation, { params: input.params }));
    }
  } catch (error) {
    const failure = hostOperationCliFailure(lastOperation.id, error);
    return { ...failure, stderr: appendLastProgress(failure.stderr, progress) };
  }
}

function appendLastProgress(stderr: string | undefined, progress: AppReleaseProgress): string | undefined {
  if (!stderr) return stderr;
  const parsed = JSON.parse(stderr) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, lastProgress: progress }, null, 2);
}

function splitWorkflowOptions(args: readonly string[]): {
  wait: AppReleasePublishWaitOptions;
  operationArgs: string[];
} {
  const operationArgs: string[] = [];
  let wait = true;
  let waitTimeoutMs = APP_RELEASE_PUBLISH_DEFAULT_WAIT_TIMEOUT_SECONDS * 1000;
  let pollIntervalMs = APP_RELEASE_PUBLISH_DEFAULT_POLL_INTERVAL_SECONDS * 1000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const flag = arg.startsWith("--") && equals !== -1 ? arg.slice(0, equals) : arg;
    const inlineValue = arg.startsWith("--") && equals !== -1 ? arg.slice(equals + 1) : undefined;
    if (flag === "--no-wait") {
      if (inlineValue !== undefined) throw new HostOperationCliUsageError("invalid_option", "--no-wait takes no value.");
      wait = false;
      continue;
    }
    if (flag === "--wait-timeout" || flag === "--poll-interval") {
      const value = inlineValue ?? args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new HostOperationCliUsageError("missing_option_value", `${flag} requires a value in seconds.`);
      }
      if (inlineValue === undefined) index += 1;
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new HostOperationCliUsageError("invalid_option", `${flag} must be a non-negative number of seconds.`);
      }
      if (flag === "--wait-timeout") waitTimeoutMs = seconds * 1000;
      else pollIntervalMs = seconds * 1000;
      continue;
    }
    operationArgs.push(arg);
  }
  return { wait: { wait, waitTimeoutMs, pollIntervalMs }, operationArgs };
}

function readProgress(data: unknown): AppReleaseProgress {
  if (data && typeof data === "object" && "progress" in data && data.progress && typeof data.progress === "object") {
    return data.progress as AppReleaseProgress;
  }
  throw new OpenGroveCliError(
    "internal",
    "app_release_progress_missing",
    "The Bridge response did not include App release progress.",
  );
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
