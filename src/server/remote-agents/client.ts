import { AgentRouterClient, AgentRouterError, type Agent, type ClientOptions } from "@agent-router/sdk";
import { NetworkOAuth } from "./oauth.js";
import { issueNetworkSession, revokeNetworkSession, type NativeNetworkSession } from "./credentials.js";
import type { AccountRemoteAgentBinding, RemoteAgentBinding } from "../../rooms/remote-agent.js";

export interface NetworkProductAccount {
  accountIssuer: string;
  accountUserId: string;
}

interface AccountSession {
  product: NetworkProductAccount;
  oauth: NetworkOAuth;
  lifetime: AbortController;
  network?: NativeNetworkSession;
  exchange?: Promise<NativeNetworkSession>;
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

/** Owns only in-memory communication sessions; OAuth renewal goes directly to WW. */
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

  matches(product: Pick<NetworkProductAccount, "accountIssuer" | "accountUserId">): boolean {
    return (
      !this.active ||
      (this.active.product.accountIssuer === product.accountIssuer &&
        this.active.product.accountUserId === product.accountUserId)
    );
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
      this.active = {
        product: { ...product },
        lifetime: new AbortController(),
        oauth: new NetworkOAuth(product, this.bootstrap.baseUrl, this.options.allowLocalHTTP),
      };
    }
  }

  async clear(reason = "not_authenticated"): Promise<void> {
    const old = this.active;
    this.active = undefined;
    this.revision++;
    old?.oauth.clear();
    old?.lifetime.abort(new AgentRouterError(reason, 401));
    // Clear locally before waiting for the best-effort remote revocation.
    if (old?.network) void this.revoke(old.network);
  }

  cancelAuthorization(id?: string): void {
    this.active?.oauth.cancel(id);
  }

  authorizationStatus(id?: string) {
    if (!this.active) throw new AgentRouterError("not_authenticated", 401);
    return this.active.oauth.authorizationStatus(id);
  }

  async beginAuthorization(): Promise<string> {
    if (!this.active) throw new AgentRouterError("not_authenticated", 401);
    return this.active.oauth.begin();
  }

  private async revoke(session: NativeNetworkSession): Promise<void> {
    await revokeNetworkSession(session, this.options.fetch);
  }

  private assertActive(account: AccountSession): void {
    account.lifetime.signal.throwIfAborted();
    if (this.active !== account) throw new AgentRouterError("remote_account_changed", 409);
  }

  private async session(account: AccountSession): Promise<NativeNetworkSession> {
    this.assertActive(account);
    if (account.network && Date.parse(account.network.expiresAt) > this.now() + 30_000) return account.network;
    if (!account.exchange) {
      account.exchange = account.oauth
        .accessToken()
        .then((accessToken) =>
          issueNetworkSession({
            accountIssuer: account.product.accountIssuer,
            serviceUrl: this.bootstrap.baseUrl,
            accessToken,
            signal: account.lifetime.signal,
            allowLocalHTTP: this.options.allowLocalHTTP,
            fetch: this.options.fetch,
            now: this.now(),
          }),
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
          const previous = account.network;
          account.network = session;
          if (previous) void this.revoke(previous);
          return session;
        })
        .catch((error: unknown) => {
          if (error instanceof AgentRouterError && error.code === "remote_oauth_required") {
            account.oauth.invalidate();
            throw new AgentRouterError("remote_oauth_required", 403);
          }
          throw error;
        })
        .finally(() => {
          account.exchange = undefined;
        });
    }
    return account.exchange;
  }

  async connect(expected?: RemoteAgentBinding | NetworkIdentity, signal?: AbortSignal): Promise<NetworkConnection> {
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
