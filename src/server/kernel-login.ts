import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { applyKernelProxyEnv, resolveKernelProxySettings } from "../runtime/kernel-proxy.js";
import { resolveCommandInvocation, resolveCommandPath } from "../kernel/discovery.js";
import type { BridgeKernelId, BridgeProviderProfile, BridgeState } from "./bridge-types.js";
import { BRIDGE_KERNEL_IDS, LOGIN_PROVIDER_BINDING_ID } from "./bridge-types.js";
import { getBridgeKernelDescriptor, readKernelLocalRouteProfile } from "./kernel-registry.js";
import { resolveKernelCommandPath } from "./kernel-selection.js";
import { kernelBinaryPathOverride, kernelConfigHome, kernelPathEnv } from "./kernel-utils.js";
import { resolveBridgeWorkspaceRoot } from "./workspace-root.js";
import { providerProfileFromLocalRoute } from "./system-provider-discovery.js";
import {
  cleanupStaleSystemTerminalRoots,
  launchSystemTerminalCommand,
  type SystemTerminalCommand,
  type SystemTerminalLaunch,
} from "./system-terminal.js";

export type BridgeKernelLoginStatus = "authenticated" | "missing" | "unknown" | "unavailable" | "provider";

export interface BridgeKernelLoginView {
  kernelId: BridgeKernelId;
  label: string;
  status: BridgeKernelLoginStatus;
  loginAvailable: boolean;
  logoutAvailable: boolean;
  providerId?: string;
  providerLabel?: string;
  message?: string;
  configuredCommand?: string;
  configuredCommandIssue?: "missing" | "failed";
}

