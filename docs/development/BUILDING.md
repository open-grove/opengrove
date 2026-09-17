# Building OpenGrove

[CI ownership and configuration](CI.md)

This guide covers source setup, Desktop and Web startup, compilation, local
packages, and verification. Run every command from the repository root. Choose
an entry point by goal, then follow its workflow. Formal desktop publication
uses the separate [release process](RELEASE_PROCESS.md).

## Requirements

- Node.js 24 (the series used by CI; `package.json` requires `>=24`).
- npm as bundled with the supported Node.js 24 release.
- macOS, Windows, or Linux; build desktop installers on the matching OS.
- `tar` available on `PATH` to create and inspect Web archives.

The `packageManager` field records a compatible npm version for tools that
honor it; the repository and CI do not require that exact version. Install the
locked dependency tree:

```bash
git clone https://github.com/open-grove/opengrove.git
cd opengrove
npm ci
```

Public npm publication is currently disabled. In a source checkout, use
`node dist/cli.js ...` after building; do not assume a global `opengrove`
command is installed. API-only use needs `build:server`; serving the browser UI
also needs `build:web`.

Inline environment assignments and `export` examples below use Bash/Zsh.
In PowerShell, use `$env:NAME = "value"`, for example:

```powershell
$env:OPENGROVE_WW_BASE_URL = "https://accounts.example.test"
npm run dev:web
```

Service URLs in this guide are placeholders. Replace them with an environment
you are authorized to use before running the commands.

## Choose a command by goal

| Goal | Command | Result and success check |
| --- | --- | --- |
| Develop Desktop | `npm start` or `npm run desktop:dev` | Builds all targets and opens OpenGrove Dev; confirm the UI finishes loading |
| Rebuild and restart Desktop development | `npm run restart:desktop-dev` | Stops development processes, builds, launches, and probes the Bridge; prints its address and PID on success |
| Develop authenticated Web | `npm run dev:web` | Configure the WW origin first; Vite UI defaults to `5173/ui/`, Bridge to `37371` |
| Run built authenticated Web | `npm run start:web` | Configure the WW origin first; one Bridge serves `37371/ui/` and the API |
| Local Bridge browser UI | `npm run bridge:web` | Builds all targets and serves `37371/ui/`; authentication follows environment configuration |
| Compile source only | `npm run build` | Generates `dist/`, `web-dist/`, and `desktop-dist/` without launching the app |
| Inspect packaged Desktop | `npm run pack:desktop` | Creates and checks the application directory under `release/desktop/`, without an installer |
| Create a host-platform installer | `npm run dist:desktop` | Creates the installer and application directory, then runs the script's artifact checks |
| Create a Web backend archive | `npm run pack:web:backend` | Creates and checks `release/web/opengrove-<version>.tgz` |
| Create a Web frontend archive | `npm run pack:web:frontend` | Creates and checks `release/web/opengrove-web-<version>.tar.gz` |

`build` compiles source, `pack` creates an application directory or deployment
archive, and `dist:desktop` creates a desktop installer. Compilation does not
verify startup, and a local installer does not complete a formal release.

Desktop derives its runtime channel from Electron's `app.isPackaged`: source
launches use `dev`, and packaged applications use `stable`. These names are not
Git branches; local packages also run in the `stable` channel. Web has no
separate `stable` configuration switch. This guide distinguishes Vite
development from running built assets.

## Desktop development

```bash
npm run desktop:dev
```

`npm start` uses the same entry point. It builds all targets, then runs
Electron through the development launcher. Source changes are not hot-reloaded;
rebuild and restart with:

```bash
npm run restart:desktop-dev
```

The restart script probes the new Bridge and build timestamps. After it prints
`OpenGrove Dev restarted`, the Bridge address, and PID, check that the window's
UI is usable. An Electron process or a completed build alone does not establish
application readiness.

The default development and packaged channels have separate app identities,
single-instance locks, and data directories:

| Item | Desktop dev | Packaged Desktop |
| --- | --- | --- |
| App name | OpenGrove Dev | OpenGrove |
| macOS / Windows app-data directory name | `OpenGroveDev` | `OpenGrove` |
| Linux app-data directory name | `opengrove-dev` | `opengrove` |

