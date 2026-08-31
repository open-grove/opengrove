# Security model

OpenGrove runs its workspace locally, but local does not mean unauthenticated.

Continuing without an OpenGrove Cloud account skips account onboarding; it
does not disable local authentication or change the ownership of Local Runtime
and Data.

- The Bridge binds to loopback by default.
- Desktop requests use an in-memory Bridge token and an allowlisted custom UI
  origin.
- Desktop users may work without a Cloud account. Cloud-backed capabilities
  require sign-in at their feature boundary, while browser session deployments
  retain their account requirement.
- Renderer Node integration is disabled; privileged operations cross explicit
  desktop or Bridge boundaries.
- Installed Apps are validated before mounting. Store packages are checked for
  identity, path traversal, archive integrity, and declared workspace rules.
- Provider credentials, session cookies, local paths, and diagnostic evidence
  must not be committed or packaged into public Apps.
- Risky Kernel actions remain subject to the Kernel and Host approval policies.

## Background network boundary

Beyond requests initiated directly from Cloud and marketplace features, the
desktop app can make these background network requests:

- **Update checks and downloads.** Packaged desktops query the OpenGrove Cloud
  version contract and may download update assets when automatic downloads are
  enabled. Signed-out desktops use the unauthenticated public version endpoint.
  Source checkouts periodically fetch their configured Git remote instead.
- **Signed-in account maintenance.** Restoring a saved account session may
  refresh tokens, read the account profile, reconcile the hosted Provider
  credential, and read the default-App install policy and catalog. These calls
  maintain account-backed features and are not activity telemetry.
- **Configured integration discovery.** At startup and every six hours, the
  Bridge may refresh model catalogs for configured OpenAI or Anthropic
  Providers and rediscover a configured OpenClaw Gateway. Kernels, Providers,
  and installed Apps can make additional requests according to their
  configuration and the features in use.
- **Once-daily account activity.** A signed-in Electron desktop attempts the
  report at most once per account per UTC day and only while its window is in
  the foreground. Its fields are surface (`desktop`), operating system, CPU
  architecture, client version and optional release number, Bridge version and
  optional release number, and release channel. It never includes chat content,
  file paths, workspace data, or Provider credentials, and it is not sent while
  signed out.

Problem records and diagnostics stay in the local state directory; the Host
does not upload them.

Report suspected vulnerabilities privately using the process in
[SECURITY.md](../../SECURITY.md). Do not open a public issue containing an
unpatched vulnerability or private user data.
