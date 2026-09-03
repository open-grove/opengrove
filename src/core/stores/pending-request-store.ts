import { randomUUID } from "node:crypto";

export interface PendingRequestBase<TStatus extends string> {
  id: string;
  status: TStatus;
  createdAt: string;
  updatedAt: string;
  response?: unknown;
}

export class PendingRequestStore<
  TRequest extends PendingRequestBase<TStatus>,
  TStatus extends string,
  TPendingStatus extends TStatus,
> {
  private readonly requests = new Map<string, TRequest>();
  private readonly waiters = new Map<string, Set<(request: TRequest) => void>>();

  constructor(
    private readonly options: {
      prefix: string;
      pendingStatus: TPendingStatus;
      label: string;
    },
  ) {}

  request(input: Omit<TRequest, "id" | "status" | "createdAt" | "updatedAt">): TRequest {
    const now = new Date().toISOString();
    const request = {
      ...input,
      // Stores are scoped per mounted app, while requests are routed through a
      // shared Host registry. A process-wide UUID prevents two concurrent apps
      // from producing the same approval_1/question_1 identifier.
      id: `${this.options.prefix}_${randomUUID()}`,
      status: this.options.pendingStatus,
      createdAt: now,
      updatedAt: now,
    } as unknown as TRequest;
    this.requests.set(request.id, request);
    return request;
  }

  restore(requests: TRequest[] = []): void {
    this.requests.clear();

    for (const request of requests) {
      this.requests.set(request.id, request);
    }
  }

  upsert(request: TRequest): TRequest {
    this.requests.set(request.id, request);
    if (request.status !== this.options.pendingStatus) {
      this.notifyWaiters(request);
    }
    return request;
  }

  get(id: string): TRequest | undefined {
    return this.requests.get(id);
  }

  list(status?: TStatus): TRequest[] {
    const requests = Array.from(this.requests.values());
    return status ? requests.filter((request) => request.status === status) : requests;
  }

  hasDecisionWaiter(id: string): boolean {
    return Boolean(this.waiters.get(id)?.size);
  }

  decide(id: string, status: Exclude<TStatus, TPendingStatus>, response?: unknown): TRequest {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`${this.options.label} not found: ${id}`);
    }

    if (request.status !== this.options.pendingStatus) {
      if (request.status !== status) {
        throw new Error(`${this.options.label} already ${request.status}: ${id}`);
      }
      return request;
    }

    const updated = {
      ...request,
      status,
      ...(response !== undefined ? { response } : {}),
      updatedAt: new Date().toISOString(),
    } as TRequest;
    this.requests.set(id, updated);
    this.notifyWaiters(updated);
    return updated;
  }

  waitForDecision(id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TRequest> {
    const request = this.requests.get(id);
    if (!request) {
      return Promise.reject(new Error(`${this.options.label} not found: ${id}`));
    }
    if (request.status !== this.options.pendingStatus) {
      return Promise.resolve(request);
    }

    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
      const waiter = (updated: TRequest) => {
        if (updated.status === this.options.pendingStatus) {
          return;
        }
        cleanup();
        resolve(updated);
      };
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cleanupAbort?.();
        const waiters = this.waiters.get(id);
        waiters?.delete(waiter);
        if (waiters && waiters.size === 0) {
          this.waiters.delete(id);
        }
      };

      const waiters = this.waiters.get(id) ?? new Set<(request: TRequest) => void>();
      waiters.add(waiter);
      this.waiters.set(id, waiters);

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`${this.options.label} timed out: ${id}`));
        }, options.timeoutMs);
      }

      if (options.signal) {
        if (options.signal.aborted) {
          cleanup();
          reject(new Error(`${this.options.label} aborted: ${id}`));
          return;
        }
        const onAbort = () => {
          cleanup();
          reject(new Error(`${this.options.label} aborted: ${id}`));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
    });
  }

  private notifyWaiters(request: TRequest): void {
    const waiters = this.waiters.get(request.id);
    if (!waiters) {
      return;
    }
    for (const waiter of Array.from(waiters)) {
      waiter(request);
    }
  }
}
