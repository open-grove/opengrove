# App release CLI (`opengrove app release`)

App release commands are generated from the same Host Protocol used by the
server, internal TypeScript Client, Web UI, OpenAPI document, and external SDK.
They do not have a separate HTTP, Bridge discovery, cookie, or login stack.

## Sign in

Start the local OpenGrove Bridge, then use the shared CLI account session:

```bash
opengrove auth login --email admin@example.com
opengrove auth status
```

Every release action still enforces the account's administrator role on the
server. An explicit `--token` overrides the saved account session. See
[`CLIENT_PROTOCOL.md`](../architecture/CLIENT_PROTOCOL.md) for the common
authentication, error, and output rules.

## Commands

```bash
opengrove app release prepare --app-id sample-app
opengrove app release publish --app-id sample-app --version 1.2.3 --yes
opengrove app release status --app-id sample-app
opengrove app release progress --app-id sample-app
opengrove app release reconcile --app-id sample-app
opengrove app release reconcile --app-id sample-app --retry-failed-build
opengrove app release abandon --app-id sample-app --yes
opengrove app release keep-local --app-id sample-app --yes
```

`publish` accepts optional `--release-notes`, `--visibility`, `--app` (JSON),
and `--employees` (JSON array). Omitted App metadata, visibility, and Employees
come from the mounted App baseline. Publishing activates the exact released
artifact as the current local App by default; pass
`--no-apply-to-current-app` to keep the local App untouched (the release still
appears in the Store for other installs).

## How `publish` reaches a terminal state

A release is not finished when the `publish` request returns. Release Control
performs the trusted build remotely and the intent moves through
`awaiting_candidate → building → artifact_accepted → finalizing → published`.
The `status` command only refreshes the remote state; the transitions that
need the local side to act (`awaiting_candidate`, `artifact_accepted`,
`finalizing`, and the local `registry-ready` state) are only driven by
`reconcile`. The Web publish page runs that recovery automatically, and so
does the CLI:

- By default `publish` keeps calling `status` every 2 seconds and calls
  `reconcile` whenever the progress needs it, with the same recovery budget as
  the UI (two attempts at `artifact_accepted`, one per other transition). It
  exits `0` once `progress.state` is `published` or `closed`, and prints the
  final progress plus a `wait` summary (`polls`, `reconciles`, `elapsedMs`).
- It exits `1` with the last progress on stderr when the release is `blocked`
  or `needs-retry` (`error.subtype: app_release_blocked`; read
  `progress.buildFailure` and `progress.allowedActions`, then run
  `reconcile --retry-failed-build` or `abandon --yes`), when the automatic
  budget is exhausted (`app_release_recovery_exhausted`), or when
  `--wait-timeout` (default 900 seconds) elapses (`app_release_wait_timeout`).
- `--no-wait` returns the first progress snapshot immediately. Callers that use
  it must poll `status` themselves and call `reconcile` when `remoteStatus` is
  `awaiting_candidate`, `artifact_accepted`, or `finalizing`.
- `--poll-interval <seconds>` changes the refresh cadence while waiting.

`reconcile` is always safe to run by hand: it resumes the current intent from
whatever state the Bridge journal recorded.

Use `--dry-run` to validate and inspect any request without sending it. Formal
publish, abandon, and keep-local are high-risk writes and require `--yes`.
All commands support the shared `--base-url`, `--token`, `--input`, and
`--format json` options. Run a command with `--help` for its generated field
list.

## Contract chain

The source contract is `packages/protocol/src/apps.ts`. Generation produces:

- the internal `client.apps.releases.*` methods;
- the `opengrove app release ...` command tree;
- `packages/protocol/openapi.json`;
- the external TypeScript SDK.

The Host contract coverage check fails if any release operation is missing
from OpenAPI, the server registry, the generated Client, or CLI help. The Web
publish page uses the generated Client through its existing UI error adapter.

`src/tests/release-cli-harness.ts` exercises all seven commands against a real
HTTP socket, including dry-run, `--yes`, the default activation policy and
`--no-apply-to-current-app`, the `publish` wait loop (automatic `reconcile`,
`--no-wait`, blocked releases, exhausted recovery budget, and timeout), and
both `200` and `202` success responses.
