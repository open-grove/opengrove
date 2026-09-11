# Remote Agent conversations

OpenGrove Contacts can contain local Employees and external Remote Agents. A
Remote Agent has an address such as `owner/coder@agents.example`; its owner
manages its execution environment, model, context, and permissions.

## Add and chat

1. Sign in to OpenGrove with an account whose backend roles include `admin`.
2. In **Contacts** or **Messages**, open **+**, select **Add remote Agent**,
   and enter the employee's address and an optional local display name.
3. Select **Send message** to open the existing Rooms interface. Direct
   and group conversations support text, mentions, replies, execution status, and Stop.
4. Continue in the same conversation to reuse its remote context. **New
   conversation** creates a new Room and context while retaining earlier history.

The Host uses `@agent-router/sdk` to exchange the existing OpenGrove login for a
short-lived communication session. No CLI installation, Matrix login, local
profile, or manual sender selection is needed. Both the Host and the trusted node
check admin eligibility against the account backend. A desktop Bridge token alone
cannot authorize a communication session.

Each remote Room run also requires an in-memory authorization issued after that
product-account check. It is bound to the Host and current login generation;
request fields and persisted messages cannot supply it. Logout or an account
switch invalidates it. Restoring an authenticated login or selecting **Retry**
authorizes recovery of previously accepted pending requests. Messages rejected
at the authorization check are not pending and cannot be sent by later recovery.

This version supports user-directed Rooms messages and their recovery. Routines,
system delegation, and PM/Employee delegation do not have delegated network
authority and cannot initiate remote work. Send to the remote Employee explicitly
from Rooms instead. A future background integration must define and verify its
own account authorization rather than borrow the Host's cached connection.

## Operator configuration

The installation's operator selects a trusted node before starting the Host:

```sh
OPENGROVE_AGENT_ROUTER_URL=https://agents.example/_agent-router/v1
OPENGROVE_AGENT_ROUTER_PROVIDER=opengrove
```

The provider name defaults to `opengrove`. The service URL has no implicit default:
this node will receive the OpenGrove access token, so it must be explicitly
trusted by the operator. This is installation configuration, not per-user
communication-account setup, and it is never taken from a contact's address.
The node must configure that provider against the existing Cloud account
`GET /v1/users/me` endpoint with `subjectPath: ["data", "user_id"]`,
`rolesPath: ["data", "roles"]`, and `requiredRoles: ["admin"]`. These deployment-specific mappings belong to the operator configuration; the Router SDK is product-independent. OpenGrove does not configure or deploy nodes.
For isolated local HTTP tests only, `OPENGROVE_AGENT_ROUTER_ALLOW_LOCAL_HTTP=1`
permits loopback addresses. Other HTTP endpoints remain prohibited.

SDK 0.1.4 is supplied as the original distribution archive under `vendor/`,
with its checksum pinned in the npm lockfile. It is not yet a registry release.

## Account and credential lifetime

The Host keeps communication tokens in memory and renews the ten-minute session
before expiration with the current login token for the same captured account.
OpenGrove's normal auth flow owns product-token refresh; remote requests can
refresh through that flow while returning updated cookies to the caller.
Background observation never consumes a one-time product refresh token. If the
product login is no longer usable, the pending task is preserved until the user
restores their login or selects **Retry** in execution status.

The Host has one current product account, matching the existing single-principal local Host design. Stale requests from an old login cannot clear that account's network connection.

Logging out or switching accounts immediately disconnects the old account's
requests, clears local communication credentials, and attempts remote session
revocation. The ledger stores only public account/sender identity, the configured
node/provider, recipient address and resolved Matrix ID, and task metadata. Requests and renewals must
match that binding; another account, node, or sender cannot adopt the conversation.
Role removal prevents subsequent exchange; the node may accept an already-issued
token until its expiry or revocation, as documented by the SDK.

Malformed remote bindings disable only the affected contact. Malformed task metadata interrupts only that reply; local contacts and conversation history still load. Unshipped CLI bindings are not supported.

