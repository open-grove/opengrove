# Configuration

OpenGrove reads product settings from its local settings UI and environment
variables prefixed with `OPENGROVE_`. `.env.local.example` documents the small
set commonly needed for source development.

Important boundaries:

- `OPENGROVE_WW_BASE_URL` selects the hosted account-service origin used by
  authenticated WW features.
- `OPENGROVE_DESKTOP_DEV_<PROFILE>_WW_BASE_URL` and
  `OPENGROVE_DESKTOP_DEV_<PROFILE>_RELEASE_CONTROL_URL` keep named desktop
  development profile endpoints in the local environment. For example, the
  `test` profile reads the corresponding `..._TEST_...` variables from
  `.env.local` when run through `npm run restart:desktop-dev:test`.
- Provider credentials belong in the settings UI, environment variables, or a
  Kernel's native credential store.
- Desktop Bridge tokens are generated for the local desktop process and must
  not be persisted in source files.
- App-specific secrets remain user configuration and must not be included in
  App packages or workspaces intended for distribution.

See [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md) for the complete runtime
and Bridge reference.
