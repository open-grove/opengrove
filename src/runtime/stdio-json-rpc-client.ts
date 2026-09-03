import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { JsonValue } from "../core.js";
import { resolveCommandInvocation } from "../kernel/discovery.js";

export interface StdioJsonRpcClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderrLimit?: number;
  onStderr?: (chunk: string) => void;
}

export type JsonRpcRequestMessage = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method: string;
  params?: JsonValue;
};

export type JsonRpcResponseMessage = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: JsonValue;
  error?: {
    code?: number;
    message?: string;
    data?: JsonValue;
  };
};

export type JsonRpcRequestHandler = (request: {
  id: number | string | null;
  method: string;
  params?: JsonValue;
}) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type JsonRpcNotificationHandler = (notification: { method: string; params?: JsonValue }) => Promise<void> | void;

export type JsonRpcRequestFailureKind = "aborted" | "timeout" | "remote" | "transport" | "closed";

export class JsonRpcRequestFailure extends Error {
  constructor(
    readonly kind: JsonRpcRequestFailureKind,
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = "JsonRpcRequestFailure";
  }
}

export class StdioJsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve(value: JsonValue | undefined): void;
      reject(error: Error): void;
      cleanup(): void;
    }
  >();
  private readonly requestHandlers = new Set<JsonRpcRequestHandler>();
  private readonly notificationHandlers = new Set<JsonRpcNotificationHandler>();
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private nextId = 1;
  private closed = false;
  private stderrBuffer = "";

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly options: StdioJsonRpcClientOptions,
    private readonly processGroupPid?: number,
  ) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.appendStderr(chunk);
      this.options.onStderr?.(chunk);
    });
    child.once("error", (error) => {
      this.closeWithError(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      this.closeWithError(new Error(`json-rpc process exited: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
    child.once("close", (code, signal) => {
      this.closeWithError(new Error(`json-rpc process exited: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
    child.stdin.on("error", (error) => {
      this.closeWithError(error instanceof Error ? error : new Error(String(error)));
      this.terminateChild("SIGTERM");
    });
  }

  static start(options: StdioJsonRpcClientOptions): StdioJsonRpcClient {
    const invocation = resolveCommandInvocation(options.command, options.args ?? []);
    const detached = process.platform !== "win32";
    const env = { ...process.env, ...options.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key];
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached,
    });
    return new StdioJsonRpcClient(child, options, detached ? child.pid : undefined);
  }

  isClosed(): boolean {
    return this.closed;
  }

  stderr(): string {
    return this.stderrBuffer;
  }

  request<T extends JsonValue | undefined = JsonValue | undefined>(
    method: string,
    params?: JsonValue,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new JsonRpcRequestFailure("closed", method, "json-rpc client is closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new JsonRpcRequestFailure("aborted", method, `${method} aborted`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cleanupAbort?.();
        cleanupAbort = undefined;
      };
      const rejectPending = (error: Error) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timeout = setTimeout(
          () => rejectPending(new JsonRpcRequestFailure("timeout", method, `${method} timed out`)),
          Math.max(100, options.timeoutMs),
        );
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = () => rejectPending(new JsonRpcRequestFailure("aborted", method, `${method} aborted`));
        options.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () => options.signal?.removeEventListener("abort", abortListener);
      }
      this.pending.set(id, {
        method,
        resolve(value) {
          cleanup();
          resolve(value as T);
        },
        reject(error) {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  addRequestHandler(handler: JsonRpcRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  addNotificationHandler(handler: JsonRpcNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  addCloseHandler(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new JsonRpcRequestFailure("closed", pending.method, "json-rpc client closed"));
    }
    this.pending.clear();
    this.notifyCloseHandlers(new Error("json-rpc client closed by host"));
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.terminateChild("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!this.childHasExited()) {
        this.terminateChild("SIGKILL");
      }
    }, 1_500);
    killTimer.unref?.();
  }

  private write(message: JsonRpcRequestMessage | JsonRpcResponseMessage): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isJsonRpcObject(parsed)) return;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    const hasId = Object.prototype.hasOwnProperty.call(parsed, "id");
    if (method && hasId) {
      void this.handleServerRequest(parsed as JsonRpcRequestMessage & { id: number | string | null });
      return;
    }
    if (method) {
      void this.handleNotification(parsed as JsonRpcRequestMessage);
      return;
    }
    if (hasId) {
      this.handleResponse(parsed as JsonRpcResponseMessage);
    }
  }

  private handleResponse(response: JsonRpcResponseMessage): void {
    const id = typeof response.id === "number" ? response.id : undefined;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (response.error) {
      const data = response.error.data === undefined ? "" : `: ${JSON.stringify(response.error.data)}`;
      pending.reject(
        new JsonRpcRequestFailure(
          "remote",
          pending.method,
          `${response.error.message || `${pending.method} failed`}${data}`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private async handleServerRequest(request: JsonRpcRequestMessage & { id: number | string | null }): Promise<void> {
    try {
      for (const handler of this.requestHandlers) {
        const result = await handler({
          id: request.id,
          method: request.method,
          params: request.params,
        });
        if (result !== undefined) {
          this.write({ jsonrpc: "2.0", id: request.id, result });
          return;
        }
      }
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found", data: { method: request.method } },
      });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleNotification(notification: JsonRpcRequestMessage): Promise<void> {
    for (const handler of this.notificationHandlers) {
      await handler({ method: notification.method, params: notification.params });
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new JsonRpcRequestFailure("transport", pending.method, error.message));
    }
    this.pending.clear();
    this.notifyCloseHandlers(error);
  }

  private notifyCloseHandlers(error: Error): void {
    for (const handler of this.closeHandlers) handler(error);
    this.closeHandlers.clear();
  }

  private terminateChild(signal: NodeJS.Signals): void {
    if (this.childHasExited()) return;
    if (this.processGroupPid && process.platform !== "win32") {
      try {
        process.kill(-this.processGroupPid, signal);
        return;
      } catch {
        // non-critical-fallback: If process-group signaling fails, kill the direct child below.
      }
    }
    this.child.kill(signal);
  }

  private childHasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private appendStderr(chunk: string): void {
    const limit = this.options.stderrLimit ?? 24_000;
    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > limit) {
      this.stderrBuffer = this.stderrBuffer.slice(this.stderrBuffer.length - limit);
    }
  }
}

function isJsonRpcObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