A local `pack:desktop` artifact also uses the packaged channel's data directory
by default. Quit an existing OpenGrove installation before validating it.

To isolate test services and data, configure
`OPENGROVE_DESKTOP_DEV_TEST_WW_BASE_URL` and
`OPENGROVE_DESKTOP_DEV_TEST_RELEASE_CONTROL_URL` from `.env.local.example` in
the root `.env.local`, then run:

```bash
npm run restart:desktop-dev:test
```

This entry point loads `.env.local`, selects the `test` profile, and isolates
data in `OpenGroveDev-test` (`opengrove-dev-test` on Linux). Both service URLs
are required. See [Configuration](../reference/CONFIGURATION.md) for the
configuration boundaries.

## Web development and operation

The `web` command forces browser UI and WW session authentication. It refuses
to start without `OPENGROVE_WW_BASE_URL`. WW is the OpenGrove Cloud API and owns
the account session; the local Bridge still manages Workspaces, Rooms, Apps,
SQLite state, and native Kernel processes. This is a single-Principal runtime,
without multi-tenant or container isolation.

### Combined development

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run dev:web
```

Open `http://127.0.0.1:5173/ui/`. The launcher builds the backend, then starts
`node dist/cli.js web` and Vite together. Vite provides frontend hot reload and
the Web Build ID is `dev`. The backend watcher observes TypeScript/JSON changes
under `src/` and `packages/agent-protocol/src/`, rebuilding and restarting the
Bridge after a successful build. Restart the combined entry point after changes
to other shared packages or build configuration. If either service exits
unexpectedly, the launcher stops the remaining child processes.

For separate logs, use two terminals:

```bash
# Terminal 1: build and start the backend; this entry point does not watch source.
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run dev:web-backend
```

```bash
# Terminal 2: start Vite.
npm run dev:web-frontend
```

Vite proxies `/api`, `/generated`, `/vault-file`, `/apps`, `/mcp-app-sandbox`,
and `/mcp-app-media` to `http://127.0.0.1:37371` by default. Match both terminals'
configuration when using a custom backend port:

```bash
# Terminal 1
OPENGROVE_WW_BASE_URL=https://accounts.example.test OPENGROVE_BRIDGE_PORT=37420 npm run dev:web-backend
```

```bash
# Terminal 2
OPENGROVE_WEB_DEV_BACKEND_URL=http://127.0.0.1:37420 npm run dev:web-frontend
```

`OPENGROVE_WEB_DEV_FRONTEND_HOST` (default `127.0.0.1`) and
`OPENGROVE_WEB_DEV_FRONTEND_PORT` (default `5173`) control the frontend listener.
An occupied port is an error; the launcher does not automatically choose another
one. Set the matching proxy URL when using a custom backend port with the
combined launcher as well.

### Run built assets

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test npm run start:web
```

This runs `build:server`, `build:web`, and `node dist/cli.js web` in sequence.
Open `http://127.0.0.1:37371/ui/`. The Bridge serves `web-dist/` and the API
directly, without Vite or hot reload. With matching backend and frontend builds
already present, start directly:

```bash
OPENGROVE_WW_BASE_URL=https://accounts.example.test node dist/cli.js web
```

Check from another terminal (substitute a custom port if configured):

```bash
curl --fail http://127.0.0.1:37371/api/bootstrap
curl --fail http://127.0.0.1:37371/api/auth/session
curl --fail http://127.0.0.1:37371/version.json
```

Bootstrap should include `environment.preset: "web-single"` and
`auth.mode: "session"`. A fresh browser session before login returns
`status: "unauthenticated"`. The `packageVersion` in `version.json` should
match the root `package.json` used for this build. Open the UI to check resource
loading, then verify login with an account in the target environment. These
local responses alone do not establish that remote login works.

### Local Bridge/API

With the backend built, run the local profile directly:

```bash
node dist/cli.js start
```

`start` and `bridge` are aliases. This entry point does not serve browser UI by
default. Use `npm run bridge:web` to build source and enable the UI, or, with
both backend and frontend already built:

```bash
OPENGROVE_ENABLE_BROWSER_UI=1 node dist/cli.js start
```