export interface BridgeKernelLoginSession {
  id: string;
  kernelId: BridgeKernelId;
  action: "login" | "logout";
  status: "running" | "succeeded" | "failed";
  output: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

type KernelLoginCommand = {
  login: string[];
  logout?: string[];
  status?: string[];
};

const KERNEL_LOGIN_COMMANDS: Partial<Record<BridgeKernelId, KernelLoginCommand>> = {
  codex: {
    status: ["login", "status"],
    login: ["login", "--device-auth"],
    logout: ["logout"],
  },
  "claude-code": {
    status: ["auth", "status", "--json"],
    login: ["auth", "login"],
    logout: ["auth", "logout"],
  },
  kimi: {
    login: ["login"],
  },
};

interface KernelLoginSessionRecord extends BridgeKernelLoginSession {
  terminalCleanupRoot?: string;
  terminalCleanupTimer?: ReturnType<typeof setTimeout>;
  terminalResultPath?: string;
  terminalTimeoutAt?: number;
}

export interface KernelLoginActionRuntime {
  launchTerminal(command: SystemTerminalCommand): SystemTerminalLaunch;
}

const DEFAULT_LOGIN_RUNTIME: KernelLoginActionRuntime = {
  launchTerminal: (command) => launchSystemTerminalCommand(command),
};

const sessions = new Map<string, KernelLoginSessionRecord>();
const MAX_OUTPUT_LENGTH = 16_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 3_000;

export function cleanupStaleKernelLoginSessions(options: { root?: string; now?: number } = {}): void {
  cleanupStaleSystemTerminalRoots({ ...options, maxAgeMs: LOGIN_TIMEOUT_MS });
}

export async function describeKernelLogins(state: BridgeState): Promise<BridgeKernelLoginView[]> {
  const views = await Promise.all(
    BRIDGE_KERNEL_IDS.map(async (kernelId): Promise<BridgeKernelLoginView | undefined> => {
      const descriptor = getBridgeKernelDescriptor(kernelId);
      if (!descriptor.accountLogin) return undefined;
      const commands = KERNEL_LOGIN_COMMANDS[kernelId];
      const configuredCommand = kernelBinaryPathOverride(state.settings, kernelId);
      const command = resolveKernelCommandPath(state, kernelId);
      if (!commands || !command) {
        return {
          kernelId,
          label: descriptor.label,
          status: "unavailable" as const,
          loginAvailable: false,
          logoutAvailable: false,
          ...(configuredCommand
            ? {
                configuredCommand,
                configuredCommandIssue: configuredKernelCommandIssue(configuredCommand),
              }
            : {}),
        };
      }
      const claudeRoute =
        kernelId === "claude-code"
          ? readKernelLocalRouteProfile(kernelId, {
              cwd: resolveBridgeWorkspaceRoot(state.settings),
              binaryPath: command,
              refreshAuth: true,
              configHome: kernelConfigHome(state.settings, kernelId),
            })
          : undefined;
      const status =
        claudeRoute?.accountLogin?.status ??
        (commands.status
          ? await probeNativeLoginStatus(state, kernelId, command, commands.status)
          : fallbackLoginStatus(state, kernelId));
      return {
        kernelId,
        label: descriptor.label,
        status,
        loginAvailable: status !== "provider",
        logoutAvailable: status !== "provider" && Boolean(commands.logout),
        ...(status === "provider" && claudeRoute
          ? { providerId: claudeRoute.providerId, providerLabel: claudeRoute.providerLabel }
          : {}),
      };
    }),
  );
  return views.filter((view): view is BridgeKernelLoginView => Boolean(view));
}

function configuredKernelCommandIssue(command: string): "missing" | "failed" {
  return resolveCommandPath(command) ? "failed" : "missing";
}

/**
 * Runtime-only Login routes used by model and route selectors. They are never
 * persisted and never include Kernel-owned Provider configuration.
 */
export function kernelLoginRouteProfiles(state: BridgeState): BridgeProviderProfile[] {
  return BRIDGE_KERNEL_IDS.flatMap((kernelId) => {
    const descriptor = getBridgeKernelDescriptor(kernelId);
    if (!descriptor.accountLogin) return [];
    const localRoute = readKernelLocalRouteProfile(kernelId, {
      cwd: resolveBridgeWorkspaceRoot(state.settings),
      binaryPath: resolveKernelCommandPath(state, kernelId),
      configHome: kernelConfigHome(state.settings, kernelId),
    });
    if (localRoute?.routeKind !== "login" || !localRoute.authConfigured) return [];
    const materialized = providerProfileFromLocalRoute(localRoute);
    if (!materialized) return [];
    return [
      {
        ...materialized,
        id: `${LOGIN_PROVIDER_BINDING_ID}:${kernelId}`,
        source: undefined,
        sourcePaths: undefined,
        enabled: true,
        models: materialized.models.length
          ? materialized.models
          : [{ id: `${kernelId}-default`, label: `${descriptor.label} default` }],
      },
    ];
  });
}

export function startKernelLoginAction(
  state: BridgeState,
  kernelId: BridgeKernelId,
  action: "login" | "logout",
  runtime: KernelLoginActionRuntime = DEFAULT_LOGIN_RUNTIME,
): BridgeKernelLoginSession {
  const descriptor = getBridgeKernelDescriptor(kernelId);
  const commands = KERNEL_LOGIN_COMMANDS[kernelId];
  const args = commands?.[action];
  const command = descriptor.accountLogin ? resolveKernelCommandPath(state, kernelId) : undefined;
  if (!command || !args) throw new Error("kernel_login_action_unavailable");

  pruneFinishedSessions();
  const id = randomUUID();
  const session: KernelLoginSessionRecord = {
    id,
    kernelId,
    action,
    status: "running",
    output: "",
    startedAt: new Date().toISOString(),
  };
  sessions.set(id, session);

  if (action === "login") {
    try {
      const environment = kernelLoginTerminalEnvironment(state, kernelId);
      const invocation = resolveCommandInvocation(command, args, { environment: process.env });
      const terminal = runtime.launchTerminal({
        command: invocation.command,
        args: invocation.args,
        cwd: resolveBridgeWorkspaceRoot(state.settings),
        environment,
        unsetEnvironment: accountLoginExcludedCredentialKeys(kernelId),
      });
      session.terminalCleanupRoot = terminal.cleanupRoot;
      session.terminalResultPath = terminal.resultPath;
      session.terminalTimeoutAt = Date.now() + LOGIN_TIMEOUT_MS;
      session.terminalCleanupTimer = setTimeout(
        () => expireKernelLoginSessions(session.terminalTimeoutAt),
        LOGIN_TIMEOUT_MS,
      );
      session.terminalCleanupTimer.unref?.();
      terminal.launcher.once("error", (error) => {
        finishSession(session, "failed", error.message);
        cleanupTerminalSession(session);
      });
      terminal.launcher.once("close", (code) => {
        if (code === 0 || session.status !== "running" || existsSync(terminal.resultPath)) return;
        finishSession(session, "failed", `kernel_login_terminal_exited:${code ?? "unknown"}`);
        cleanupTerminalSession(session);
      });
    } catch (error) {
      finishSession(session, "failed", error instanceof Error ? error.message : String(error));
      cleanupTerminalSession(session);
    }
    return publicLoginSession(session);
  }

  const invocation = resolveCommandInvocation(command, args, { environment: process.env });
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: kernelLoginEnvironment(state, kernelId),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    finishSession(session, "failed", "kernel_login_timed_out");
  }, LOGIN_TIMEOUT_MS);
  let rawOutput = "";
  const append = (chunk: Buffer | string) => {
    rawOutput = limitLoginOutput(rawOutput + String(chunk));
    session.output = sanitizeLoginOutput(rawOutput);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", (error) => {
    clearTimeout(timeout);
    finishSession(session, "failed", error.message);
  });
  child.once("close", (code) => {
    clearTimeout(timeout);
    if (session.status !== "running") return;
    finishSession(
      session,
      code === 0 ? "succeeded" : "failed",
      code === 0 ? undefined : `kernel_login_exited:${code ?? "unknown"}`,
    );
  });
  return publicLoginSession(session);
}

export function kernelLoginSession(sessionId: string): BridgeKernelLoginSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  refreshTerminalSession(session);
  return publicLoginSession(session);
}

