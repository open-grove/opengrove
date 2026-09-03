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
come from the mounted App baseline. Publishing does not activate the released
artifact locally unless `--apply-to-current-app` is supplied.

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
HTTP socket, including dry-run, `--yes`, the default non-activation policy, and
both `200` and `202` success responses.