The local profile does not force an authentication mode. An explicit
`OPENGROVE_WEB_AUTH_MODE` takes precedence; without it, a configured WW origin
selects session authentication, otherwise bridge-token. To explicitly use local
Token mode, run `OPENGROVE_WEB_AUTH_MODE=bridge-token npm run bridge:web` and
configure `OPENGROVE_BRIDGE_TOKEN` as needed. The `web` profile always forces
session authentication.

## Compile source only

| Command | Build scope and main outputs |
| --- | --- |
| `npm run build:server` | Rebuilds Protocol, Agent Protocol, Client, and the backend; produces `dist/` and the corresponding shared packages' `dist/` directories |
| `npm run build:web` | Builds `web-dist/`, then checks resource references and the development fixture-account boundary |
| `npm run build:desktop` | Builds `desktop-dist/main.cjs` and `desktop-dist/preload.cjs` |
| `npm run build` | Builds the backend and shared packages first, then Web and Electron entry points in parallel |

None of these commands launches the application. `build:desktop` does not build
the backend or Web; use it alone only when those outputs already match source.
Builds clean their corresponding output directories. Do not run independent
build or packaging jobs concurrently in the same checkout.

Web builds use the relative resource base `./` and write the package version
and Build ID into `index.html` and `version.json`. These variables are read
at build time:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `OPENGROVE_WEB_API_BASE` | `../api/` | API Base embedded in the frontend |
| `OPENGROVE_WEB_BUILD_ID` | Current millisecond timestamp encoded in base36 | Overrides the Build ID outside Vite development |
| `OPENGROVE_WEB_SOURCEMAP` | Off | Set to `1` to generate Web source maps |
| `OPENGROVE_DESKTOP_SOURCEMAP` | Off | Set to `1` to generate Electron source maps |

Rebuild the corresponding outputs after changing these variables. Restarting
the Bridge alone cannot modify the already-built frontend.

## Local Desktop packaging

```bash
npm run pack:desktop
```

This builds all targets, minifies `dist/`, stages the bundled Claude Engine for
the current platform/architecture, checks package inputs, creates the
application directory, and checks the artifact. To also create an installer:

```bash
npm run dist:desktop
```

Both commands default to `release/desktop/`:

| Platform | Application directory | Additional `dist:desktop` outputs |
| --- | --- | --- |
| macOS | `mac-arm64/OpenGrove.app`; x64 uses `mac/OpenGrove.app` or `mac-x64/OpenGrove.app` | DMG, ZIP |
| Windows | `win-unpacked/` | NSIS EXE |
| Linux | `linux-unpacked/` or `linux-<arch>-unpacked/` | AppImage |

The application directory is electron-builder's directory output; its contents
still use ASAR packaging. Both commands check package inventory and the Engine.
For targets executable on the current machine, they also probe the packaged
Bridge and run the Engine's `--version`. After command success, open the
application and confirm its UI and Bridge work. Also verify actual installation
and launch when producing an installer.

The local `electron-builder.yml` sets `opengroveOfficialRelease: false`.
Local macOS packages use ad-hoc signing with formal notarization disabled.
These artifacts are for internal validation.

### Multiple architectures

Run on the matching operating system:

```bash
npm run dist:desktop:mac
```

This produces macOS arm64 and x64 artifacts and invokes artifact checks for
both targets.

```bash
npm run dist:desktop:linux
npm run check:desktop-artifact -- --target linux-x64 --target linux-arm64
```

The Linux command produces x64 and arm64 artifacts but does not automatically
invoke final artifact checks, so run the second command explicitly. By default,
cross-architecture checks inspect package contents; they do not establish
runtime behavior on the target machine. On macOS arm64, the checker executes
x64 targets only with a working x64 execution environment and
`OPENGROVE_CHECK_TRANSLATED_ENGINES=1`. The current formal Windows release target
is x64; use `dist:desktop` on Windows.

### Formal desktop releases

`dist:desktop:release` is a low-level entry point in the platform release build
chain, not a complete release. Trusted CI builds candidates, which must pass
installation, startup, update, artifact identity, and platform gates; macOS also
requires signing and notarization. Finalization, registration, and explicit
promotion follow those gates.

