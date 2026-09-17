# Remote Agent conversations

OpenGrove Contacts can contain local Employees and external Remote Agents. A
Remote Agent has an address such as `owner/coder@agents.example`; its owner
manages its execution environment, model, context, and permissions.

## Add and chat

1. Sign in to OpenGrove with an account whose backend roles include `admin`.
2. In **Contacts** or **Messages**, open **+**, select **Add remote Agent**,
   and enter the employee's address and an optional local display name.
3. Open the browser authorization page, use the same OpenGrove account and
   approve access to OpenGrove communication services. The dialog continues automatically.
4. Select **Send message** to open the existing Rooms interface. Direct
   and group conversations support text, mentions, replies, execution status, and Stop.
5. Continue in the same conversation to reuse its remote context. **New
   conversation** creates a new Room and context while retaining earlier history.

The Host uses native Authorization Code + S256 PKCE against WW's existing OIDC
service. It verifies signed identity, nonce and account subject. OAuth access
and refresh tokens go only to WW. WW's product integration checks current admin
eligibility and provisions a short-lived native Matrix credential through the
configured homeserver. The Host gives only that native credential to the existing
Router SDK. Router has no OpenGrove OAuth or product-role logic. A desktop Bridge
token alone cannot authorize communication.
The browser callback listens temporarily on 127.0.0.1; this native flow requires
the browser and Host on the same computer.

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

## Service configuration

In **Settings → Network**, enter the trusted **Service address (Router)** and
select **Save address**. This setting is available in standard mode, starts empty,
and is stored on this installation. Saving or clearing it updates availability
immediately without restarting the Host or connecting to the service. Connecting
still requires a verified OpenGrove admin login. Clearing it disables remote access.
Changing this local setting requires normal Host access; it does not require a
cloud admin role. It applies to this installation, not to every user's installation.

Changing the service disconnects the previous communication session and attempts
revocation. Existing contacts and conversations keep their original service binding;
they cannot be silently moved to the new service. Local history remains readable.

An operator can also select the trusted node before starting the Host:

```sh
OPENGROVE_AGENT_ROUTER_URL=https://agents.example/_agent-router/v1
OPENGROVE_AGENT_ROUTER_PROVIDER=opengrove
```

The provider name defaults to `opengrove`. The service URL has no implicit default:
users explicitly select the service. A nonempty environment URL takes precedence
over the saved setting and appears read-only in Settings. URLs must use HTTPS
without credentials, query or fragments. The setting belongs to this installation
and is never taken from a contact's address.

WW's optional communication integration registers the exact Router and homeserver
addresses independently from its ordinary native OAuth client. Host resolves the
client from trusted WW metadata at `/v1/network/configuration?resource=...`.
An unknown Router gets an explicit registration error. Router cannot nominate an
issuer or receive OAuth credentials. WW uses Synapse's external-identity lookup
to preserve the existing owner, then Router's existing managed-Agent API to retain
the same sender. Operator configuration belongs to WW's communication integration;
no Router source change or OAuth verifier configuration is required.
For isolated local HTTP tests only, `OPENGROVE_AGENT_ROUTER_ALLOW_LOCAL_HTTP=1`
permits loopback addresses. Other HTTP endpoints remain prohibited.

The settings snapshot separates the saved `agentRouterUrl` from the read-only
`agentRouterEffectiveUrl`. While environment-managed, any patch containing
`agentRouterUrl` is rejected, including an identical address. Saving other settings
does not persist the environment override. Removing that override restores the
previous local setting, or leaves the service unconfigured if none was saved.

Settings are committed by an atomic file replacement. A failure before that point
keeps the previous settings and service session. If related workspace state cannot
be persisted after the commit, the response reports `settings_state_persist_failed`
and the UI explains that the settings were saved; it does not report a rollback.
The new service configuration takes effect, and restarting reapplies the settings
to workspace presentation.

SDK 0.1.4 is supplied as the original distribution archive under `vendor/`,
with its checksum pinned in the npm lockfile. It is not yet a registry release.

## Account and credential lifetime

The Host keeps OAuth and native communication credentials in memory. Native
credentials last at most two minutes and never outlive their OAuth access token.
Host requests them from WW and renews OAuth directly with WW using a rotating
refresh token. WW grants last at most 24 hours and require a live parent account
session. Main product-token renewal remains with product auth.

After Host restart, select **Retry** and complete browser authorization again.
Existing contacts and pending task IDs stay in the ledger. Missing OAuth consent
preserves accepted pending work; it does not authorize background work. Canceling
browser authorization closes the callback listener without creating a contact.

The Host has one current product account, matching the existing single-principal local Host design. Stale requests from an old login cannot clear that account's network connection.

Logging out or switching accounts immediately disconnects the old account's
requests, clears local communication credentials, and attempts remote session
revocation. The ledger stores only public account/sender identity, the configured
node/provider, recipient address and resolved Matrix ID, and task metadata. Requests and renewals must
match that binding; another account, node, or sender cannot adopt the conversation.
Central revocation and role removal prevent WW from issuing new native credentials.
Already-issued credentials can authorize new requests until native logout or their
hard two-minute expiry. Existing remote tasks and streams are not canceled by
revocation. Router authenticates through its homeserver and can keep serving an
unexpired credential during a WW outage; renewal fails closed.

