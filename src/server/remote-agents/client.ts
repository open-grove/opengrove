import {
  AgentRouterClient,
  AgentRouterError,
  type Agent,
  type ClientOptions,
  type NetworkSession,
} from "@agent-router/sdk";
import type { AccountRemoteAgentBinding, RemoteAgentBinding } from "../../rooms/remote-agent.js";

export interface NetworkProductAccount {
  accountIssuer: string;
  accountUserId: string;
  accessToken: string;
}

interface AccountSession {
  product: NetworkProductAccount;
  lifetime: AbortController;
  network?: NetworkSession;
  exchange?: Promise<NetworkSession>;
}

type NetworkIdentity = Omit<AccountRemoteAgentBinding, "address" | "matrixId">;
interface NetworkRequest {
  client: AgentRouterClient;
  sender: Agent;
  signal: AbortSignal;
}
export interface NetworkConnection {
  sender: Agent;
  binding: NetworkIdentity;
  signal: AbortSignal;
  request<T>(operation: (request: NetworkRequest) => Promise<T>): Promise<T>;
}

/** Owns only in-memory communication sessions; product-token renewal stays with WW auth. */
export class AgentNetworkSessions {
  private active?: AccountSession;
  private revision = 0;
  private readonly bootstrap: AgentRouterClient;
  private readonly now: () => number;
  constructor(private readonly options: Omit<ClientOptions, "accessToken"> & { provider: string; now?: () => number }) {
    this.bootstrap = new AgentRouterClient({ ...options, accessToken: "" });
    this.now = options.now ?? Date.now;
  }

  get generation(): number {
    return this.revision;
  }

  observe(product: NetworkProductAccount, generation = this.revision): void {
    if (generation !== this.revision) throw new AgentRouterError("remote_account_changed", 409);
    if (this.active) {
      if (
        this.active.product.accountIssuer !== product.accountIssuer ||
        this.active.product.accountUserId !== product.accountUserId
      )
        throw new AgentRouterError("remote_account_changed", 409);
      this.active.product = { ...product };
    } else {
      this.active = { product: { ...product }, lifetime: new AbortController() };
    }
  }

  async clear(reason = "not_authenticated"): Promise<void> {
    const old = this.active;
    this.active = undefined;
    this.revision++;
    old?.lifetime.abort(new AgentRouterError(reason, 401));
    // Clear locally before waiting for the best-effort remote revocation.
    if (old?.network) await this.revoke(old.network);
  }

  private async revoke(session: NetworkSession): Promise<void> {
    try {
      await new AgentRouterClient({
        ...this.options,
        baseUrl: session.serviceUrl,
        accessToken: session.accessToken,
        timeoutMs: 3000,
      }).revokeSession();
    } catch {
      console.warn("remote_session_revocation_unavailable");
    }
  }

  private assertActive(account: AccountSession): void {
    account.lifetime.signal.throwIfAborted();
    if (this.active !== account) throw new AgentRouterError("remote_account_changed", 409);
  }

  private async session(account: AccountSession): Promise<NetworkSession> {
    this.assertActive(account);
    if (account.network && Date.parse(account.network.expiresAt) > this.now() + 30_000) return account.network;
    if (!account.exchange) {
      account.exchange = this.bootstrap
        .exchange(
          { provider: this.options.provider, accessToken: account.product.accessToken },
          { signal: account.lifetime.signal },
        )
        .then(async (session) => {
          if (this.active !== account || account.lifetime.signal.aborted) {
            await this.revoke(session);
            throw new AgentRouterError("remote_account_changed", 409);
          }
          if (Date.parse(session.expiresAt) <= this.now() + 30_000) throw new AgentRouterError("invalid_response");
          if (
            account.network &&
            (account.network.owner !== session.owner || account.network.agent.id !== session.agent.id)
          ) {
            await this.revoke(session);
            throw new AgentRouterError("remote_sender_changed", 409);
          }
          account.network = session;
          return session;
        })
        .finally(() => {
          account.exchange = undefined;
        });
    }
    return account.exchange;
  }

  async connect(expected?: RemoteAgentBinding | NetworkIdentity, signal?: AbortSignal): Promise<NetworkConnection> {
    if (expected && !("accountUserId" in expected)) throw new AgentRouterError("remote_reconnect_required", 409);
    const account = this.active;
    if (!account) throw new AgentRouterError("not_authenticated", 401);
    if (
      expected &&
      (expected.accountIssuer !== account.product.accountIssuer ||
        expected.accountUserId !== account.product.accountUserId)
    )
      throw new AgentRouterError("remote_account_changed", 409);
    if (expected && (expected.serviceUrl !== this.bootstrap.baseUrl || expected.provider !== this.options.provider))
      throw new AgentRouterError("remote_service_changed", 409);
    const requestSignal = signal ? AbortSignal.any([signal, account.lifetime.signal]) : account.lifetime.signal;
    requestSignal.throwIfAborted();
    const session = await this.session(account);
    requestSignal.throwIfAborted();
    if (expected && (expected.owner !== session.owner || expected.senderAgentId !== session.agent.id))
      throw new AgentRouterError("remote_sender_changed", 409);
    const binding: NetworkIdentity = {
      accountIssuer: account.product.accountIssuer,
      accountUserId: account.product.accountUserId,
      serviceUrl: session.serviceUrl,
      provider: this.options.provider,
      owner: session.owner,
      senderAgentId: session.agent.id,
    };
    const client = new AgentRouterClient({
      ...this.options,
      accessToken: async () => {
        requestSignal.throwIfAborted();
        const current = await this.session(account);
        requestSignal.throwIfAborted();
        return current.accessToken;
      },
    });
    return {
      sender: session.agent,
      binding,
      signal: requestSignal,
      request: async <T>(operation: (request: NetworkRequest) => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          requestSignal.throwIfAborted();
          try {
            const result = await operation({ client, sender: session.agent, signal: requestSignal });
            requestSignal.throwIfAborted();
            return result;
          } catch (error) {
            // A credential rejection is safe to retry. Uncertain sends are never
            // retried here; Rooms owns the durable, identical message replay.
            if (attempt > 0 || !(error instanceof AgentRouterError) || error.code !== "account_session_invalid")
              throw error;
            this.assertActive(account);
            if (account.network) account.network = { ...account.network, expiresAt: new Date(0).toISOString() };
            await this.session(account);
          }
        }
      },
    };
  }
}
