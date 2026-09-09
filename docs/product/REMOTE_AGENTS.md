# Remote Agent conversations

OpenGrove Contacts can contain local Employees and external Remote Agents. A
Remote Agent has an address such as `owner/coder@agents.example`; its owner
manages its execution environment, model, context, and permissions.

## Add and chat

1. Sign in to OpenGrove with an account whose backend roles include `admin`.
2. In **Contacts** or **Messages**, open **+**, select **Add remote Agent**,
   and enter the employee's address and an optional local display name.
3. Select **Send message** to open the existing Rooms interface. Direct
   conversations support text, execution status, replies, and Stop.
4. Continue in the same conversation to reuse its remote context. **New
   conversation** creates a new Room and context while retaining earlier history.

The Host uses `@agent-router/sdk` to exchange the existing OpenGrove login for a
short-lived communication session. No CLI installation, Matrix login, local
profile, or manual sender selection is needed. Both the Host and the trusted node
check admin eligibility against the account backend. A desktop Bridge token alone
cannot authorize a communication session.

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
`rolesPath: ["data", "roles"]`, and `requiredRoles: ["admin"]`. These settings
come from the SDK's packaged README and CONFIGURATION.md; OpenGrove does not configure or deploy nodes.
For isolated local HTTP tests only, `OPENGROVE_AGENT_ROUTER_ALLOW_LOCAL_HTTP=1`
permits loopback addresses. Other HTTP endpoints remain prohibited.

SDK 0.1.2 is supplied as the original distribution archive under `vendor/`,
with its checksum pinned in the npm lockfile. It is not yet a registry release.

## Account and credential lifetime

The Host keeps communication tokens in memory and renews the ten-minute session
before expiration with the current login token for the same captured account.
OpenGrove's normal auth flow owns product-token refresh; remote requests can
refresh through that flow while returning updated cookies to the caller.
Background observation never consumes a one-time product refresh token. If the
product login is no longer usable, the pending task is preserved until the user
restores their login and reopens the conversation.

Logging out or switching accounts immediately disconnects the old account's
requests, clears local communication credentials, and attempts remote session
revocation. The ledger stores only public account/sender identity, the configured
node/provider, recipient address and resolved Matrix ID, and task metadata. Requests and renewals must
match that binding; another account, node, or sender cannot adopt the conversation.
Role removal prevents subsequent exchange; the node may accept an already-issued
token until its expiry or revocation, as documented by the SDK.

Conversations created with the earlier CLI integration retain their history and
original sender binding. They are not silently rebound to a product account.
Re-add the remote address using the current login to start a new conversation.

## Delivery and recovery

Contacts persist the SDK `resolve` result as an address and Matrix ID pair. All
task operations pass it as `resolvedTarget` and use the trusted home gateway;
existing conversations keep working if the recipient directory is unavailable.
A newly resolved recipient identity creates a separate contact, so a pending
task never silently changes recipient.

The local Room ledger is authoritative for the UI. Each turn persists its message
ID and original text before sending. The first response supplies the remote
context ID; following turns use that context. Reopening after a connection failure
recovers the same request. An uncertain submission replays its original message
ID and identical input; a known task is queried by task ID. A request for more
input continues with both the pending task ID and the context ID.

The SDK provides durable task polling, not token streaming. Connection progress,
waiting, cancellation, and errors appear in execution status; the reply body
contains only remote task content. A malformed response is a visible failure,
never a fabricated answer. Closing OpenGrove stops local observation without
canceling remote work; reopening recovers its latest result under the same account.

Stop requests remote cancellation and follows the returned task state. An
acknowledgment alone is not treated as confirmed cancellation. Completed, failed,
rejected, canceled, input-required, and auth-required task states stop polling.
Remote side effects already performed cannot be undone by stopping observation.

## Boundaries

- Contacts belong to the local address book; adding one does not import network
  contacts or grant receiving or execution permissions.
- Local workspace files, attachments, Employee prompts, and local tools are not
  forwarded. Attached files are rejected visibly. Text is limited to 32,000
  characters per message.
- Remote groups, incoming exposure of local Employees, worker deployment,
  account registration UI, and reply-policy editing are outside this version.

The public Host operations are `network.account.inspect` (no profile input) and
`network.contact.add` (`address` and optional `name`). Conversation creation,
sending, history, events, and cancellation reuse Rooms. See
[Client and protocol boundary](../architecture/CLIENT_PROTOCOL.md).