Malformed remote bindings disable only the affected contact. Malformed task metadata interrupts only that reply; local contacts and conversation history still load. Unshipped CLI bindings are not supported.

## Delivery and recovery

Contacts persist the SDK `resolve` result as an address and Matrix ID pair. All
task operations pass it as `resolvedTarget` and use the trusted home gateway;
existing conversations keep working if the recipient directory is unavailable.
Resolving a new address makes an unauthenticated outbound HTTPS directory request to the host named in that address. Native communication credentials are sent only to the configured Router and its trusted homeserver for logout, never to that directory. OAuth credentials remain at WW.
A newly resolved recipient identity creates a separate contact, so a pending
task never silently changes recipient.

The local Room ledger is authoritative for the UI. Each turn persists its message
ID and original text before sending. The first response supplies the remote
context ID; following turns for the same Employee in the same Room use that context.
A locally rejected message does not replace the last established remote context.
Different Rooms and Employees have separate contexts. Restoring the login after startup or choosing **Retry** after a connection failure recovers the same request. Reading Rooms or message history never reconnects or replays work. An uncertain submission replays its original message
ID and identical input; a known task is queried by task ID. A request for more
input continues with both the pending task ID and the context ID.

The SDK consumes A2A task subscriptions through the official A2A client. Status and artifact updates are applied as they arrive; broken subscriptions reconnect with bounded exponential backoff. Exhausted retries pause observation with a visible failure and a **Retry** action. Connection progress,
waiting, cancellation, and errors appear in execution status; the reply body
contains only remote task content. A malformed response is a visible failure,
never a fabricated answer. Closing OpenGrove stops local observation without
canceling remote work; reopening recovers its latest result under the same account.

**Stop** is available for both running and failed pending messages. It immediately
stops local recovery, including while signed out or while the Router is unavailable.
The message cannot be replayed by a later login, reconnect, or delayed connection.
If the task ID is known, the Host separately verifies the current account and
attempts remote cancellation. A confirmed terminal response is shown; otherwise
the status says that local retrying has stopped and remote work may still be running.
No further observation or automatic cancellation retry is scheduled by this action.
A missing task ID can mean the submission receipt was lost, so Stop never resends
that message just to discover its task ID. Remote side effects already performed
cannot be undone by stopping observation. Completed, failed, rejected, canceled,
input-required, and auth-required task states also stop ordinary observation.

## Boundaries

- The server's `remote-agents` adapter is the only production code that imports the Router SDK. Web, Rooms storage, local Kernels, and product authentication do not implement Matrix or A2A. CI lints static module loads and explicit SDK re-exports; unresolved dynamic module loads in production code fail the check. These source checks do not replace runtime authorization.
- Matrix owns homeserver identities, room events and federation. A2A owns the task/message wire model and task operations. Router's directory, managed-Agent API, durable routing and Matrix application-event profile are Router features; that event profile is not an official A2A Matrix binding.
- Product authentication owns login and product-token renewal. The adapter can observe an already verified account and disconnect its communication session; a stale or anonymous logout cannot revoke the active account's communication session. Router availability cannot determine whether the product login succeeds.
- Local Employee execution and local data access do not require Router configuration or credentials. A failed remote binding or request must not prevent local targets from being scheduled or historical Rooms from loading.
- Contacts belong to the local address book; adding one does not import network
  contacts or grant receiving or execution permissions.
- The existing local A2A interface exposes only local Employees and local tasks.
  Remote contacts, cards, sends, task reads and cancellation are excluded even
  when the caller supplies a valid product login. Use the authorized Rooms operations
  to interact with remote Employees.
- Local workspace files, attachments, Employee system prompts, and local tools are not forwarded. Attached files are rejected visibly. The transmitted text, including Room context, is limited to 32,000 characters.
- Group delivery reuses normal Rooms targeting and scheduling. It includes the
  current message, explicitly referenced reply/thread context, Room identity,
  member roster, and collaboration guidance. Recent Room history is not appended
  automatically. Following turns still reuse the remote conversation context;
  users can explicitly reply to a message or include needed background in their
  request. A remote connection failure affects that Employee's reply while other
  selected Employees can continue.
- A remote executor does not gain this Host's tools merely by joining a group. Tool access is a separate capability and authorization boundary.
- Incoming exposure of local Employees, worker deployment,
  account registration UI, and reply-policy editing are outside this version.

The public Host operations are `network.account.inspect` (read-only installation availability), `network.account.connect` (an explicit write that exchanges credentials and resumes pending work), and `network.contact.add` (`address` and optional `name`). Conversation creation,
sending, history, events, and cancellation reuse Rooms. See
[Client and protocol boundary](../architecture/CLIENT_PROTOCOL.md).
