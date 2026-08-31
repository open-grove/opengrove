# Building OpenGrove

This guide covers source setup, desktop and browser development, the
authenticated single-user Web profile, build outputs, and local packages.

## Requirements

- Node.js 24
- npm as bundled with the supported Node.js 24 release
- macOS, Windows, or Linux for source development

The `packageManager` field records a compatible npm version for tools that
honor it; the repository and CI do not require that exact npm version.

Install exactly the locked dependency tree:

```bash
git clone https://github.com/open-grove/opengrove.git
cd opengrove
npm ci
npm run check:static
```

Public npm publication is currently disabled. After
`npm run build:server`, invoke the source CLI as `node dist/cli.js ...`; do not
assume a global `opengrove` command exists. That build is sufficient for
API-only CLI use; serving the browser UI also requires `npm run build:web`.

## Development surfaces

| Goal | Command | Result |
| --- | --- | --- |
| Desktop development | `npm start` or `npm run desktop:dev` | Builds all targets and launches the Electron development shell |
| Restart desktop development | `npm run restart:desktop-dev` | Stops the current development processes, rebuilds, relaunches, and probes the Bridge |
| Local browser UI | `npm run bridge:web` | Builds all targets and serves the local Bridge-token UI at `http://127.0.0.1:37371/ui/` |
| Authenticated Web development | `npm run dev:web` | Builds the server, runs the session-authenticated Bridge on port `37371`, runs Vite on port `5173`, and rebuilds the backend on source changes |
| Authenticated Web backend only | `npm run dev:web-backend` | Builds and starts `node dist/cli.js web` |
| Authenticated Web frontend only | `npm run dev:web-frontend` | Starts Vite and proxies Bridge calls to `http://127.0.0.1:37371` by default |
| Built authenticated Web | `npm run start:web` | Builds server and Web assets, then serves both through the session-authenticated Bridge |

`bridge:web` and `web` are intentionally different profiles. `bridge:web` is
the local developer surface protected by an optional Bridge token. The `web`
command requires WW session authentication and refuses to start unless
`OPENGROVE_WW_BASE_URL` is configured:

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run dev:web
```

The URL above is a placeholder. Use the account-service origin for the
environment you are authorized to test. WW owns the account session; the local
Bridge still owns the workspace, SQLite state, Apps, and native Kernel
processes. The profile is single-principal and is not a multi-tenant hosted
agent runtime.

See [Configuration](../reference/CONFIGURATION.md) and the
[technical reference](../reference/TECHNICAL_REFERENCE.md) for environment
file precedence and Provider configuration.

## State isolation

Two OpenGrove processes must not write the same SQLite state file at the same
time. Desktop development already uses its own development app-data directory.
When running another Bridge beside it, give that process a separate data root:

```bash
export OPENGROVE_USER_DATA_DIR="$PWD/.opengrove/web-dev"
export OPENGROVE_DATA_DIR="$PWD/.opengrove/web-dev/data"
export OPENGROVE_STATE_PATH="$PWD/.opengrove/web-dev/data/local-state.sqlite"
export OPENGROVE_BRIDGE_SETTINGS_PATH="$PWD/.opengrove/web-dev/data/bridge-settings.json"
export OPENGROVE_WW_BASE_URL="https://accounts.example.test"
npm run dev:web
```

`.opengrove/` is ignored by Git. Keep Provider credentials and account-service
configuration in ignored local environment or settings files, never in tracked
commands or documentation.

## Build and package commands

| Output | Command | Generated location or artifact |
| --- | --- | --- |
| Server and source CLI | `npm run build:server` | `dist/` |
| Browser UI | `npm run build:web` | `web-dist/` |
| Electron main and preload | `npm run build:desktop` | `desktop-dist/` |
| All source targets | `npm run build` | All of the above |
| Deployable Web backend | `npm run pack:web:backend` | `release/web/opengrove-<version>.tgz` |
| Deployable Web frontend | `npm run pack:web:frontend` | `release/web/opengrove-web-<version>.tar.gz` |
| Unpacked desktop app | `npm run pack:desktop` | Platform-specific unpacked Electron output |
| Local desktop installer | `npm run dist:desktop` | Platform-native installer under `release/desktop/` |

`build` compiles source. `pack:web:*` creates independently deployable Web
archives and validates their contents. `pack:desktop` creates an unpacked local
desktop product for inspection. `dist:desktop` creates a host-platform
installer; it does not replace the signed, notarized, cross-platform release
workflow.

Platform-native desktop runtime components must be staged on the matching OS.
In particular, build Windows installers on Windows. Formal macOS and Windows
releases are produced and gated by CI; see the
[release process](RELEASE_PROCESS.md).

Do not commit generated `dist/`, `web-dist/`, `desktop-dist/`, `release/`,
`data/`, `.opengrove/`, or local evidence files.

## Focused verification

Use the smallest check that covers the change, then widen as needed:

```bash
npm run test:web-development-proxy
npm run test:web-single-startup
npm run test:pack:web
npm run check:desktop-dev-runtime
npm run check:doc-refs
```

Before a broad product change, follow the validation guidance in `AGENTS.md`.

## Troubleshooting

- **Port `37371` or `5173` is busy:** stop the other Bridge/Vite process or set
  `OPENGROVE_BRIDGE_PORT` / `OPENGROVE_WEB_DEV_FRONTEND_PORT` to unused ports.
- **`state_locked`:** another Bridge owns the same SQLite file. Stop it or set a
  different `OPENGROVE_STATE_PATH`; do not delete a live process's lock.
- **`browser_ui_disabled`:** use `npm run bridge:web` or `npm run dev:web`. For
  a direct source CLI launch, run `npm run build:web` and then set
  `OPENGROVE_ENABLE_BROWSER_UI=1`.
- **Host Bootstrap is incompatible with the frontend:** rebuild the server and
  Web assets from the same checkout, then reload the page.
- **Authenticated Web refuses to start:** set `OPENGROVE_WW_BASE_URL` to an
  authorized account-service origin and keep frontend and backend on the same
  environment.
