# Architecture overview

OpenGrove is a desktop Host for native coding-agent Kernels, with its runtime
and workspace data kept on the user's machine.

- The **Host** owns the local UI, Bridge, settings, Rooms, Apps, approvals,
  diagnostics, and local state.
- A **Kernel** owns its model loop, native tools, login, sessions, compaction,
  and provider-specific behavior.
- An **Adapter** maps a Kernel's native protocol into OpenGrove events and
  controls without replacing the Kernel's model loop.
- The **Bridge** is a loopback HTTP service used by the desktop shell and Web
  UI. Desktop mode uses an in-memory token and a random loopback port.
- An **App** is a portable local directory that can declare Employees, Skills,
  CLIs, MCP configuration, workspace boundaries, and UI surfaces.
- For Store-managed Apps, the Host keeps replaceable program generations apart
  from the persistent App Workspace. An update validates a new generation and
  then switches the mounted program pointer; after the one-time legacy layout
  migration, ordinary updates never move the Workspace. See
  [Store App storage layout](APP_STORAGE_LAYOUT.md).

## Local storage accounting and maintenance

The desktop storage page scans the Host-owned data roots instead of presenting
only SQLite file sizes. Every regular file is counted once in one of five
user-facing categories:

- **My works and files**: content under an App Workspace.
- **Apps and runtime components**: local App content and Store-managed program
  generations.
- **Rebuildable temporary files**: media cache, browser cache, rotated logs,
  updater cache, and confirmed orphan blobs.
- **Recovery backups**: reset and data-migration rollback copies.
- **Conversations and system data**: Rooms, knowledge, settings, account state,
  diagnostics, indexes, and other Host-owned state.

Storage accounting does not grant cleanup authority. Safe cleanup may remove
only data with an explicit regeneration or unreferenced-file contract. It keeps
App Workspaces, active App program generations, conversations, current diagnostic
logs, and recovery backups. An obsolete App program generation is removable
only when it is no longer mounted and carries the Host-authored committed
cleanup marker; unmarked local App archives are retained. The displayed byte
result is the logical size of files removed; filesystem allocation and
operating-system caches can make the change in free disk space differ.

The desktop bounds current main, Bridge, and Bridge-crash logs to 10 MiB each
and keeps two rotated files per log. Cleanup removes rotated logs but retains
the current files so a cleanup failure remains diagnosable. Before cleanup, the
Bridge atomically stops admitting new Runs and rejects the operation if a Run
is already active.

Hosted account services are accessed through an explicit WW base URL. They do
not own local workspaces, native Kernel sessions, or installed App files.
Cloud sign-in is optional in the desktop profile: completing or skipping the
account step is persisted separately from the Cloud session, and the desktop
Bridge token continues to protect local access. Cloud-backed features require
an authenticated account at their own boundary.

The authenticated Web profile is still a single-principal local Host: WW owns
the account session, while the Bridge process owns the local workspace, SQLite
state, Apps, and native Kernel processes. It is not a multi-tenant hosted agent
runtime. See [Building from source](../development/BUILDING.md) for its launch
and storage-isolation requirements.

Rooms unread state is owned by the Host ledger, not synthesized by individual
UI surfaces. Each Room persists a read-through event sequence, and each message
records the first event at which it became visible enough to notify the local
principal. The Host derives unread counts from those cursors; native Rooms and
mounted-App chat surfaces coalesce read receipts and submit the latest Room
event sequence actually applied by the client. The Host advances the persisted
cursor monotonically, never beyond that submitted sequence. Empty Agent run
placeholders do not count, and later stream updates to the same visible reply
do not count it again.

See [PROJECT_OVERVIEW.md](../../PROJECT_OVERVIEW.md) for the repository map and
[SECURITY_MODEL.md](../reference/SECURITY_MODEL.md) for trust boundaries.