`release:readiness` is the candidate workflow's readiness check;
`release:check` is an optional broader local check. Neither replaces CI gates.
The [release process](RELEASE_PROCESS.md) defines candidate requirements,
credentials, and the full procedure.

## Web deployment archives

```bash
npm run pack:web:backend
npm run pack:web:frontend
```

Run these separately, choosing the artifacts you need:

| Archive | Build and contents |
| --- | --- |
| `release/web/opengrove-<version>.tgz` | Runs the full `build`, validates Web outputs, then uses `npm pack --ignore-scripts`; contains `package/package.json`, `package/dist/cli.js`, and `package/web-dist/` |
| `release/web/opengrove-web-<version>.tar.gz` | Runs `build:web`; contains `index.html`, `version.json`, and `assets/` at the archive root, without an extra `web-dist/` directory |

The backend npm package includes frontend assets. A separate frontend archive
is unnecessary when the same Bridge serves the UI. The frontend archive holds
static files only, without the Bridge/API. Independently built archives can
have different Build IDs; the package version comes from the root `package.json`.

Both commands stage and validate the archive before replacing the same-version
destination. Success prints `Created`, size, and SHA-256. A build or validation
failure does not replace an existing archive, although repository build outputs
may already have changed. Override the output directory with:

```bash
npm run pack:web:backend -- --output-dir ../artifacts
npm run pack:web:frontend -- --output-dir ../artifacts
```

Relative paths resolve from the repository root; absolute paths also work.
The output must not be `dist/`, `web-dist/`, `desktop-dist/`, or a descendant of
one of those directories. Inspect the current version's archives with:

```bash
version=$(node -p "require('./package.json').version")
tar -tzf "release/web/opengrove-${version}.tgz"
tar -tzf "release/web/opengrove-web-${version}.tar.gz"
```

## Runtime configuration and state isolation

### Environment variables

CLI `--host` and `--port` take precedence over `OPENGROVE_BRIDGE_HOST` and
`OPENGROVE_BRIDGE_PORT`; the default listener is `127.0.0.1:37371`. The Bridge
preserves existing process environment values and fills only undefined
variables from files in this order:

1. The file named by `OPENGROVE_ENV_FILE`.
2. `~/.opengrove/.env.local`.
3. `.env.local` in the current working directory.
4. `.env` in the current working directory.

This loader belongs to the Bridge. Pass Vite launcher listener/proxy settings
and build variables explicitly to the launching process; do not assume they
load the same Bridge environment files. Environment files also cannot override
the session and UI settings forced by the `web` profile.

Use comma-separated `OPENGROVE_BRIDGE_ALLOWED_ORIGINS` for additional browser
Origins. Keep the listener local; see the [security model](../reference/SECURITY_MODEL.md)
for network and authentication boundaries. Provider setup is covered by
[Configuration](../reference/CONFIGURATION.md) and the
[technical reference](../reference/TECHNICAL_REFERENCE.md).

### Separate data directories

Two processes cannot write the same SQLite state file concurrently. Desktop
development is already isolated from packaged Desktop. To run a separate Web
instance alongside it, configure the Web terminal:

```bash
export OPENGROVE_USER_DATA_DIR="$PWD/.opengrove/web-dev"
export OPENGROVE_DATA_DIR="$PWD/.opengrove/web-dev/data"
export OPENGROVE_STATE_PATH="$PWD/.opengrove/web-dev/data/local-state.sqlite"
export OPENGROVE_BRIDGE_SETTINGS_PATH="$PWD/.opengrove/web-dev/data/bridge-settings.json"
export OPENGROVE_WW_BASE_URL="https://accounts.example.test"
npm run dev:web
```

These set the user-data root, Bridge data directory, SQLite file, and Bridge
settings file respectively. The separate state does not automatically share
Desktop's existing Rooms, Apps, or settings. If ports also conflict, change
both the backend port and Vite proxy URL.

Do not commit `dist/`, `web-dist/`, `desktop-dist/`, `release/`, `data/`,
`.opengrove/`, or local verification logs. Keep Provider keys, account tokens,
and environment configuration in ignored local files, environment variables,
or the Kernel's native credential store.

## Stopping and troubleshooting

Use `Ctrl+C` in the Web source terminal; stop both terminals when running the
services separately. Quit Desktop through its application menu. On macOS,
closing the window alone can leave the process and Bridge running.

