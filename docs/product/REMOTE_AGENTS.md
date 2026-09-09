# Remote Agent conversations

OpenGrove Contacts can contain local Employees and external Remote Agents. A
Remote Agent has an address such as `owner/coder@agents.example`; its owner
manages its execution environment, model, context, and permissions.

## Connect and chat

1. Install the Agent Router Go CLI, log in to an existing account, and select a
   sending Agent in a named CLI profile. `agent-router --profile work agent-current`
   shows the selected public identity. Managed account commands from Agent Router
   0.6 are required. The executable must be on the desktop Host's `PATH`, or selected
   with `OPENGROVE_AGENT_ROUTER_BIN` before starting OpenGrove.
2. In **Contacts** or **Messages**, open the existing **+** menu, select **Add remote Agent**, enter that profile name, and select
   **Connect account**. Check the displayed owner and sending Agent.
3. Enter the recipient's address and an optional local display name. The address
   is resolved before the contact is saved.
4. Select **Send message** to open the existing Rooms interface. This first version
   supports text in direct conversations, including progress, replies, and Stop.
5. Continue in the same conversation to reuse the remote context. **New conversation**
   creates another Room with a new remote context. Earlier conversations remain in
   Messages and keep their own histories.

Connecting does not register an account, create an Agent, or derive an identity
from a local username or hostname. The explicit CLI profile owns credentials;
OpenGrove stores only the profile name and public identity binding. Changing the
profile's selected sending Agent stops subsequent sends from that contact until
the original selection is restored.

## Delivery and recovery

The local Room ledger is authoritative for the UI. Each outgoing turn persists a
message ID before contacting Agent Router. The first response supplies the remote
context ID; following turns use that saved context. If the connection fails,
reopen the conversation to recover the same request. A repeated submission uses
the same message ID, and a known task is polled by task ID. This prevents a lost
submission response from creating a second remote task. A remote request for
additional input is continued with its task ID as well as its context ID.

Closing OpenGrove disconnects local observation without cancelling remote work.
Reopening the conversation recovers the saved task and its latest result.

Stop requests cancellation from the remote service. The UI distinguishes a
cancellation request from a completed reply; it cannot undo remote work already
performed. Completed and failed remote task states are saved in the Room.

## Boundaries

- Contacts added here belong to OpenGrove's local address book. This does not
  import the network address book or change receive/automatic-execution policies.
- Remote Agents control whether a sender is accepted and whether work executes.
  Adding a contact grants no remote execution permission.
- Local workspace files, attachments, local Employee prompts, and local tools are
  not forwarded. Messages with attachments or selected local files are rejected
  with a visible explanation. Text is limited to 32,000 characters per message.
- Remote groups, incoming exposure of local Employees, account registration UI,
  and reply-policy editing are outside this version.

The public Host operations are `network.account.inspect` and `network.contact.add`.
Conversation creation, sending, history, events, and cancellation reuse Rooms.
See [Client and protocol boundary](../architecture/CLIENT_PROTOCOL.md).