export function expireKernelLoginSessions(now = Date.now()): void {
  for (const session of sessions.values()) {
    if (session.status !== "running" || session.terminalTimeoutAt === undefined || now < session.terminalTimeoutAt) {
      continue;
    }
    finishSession(session, "failed", "kernel_login_timed_out");
    cleanupTerminalSession(session);
  }
}

function fallbackLoginStatus(state: BridgeState, kernelId: BridgeKernelId): BridgeKernelLoginStatus {
  const profile = readKernelLocalRouteProfile(kernelId, {
    binaryPath: resolveKernelCommandPath(state, kernelId),
    configHome: kernelConfigHome(state.settings, kernelId),
  });
  return profile?.routeKind === "login" && profile.authConfigured ? "authenticated" : "missing";
}

async function probeNativeLoginStatus(
  state: BridgeState,
  kernelId: BridgeKernelId,
  command: string,
  args: string[],
): Promise<BridgeKernelLoginStatus> {
  try {
    const result = await runBoundedCommand(command, args, kernelLoginEnvironment(state, kernelId), STATUS_TIMEOUT_MS);
    if (kernelId === "codex") {
      const statusText = `${result.stdout}\n${result.stderr}`;
      return result.exitCode === 0 && /logged in/i.test(statusText) && !/api key/i.test(statusText)
        ? "authenticated"
        : "missing";
    }
    return result.exitCode === 0 ? "authenticated" : "missing";
  } catch {
    return "unknown";
  }
}

function kernelLoginEnvironment(state: BridgeState, kernelId: BridgeKernelId): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    ...kernelPathEnv(state.settings, kernelId),
  };
  for (const key of accountLoginExcludedCredentialKeys(kernelId)) env[key] = undefined;
  return applyKernelProxyEnv(env, resolveKernelProxySettings(state.settings.kernelProxy, process.env));
}

function kernelLoginTerminalEnvironment(state: BridgeState, kernelId: BridgeKernelId): NodeJS.ProcessEnv {
  return applyKernelProxyEnv(
    kernelPathEnv(state.settings, kernelId),
    resolveKernelProxySettings(state.settings.kernelProxy, process.env),
  );
}

function accountLoginExcludedCredentialKeys(kernelId: BridgeKernelId): string[] {
  if (kernelId === "codex") {
    return ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];
  }
  if (kernelId === "claude-code") {
    return [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
    ];
  }
  return [];
}

function runBoundedCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const invocation = resolveCommandInvocation(command, args, { environment: env });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("kernel_login_status_timed_out"));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = limitLoginOutput(stdout + chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = limitLoginOutput(stderr + chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

function sanitizeLoginOutput(value: string): string {
  return value
    .replace(/("?(?:access|refresh|id)[_-]?token"?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|[^\s\r\n]+)/gi, "$1<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>");
}

function limitLoginOutput(value: string): string {
  return value.length <= MAX_OUTPUT_LENGTH ? value : value.slice(-MAX_OUTPUT_LENGTH);
}

function finishSession(session: KernelLoginSessionRecord, status: "succeeded" | "failed", error?: string): void {
  session.status = status;
  session.finishedAt = new Date().toISOString();
  session.error = error;
}

function refreshTerminalSession(session: KernelLoginSessionRecord): void {
  if (session.status !== "running" || !session.terminalResultPath) return;
  if (existsSync(session.terminalResultPath)) {
    const rawCode = readFileSync(session.terminalResultPath, "utf8").trim();
    const exitCode = /^-?\d+$/.test(rawCode) ? Number(rawCode) : undefined;
    finishSession(
      session,
      exitCode === 0 ? "succeeded" : "failed",
      exitCode === 0 ? undefined : `kernel_login_exited:${exitCode ?? "unknown"}`,
    );
    cleanupTerminalSession(session);
    return;
  }
  if (session.terminalTimeoutAt !== undefined && Date.now() >= session.terminalTimeoutAt) {
    finishSession(session, "failed", "kernel_login_timed_out");
    cleanupTerminalSession(session);
  }
}

function cleanupTerminalSession(session: KernelLoginSessionRecord): void {
  if (session.terminalCleanupTimer) clearTimeout(session.terminalCleanupTimer);
  if (session.terminalCleanupRoot) {
    rmSync(session.terminalCleanupRoot, { recursive: true, force: true });
  }
  session.terminalCleanupTimer = undefined;
  session.terminalCleanupRoot = undefined;
  session.terminalResultPath = undefined;
  session.terminalTimeoutAt = undefined;
}

function publicLoginSession(session: KernelLoginSessionRecord): BridgeKernelLoginSession {
  return {
    id: session.id,
    kernelId: session.kernelId,
    action: session.action,
    status: session.status,
    output: session.output,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    error: session.error,
  };
}

function pruneFinishedSessions(): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, session] of sessions) {
    const finishedAt = session.finishedAt ? Date.parse(session.finishedAt) : undefined;
    if (finishedAt !== undefined && finishedAt < cutoff) {
      cleanupTerminalSession(session);
      sessions.delete(id);
    }
  }
}