| Symptom | Check and resolution |
| --- | --- |
| `state_locked` | Identify the owning process using the reported PID, then quit it or use separate state; do not delete a live process's lock |
| Unreadable lock file | Distinguish the JSON `.lock` marker from the `.lock.sqlite` coordination file as the error directs; do not use wildcard deletion; see local storage in the technical reference for full rules |
| Port `37371` / `5173` is busy | Identify and stop the owning process or change ports; a custom backend port also needs a matching proxy URL |
| UI opens but API calls fail | Check `/api/bootstrap`, the backend address, and proxy; use `/ui/` instead of opening static HTML directly |
| `browser_ui_disabled` | Use `bridge:web` / `start:web`; for the direct local CLI, build Web first and set `OPENGROVE_ENABLE_BROWSER_UI=1` |
| Authenticated Web refuses to start | Check the WW origin; account login still needs a valid account and service in that environment |
| Bootstrap and frontend are incompatible | Rebuild the backend and Web from the same checkout, then reload |
| Packaging fails | Use the first failing stage to check inputs, Engine, version metadata, assets, or `tar`; files in the output directory do not establish successful validation |

On macOS / Linux, inspect processes and ports (replace `12345` with the PID
from the error):

```bash
ps -p 12345 -o pid=,ppid=,lstart=,command=
lsof -nP -iTCP:37371 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

On Windows PowerShell, use `Get-Process -Id 12345` and
`Get-NetTCPConnection -State Listen -LocalPort 37371,5173` for that information.

### Diagnose event long polling

Run `npm run diagnose:event-long-poll` to rebuild the backend and run the isolated
inventory harness with timing output. It uses temporary test data and removes it
on exit. The JSON summary reports event arrival, response validation, SQLite
calls, and event-loop delay; failed assertions produce a nonzero exit code.

To delay only the test client's observation of the triggering PATCH response:

```bash
npm run diagnose:event-long-poll -- --delay-mutation-response-ms=1600
```

The event response should still meet the existing 1000 ms limit. This experiment
checks that trigger-response latency is excluded from event-delivery timing;
it does not establish the cause of a past timeout.

## Focused verification

Select checks for the change. A documentation update does not need the full
release test suite:

| Change scope | Check | Coverage |
| --- | --- | --- |
| Documentation only | `npm run check:doc-refs` | Repository-relative links and bilingual heading structure |
| Web development proxy | `npm run test:web-development-proxy` | Builds the backend and checks the Vite proxy |
| Built Web startup | `npm run test:web-single-startup` | Builds the backend and Web; checks UI, Bootstrap, logged-out Session, and version |
| Web packaging | `npm run test:pack:web` | Unit checks plus actual builds, packaging, and archive inspection |
| Desktop development startup | `npm run check:desktop-dev-runtime` | Development identity, process detection, startup, and lock recovery logic |
| Host-platform Desktop packaging | `npm run pack:desktop` | Build, input, and artifact checks; open the application afterward |

Report the commands run, platform/architecture, actual artifact paths, and
runtime behavior that was or was not checked. For broader changes, follow the
validation ladder in [AGENTS.md](../../AGENTS.md).

## Implementation entry points

Use these files to verify or update this guide against actual behavior:

- [package.json](../../package.json): available commands and command chains.
- [Build orchestration](../../scripts/build.mjs), [backend build](../../scripts/build-server.mjs), and [client builds](../../scripts/build-clients.mjs): build dependencies and ordering.
- [Desktop main](../../desktop/main.ts) and [development restart](../../scripts/restart-desktop-dev.mjs): channels, data isolation, and readiness probes.
- [Combined Web launcher](../../scripts/start-web-dev.mjs) and [Vite configuration](../../vite.config.ts): watched paths, proxy routes, and build metadata.
- [Web profile](../../src/profiles/web-single.ts) and [Bridge configuration loader](../../src/server/bridge-security.ts): authentication and environment precedence.
- [Web packaging](../../scripts/pack-web-artifact.mjs), [Desktop packaging configuration](../../electron-builder.yml), and [Desktop artifact checks](../../scripts/check-desktop-artifact.mjs): archive layout and verification scope.