## Delivery and recovery

Contacts persist the SDK `resolve` result as an address and Matrix ID pair. All
task operations pass it as `resolvedTarget` and use the trusted home gateway;
existing conversations keep working if the recipient directory is unavailable.
Resolving a new address makes an unauthenticated outbound HTTPS directory request to the host named in that address. Product and network tokens are sent only to the configured trusted home node, never to that directory.
A newly resolved recipient identity creates a separate contact, so a pending
task never silently changes recipient.

The local Room ledger is authoritative for the UI. Each turn persists its message
ID and original text before sending. The first response supplies the remote
context ID; following turns for the same Employee in the same Room use that context. Different Rooms and Employees have separate contexts. Restoring the login after startup or choosing **Retry** after a connection failure recovers the same request. Reading Rooms or message history never reconnects or replays work. An uncertain submission replays its original message
ID and identical input; a known task is queried by task ID. A request for more
input continues with both the pending task ID and the context ID.

The SDK consumes A2A task subscriptions through the official A2A client. Status and artifact updates are applied as they arrive; broken subscriptions reconnect with bounded exponential backoff. Exhausted retries pause observation with a visible failure and a **Retry** action. Connection progress,
waiting, cancellation, and errors appear in execution status; the reply body
contains only remote task content. A malformed response is a visible failure,
never a fabricated answer. Closing OpenGrove stops local observation without
canceling remote work; reopening recovers its latest result under the same account.

Stop requests remote cancellation and follows the returned task state. An
acknowledgment alone is not treated as confirmed cancellation. Completed, failed,
rejected, canceled, input-required, and auth-required task states stop observation.
Remote side effects already performed cannot be undone by stopping observation.

## Boundaries

- The server's `remote-agents` adapter is the only production code that imports the Router SDK. Web, Rooms storage, local Kernels, and product authentication do not implement Matrix or A2A. CI lints static module loads and explicit SDK re-exports; unresolved dynamic module loads in production code fail the check. These source checks do not replace runtime authorization.
- Matrix owns homeserver identities, room events and federation. A2A owns the task/message wire model and task operations. Router's directory, product-account exchange, durable routing and Matrix application-event profile are Router features; that event profile is not an official A2A Matrix binding.
- Product authentication owns login and product-token renewal. The adapter can observe an already verified account and disconnect its communication session; a stale or anonymous logout cannot revoke the active account's communication session. Router availability cannot determine whether the product login succeeds.
- Local Employee execution and local data access do not require Router configuration or credentials. A failed remote binding or request must not prevent local targets from being scheduled or historical Rooms from loading.
- Contacts belong to the local address book; adding one does not import network
  contacts or grant receiving or execution permissions.
- The existing local A2A interface exposes only local Employees and local tasks.
  Remote contacts, cards, sends, task reads and cancellation are excluded even
  when the caller supplies a valid product login. Use the authorized Rooms operations
  to interact with remote Employees.
- Local workspace files, attachments, Employee system prompts, and local tools are not forwarded. Attached files are rejected visibly. The transmitted text, including Room context, is limited to 32,000 characters.
- Group delivery reuses normal Rooms targeting and scheduling. It includes the current message, reply/delegation relation, member names and a bounded excerpt of visible group history. Internal messages are excluded. A remote connection failure affects that Employee's reply while other selected Employees can continue.
- A remote executor does not gain this Host's tools merely by joining a group. Tool access is a separate capability and authorization boundary.
- Incoming exposure of local Employees, worker deployment,
  account registration UI, and reply-policy editing are outside this version.

The public Host operations are `network.account.inspect` (read-only installation availability), `network.account.connect` (an explicit write that exchanges credentials and resumes pending work), and `network.contact.add` (`address` and optional `name`). Conversation creation,
sending, history, events, and cancellation reuse Rooms. See
[Client and protocol boundary](../architecture/CLIENT_PROTOCOL.md).
