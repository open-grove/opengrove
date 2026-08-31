# OpenGrove App Directory Spec

An OpenGrove App is a local directory mounted from Settings -> Apps. It is the
top-level unit for business or product-specific capabilities: UI, skills,
tools, MCP config, hooks, scripts, and assets can live together under one root.

OpenGrove stores only the app root path, enabled state, and optional display
name in user settings.

In this spec, an App is the top-level product/business package that organizes
UI, skills, CLIs, tools, MCP config, hooks, scripts, assets, and workspace files
into a mounted workspace.

## App platform entry points

Creating an app in OpenGrove is not just saving a path. It creates or imports a
portable workbench package. Settings -> Apps exposes two entry paths:

- **Import an existing App**: the user provides a local directory or URL.
  OpenGrove sends the source, optional name, and integration boundaries to the
  default kernel/agent. The agent first decides whether the source already has
  a complete UI. If it does, preserve it and package it as a standard MCP App
  resource. If it does not, choose a Host-owned file workbench or build a new
  MCP App UI around the app's capabilities.
- **Create from description**: the user describes the desired workbench in
  natural language. The Host creates and immediately opens a `setup` skeleton,
  then deterministically asks whether to use the built-in workbench or build a
  custom View. The App Builder creates the real UI/workspace, required skill/CLI
  docs, and smoke data after that choice.

Import and creation tasks should trigger the `opengrove-app-builder` skill. The
skill is the agent guardrail for app integration: app root, workspace
boundaries, UI reuse, command contracts, model/API dependencies, and validation
results must be explicit.

Import sources are classified before editing:

- Local folders can be inspected in place.
- Git/GitHub URLs are cloned into an OpenGrove-managed staging directory.
- Archive URLs are downloaded and unpacked into staging.
- Ordinary project paths or URLs are classified as web projects, CLI toolkits,
  script collections, knowledge directories, or mixed projects before the agent
  chooses whether to wrap, scaffold, or generate UI.

OpenGrove exposes deterministic helper commands for agents:

```bash
opengrove app inspect <source>
opengrove app import <source> --target <app-dir> --id <id>
opengrove app stage <source> --apps-dir <managed-apps-dir> --id <id>
opengrove app scaffold <target> --id <id> --title <title>
opengrove app validate <app-root>
opengrove app report <app-root>
opengrove app mount <app-root> --settings <settings-path>
```

These commands do not replace the agent's judgment. They make the App boundary,
manifest contract, and validation result explicit and repeatable.

The examples use the installed command name. In a source checkout, run
`npm run build:server` and replace `opengrove` with `node dist/cli.js`.

`stage` is the deterministic landing step for imports: Git sources are cloned,
archives are downloaded and unpacked, and local directories can either be
referenced in place or copied with `--copy`. `report` combines source
classification, manifest validation, and the recommended mount entry. `mount`
updates a known bridge settings file only after the app is ready to mount.

## App Store distribution

The App Store registry distributes portable App packages; it is not a remote
runtime for those Apps. OpenGrove downloads and unpacks an installed package
directly into its platform-native Programs directory. The mounted App, its employees,
`AGENTS.md`, skills, tools, hooks, and later agent edits all live on the user's
machine. Workspace files created or preserved after installation also remain
local to that user.

Store-managed program files and the App Workspace have separate lifecycles.
Each install or formal-version switch creates a new program generation, binds
the manifest-declared workspace location to the Host-owned persistent
Workspace, validates the result, and only then changes the mounted program
pointer. The previous program is cleaned up after the pointer is committed; a
temporary Windows file lock may defer that cleanup but cannot move, replace, or
delete the Workspace. A one-time Host layout migration copies and validates the
legacy Workspace and program in sibling staging directories, renames each copy
into its final platform-native root, and atomically switches both mount paths.
The old paths remain authoritative on failure and are only renamed, never
deleted, after the migrated App starts successfully. A fresh install uses this
separated layout immediately.

Activation seeds the App's declared Employees and, by default, one App-scoped
PM binding. The PM starts as a Room administrator but remains an ordinary,
optional App Employee: `disablePmAgent: true` suppresses it, and a user may
remove it from a Room or revoke its administrator role. Those choices are
persisted and are not undone by startup reconciliation. A default or newly
created App Room is persisted only when at least one active App Employee is
available; missing Provider, model, or Kernel capability remains readiness
state rather than an App-wide startup failure.

WW may recommend default Apps through an independent per-user install policy.
The policy can be assigned by registration source or by an authorized WW
administrator, but it is not derived by the Host from the user's Roles. After
authentication, the Host reads that resolved policy and uses the normal
App Store download, verification, installation, activation, and rollback path
for missing Apps. When the Host `clientReleaseNumber` changes, it also updates
currently assigned, trusted Store installations that were originally installed
by the default-App policy when the Store version is newer. A pre-existing manual
Store installation satisfies the policy but remains user-managed. The same Host
release does not repeatedly download updates, although an
explicit policy `minimumVersion` may require an earlier update. Explicit
uninstall, disable, manual mount, relink, and source-conflict decisions remain
authoritative; removing an assignment does not uninstall the App or delete its
workspace.

`opengrove app pack` and `publish` exclude the complete manifest-declared
workspace root and its contents. The workspace is mutable per-install user
state, not a published asset. It may be entirely absent on a fresh install,
while an update preserves the existing workspace. An App must not assume that
workspace seed files from its developer's machine ship in the package: first
launch or the first command must create required directories and treat
`ENOENT` as uninitialized state when the workflow can bootstrap it. Release
verification must extract the actual `.tgz` into an empty directory and run
first launch or the first real command. A development or updated install with
preserved workspace state is not equivalent evidence.

An App that depends on Host behavior introduced in a specific client release
must declare `store.minHostReleaseNumber` as that positive integer release
number. The Host sends its `clientReleaseNumber` to the registry. For Hosts
that understand compatibility notices, the registry returns incompatible
catalog entries without install-archive metadata; it omits those entries for
legacy Hosts and rejects all incompatible detail or download requests. This
lets current Hosts prompt for a Host update while legacy Hosts do not see an
installable App update. The Host repeats the check before downloading or
mutating local files. A missing minimum keeps the package compatible with older Hosts.

Publishing is retry-safe for one logical package version. OpenGrove derives a
stable idempotency key from the registry, local App identity, optional package
identity, version, kind, visibility, and draft digest. Before the remote
request, the Host persists the local draft and a publish-intent journal. The
journal follows the same Release
Commit, GitHub CI run, immutable artifact digest, and registry version through
retries; reopening the App Store resumes an unfinished intent instead of
creating another version. If source content changes while the same version has
an unfinished journal, OpenGrove stops and requires restoring that intent or
bumping the version.

The unfinished-release lock is scoped to one App, not the whole catalog. Any
current WW Admin may inspect the same remote intent and may continue it only
when the complete saved release request—source, version, metadata, and publish
base—matches the request already bound to that intent. A different local
request is never silently substituted; its Admin must wait for the existing
intent to finish or explicitly end it after the stale threshold. An
`awaiting_candidate` or `building` intent remains protected while it is making
progress; only after two hours without a persisted state update may an Admin
explicitly end it and start again. Ending uses the last observed state update
as a compare-and-swap guard, so a task that advances concurrently is not
terminated. Failed trusted builds remain explicitly endable immediately.

Published packages must be safe to share with another user and complete enough
for an authorized App member to continue editing locally. They must include the
runnable assets, full editable UI/source inputs, build configuration and lock
files, templates, manifest metadata, employees, skills, hooks, and scripts.
The Host excludes Git history, known native session/config directories,
caches, and workspace content by structural path rules. Arbitrary source file
contents remain opaque to packaging; publishers remain responsible for not
including provider keys, database URLs, local absolute paths, private data
dumps, or machine-specific tokens. App-specific setup should be described in
`AGENTS.md` or a bundled skill so Grove or the App employee can guide the user
after install.

The mounted-App **Save and Publish** surface is available to every authorized
App member for saving the one device-local draft. Formal publishing remains an
administrator operation: only an administrator sees and may invoke it, and the
remote service must enforce the same rule. Before formal publishing, the Host
prepares a release snapshot from the mounted App manifest and the current
effective configuration of every enabled App employee. The administrator may
edit the App metadata, an upward semantic version, release notes, visibility,
and employee installation defaults on the same page. These edits do not mutate
the mounted runtime while the page is open. Each App may persist one
device-local draft with no SemVer and no cloud sync;
the draft belongs to this OpenGrove installation rather than the WW account.
Publishing saves the current page into that draft before validation. A failed
or interrupted publish preserves it. Uninstall asks whether to retain or delete
the draft and defaults to retaining it; revoking remote App visibility never
deletes an existing local draft. The version-management surface can reopen the
saved draft as the App's current runnable content without changing the
device-selected formal version or the draft's publish base; switching back to a
formal version does not delete the draft.

An App root becomes a Git working copy as part of a successful App Store install
or local import; installation must not report success before the initial source
save point exists. The Host uses its bundled Git
implementation for new local history and does not require a system `git`
installation. Host-managed repository metadata lives under the local App data
directory and a new App root contains only a standard `.git` pointer, so Codex,
the App Builder, and ordinary Git tools observe that working copy. When an
imported App is already a repository or linked worktree, its own `.git`, HEAD,
branches, index, ignore policy, and history remain authoritative and untouched.
OpenGrove records release save points for that external working copy in a
separate device-local repository that is not connected to the user's branches
or remotes. Workspace data, untracked files matched by the repository's ignore
rules, credentials covered by structural exclusions, caches, and other
machine-only runtime state do not enter those save points. Files already tracked
by an adopted repository retain ordinary Git semantics even when a later ignore
rule also matches them. Saving first creates an explicit source save point and
then writes the recoverable draft; the durable
release journal records the save-point commit used by each formal release.
Version management reports whether program-source edits remain unsaved and when
the current source save point was created without exposing Git implementation
terms in the product UI. Publishing materializes its input from that immutable
save point, so later edits in the live App belong to the next save and cannot
silently alter the release already underway.
Formal version activation and draft reopening must preserve both the `.git`
connection and Workspace rather than overwriting local editing history with
Store package state.
After a formal version activates successfully, the Host records the exact
installed program as the next source save point. Release-time normalized fields
such as the version and release notes therefore do not appear to an Agent as
spurious unsaved edits in the new version.

For formal publishing, the Host first saves an immutable source save point and
materializes the recoverable prebuild draft from it. When a local release build
recipe exists, the Host executes its argv commands in an isolated copy of that
exact draft, transactionally promotes only declared outputs, and saves a
postbuild exact draft. Build failure, cancellation, timeout, a change to the
selected materialization, or an App install-generation change must not create a
remote release. Unrelated edits made later in the live working copy remain
local and do not alter the selected release input.
Build commands must not daemonize or deliberately escape their Host-owned
process group; the Host terminates and awaits that process group on success,
failure, timeout, and cancellation, but does not scan or signal unrelated OS processes.
This isolation and environment filtering are not an OS sandbox: build commands
still run with the current OS user's authority, so administrators must publish
only Apps from trusted sources.
Until the Windows Host owns builds through a native Job Object, a local release
recipe fails closed on Windows before any build command or remote release starts.
The Host then normalizes the postbuild draft into a
content-addressed source snapshot and sends it through a controlled Release
Control upload session. This source transport is bound to the draft digest and
expected `main` SHA. It exists only so Release Control's GitHub App can create
the candidate Git tree: it is not the formal tgz, is never indexed in the
registry, and is not installable. A source snapshot may contain at most 5,000
files; Workspace and other local-only paths remain excluded from that count and
from the snapshot. Release Control validates the source manifest
and creates Git objects but does not run App build scripts in its service
process. WW supplies only account, status, and role facts; it does not receive
source, orchestrate releases, or store new formal App versions.

During the compatibility window, the existing GitHub workflow may replay the
same recipe without release credentials; that replay's outputs are discarded
and are never distributed. Only after the local-build Host release is enforced
as the minimum publisher version and old runs are drained may that replay be
removed. The target workflow then uses the fixed-SHA Builder to produce the
formal tgz from the exact candidate commit, and GitHub Actions Gate performs one
complete semantic validation of those real bytes. The first artifact that
passes every gate becomes the release's sole accepted
artifact and pins its digest. The tag, GitHub Release, registry, and clients
reuse those exact bytes; no downstream component rebuilds or replaces them.
Before publishing, Release Control confirms the live Admin identity through WW,
then orchestrates the release, indexes it in the registry, and provides exact
downloads of the immutable OSS artifact; it does not accept a client tgz and
rebuild it. If the
administrator leaves "apply to my current App" disabled,
the selected formal version stays unchanged and the local draft remains with
its publish base advanced to the new version. If enabled, the Host activates
the exact released artifact, applies its complete employee defaults, selects
that formal version, and closes the local draft. Both paths preserve the local
workspace and Room history.

The formal sequence is candidate commit, retryable CI gates, accepted-artifact
digest pinning, a final `expectedMainSha` compare-and-swap of `main`, immutable
tag creation, attachment of the already accepted bytes to GitHub Release, and
registry indexing. A first release uses an absent-`main` precondition. Until
every stage of one release intent is reconciled, OpenGrove does not report
success and Release Control rejects the next formal release for that App.

The trusted publishing workflow is a platform supply-chain boundary, not App
content. App source and drafts cannot replace that workflow or read release
secrets. App-declared build and test commands run in the Host's isolated draft
copy without publishing credentials. During migration the legacy GitHub replay
also has no release credentials and its outputs are discarded; after the
compatibility gate is complete, GitHub runs only the platform-pinned Builder
and Gate.

The release snapshot is authoritative for a fresh installation. The admin-only
identity panel may show the local App and workspace roots for source review,
but those machine paths are omitted from the publish submission and package.
Installers do
not confirm or reinterpret employee defaults. `store.employeeDefaults` may
carry employee identity, role, kernel/model, reasoning effort, context token
budget, access mode, Skills, visibility, and public contract fields. The Host
still adds installation-specific App context to employee roles and keeps later
local edits as per-install user overrides. An Employee's effective reasoning
effort resolves in this order: explicit user override, compatible App default,
then Kernel default. An App default unsupported by the selected Kernel falls
back to that Kernel's default without creating a user override. Publishing is
blocked when the version is not newer, the manifest/UI is invalid,
App-qualified Skills are missing, or package validation finds an unsafe archive
structure, forbidden Workspace content, invalid package identity, or malformed
runtime receipt metadata. App file contents are opaque to the package
validator. Missing release notes and a missing completed trial are warnings.

For an App with no registry history, the page suggests `0.1.0`; the
administrator's first publish creates the unique repository mapping and initial
`main`. Conflicts among the App id, package key, registry identity, or existing
repository mapping block publishing.

Every installed App has one device-selected formal version. A new release does
not silently change it. The version-management surface lists the registry's
formal versions and can activate an exact compatible version through the same
transactional install seam. Compatibility continues to use
`store.minHostReleaseNumber`; switching replaces program content and employee
defaults but never rolls back workspace, chats, credentials, business data, or
the saved local draft.

## UI strategy

`ui.surface` selects the App's own canvas. It is separate from the protocol
used by a custom View. Apps do not receive a second titlebar; the current
App's development mode is entered from the global OpenGrove titlebar:

1. **Setup**: a newly scaffolded App starts as `ui.surface: "setup"`. The Host
   renders the deterministic workbench/View choice and opens the App room by default;
   setup Apps cannot be packed or published.
2. **Host-owned workbench**: use `ui.surface: "file-workbench"` for
   file/artifact workflows. Apps may select closed Host components or hand one
   tab's canvas to an App-owned standard MCP App View. Custom code still never
   executes in the Host's same-origin page.
3. **Portable custom View**: use `ui.surface: "view"` plus
   `ui.view.protocol: "mcp-app"` when a custom frontend owns the whole App canvas;
   use `ui.tabs[].component: "view"` when retaining the file-workbench shell. Both
   expose the built browser entry as a standard `ui://` resource with MIME type
   `text/html;profile=mcp-app`; the View talks to the Host through the MCP Apps
   protocol and only its manifest-declared per-App tools.
4. **No canvas**: use `ui.surface: "none"` for Apps whose product surface is
   employees, skills, CLIs, MCP servers, or routines rather than visual UI.
Use the `view` surface when a complete existing frontend must be preserved.
React, Vue, Svelte, Canvas, TypeScript, server-backed code, and other normal App
sources may produce the browser bundle; the final HTML resource is not the App's
source model or capability boundary. Adapt Host integration to standard MCP
Apps calls; do not retain direct Bridge HTTP calls or create a same-origin
custom mount.

Legacy `ui.kind` manifests are read without automatic rewriting:
`file-workbench` maps to the matching surface and `mcp-app` maps to a `view`.
The reserved `ui.kind: "native"` and `ui.kind: "custom"` values remain
unsupported and must never be interpreted as the new `view` surface.

Generic behavior should be extracted into shared components and reconnected
through business adapters. Directory trees, Markdown/media previews, settings
forms, status lists, and chat panels should not be forked per App. If an
existing component is too bound to one business domain, split out the generic
layer first.

## MCP App contract

A minimal custom UI declaration is:

```json
{
  "ui": {
    "surface": "view",
    "workspace": "workspace",
    "view": {
      "protocol": "mcp-app",
      "entry": "ui/index.html",
      "tools": [
        "opengrove.app.workspace.list",
        "opengrove.app.workspace.read"
      ],
      "csp": {
        "connectDomains": [],
        "resourceDomains": [],
        "frameDomains": [],
        "baseUriDomains": []
      }
    }
  },
  "workspace": { "path": "workspace" }
}
```

The supported per-App tools are `opengrove.app.workspace.list`,
`opengrove.app.workspace.read`, `opengrove.app.workspace.write`,
`opengrove.app.flows.list`, `opengrove.app.command.run`, and
`opengrove.app.media.cache`. The manifest is an
allowlist: omitted tools are rejected. `command.run` accepts only a
`commandId` declared in `capabilities.cli`; it cannot execute an arbitrary
command supplied by the View.

`command.run` treats `parseJson` as a structured-result contract. With the
default `parseJson: true`, non-empty invalid JSON fails with
`command_output_not_json`, while an exit-zero command with empty output remains
successful and omits both `json` and `stdout`. Output beyond the Host capture
budget fails with `structured_output_too_large`; the Host never returns partial
JSON as a successful result. A successful structured result is exposed in
`json` without duplicating it in `stdout`. Apps that intentionally return text
must set `parseJson: false`; text results include byte counts and explicit
truncation flags. `stdoutBytes` and `stderrBytes` count all raw bytes emitted by
the process; `capturedStdoutBytes` and `capturedStderrBytes` count the raw bytes
retained within the Host budget before text trimming and UTF-8 boundary repair.

`media.cache` downloads a manifest-approved HTTPS
media URL into the App's hidden local cache and returns a short-lived local
Range playback URL and a `workspacePath` relative to this App's workspace once
the complete file is ready. The Host does not expose an absolute machine path
to the View. A declared App CLI resolves `workspacePath` against the injected
`OPENGROVE_APP_WORKSPACE_ROOT`, not against its command working directory.
`workspacePath` locates evictable cache data; it is not a durable reference.
The cache limit covers complete files,
partial files, and in-flight reservations. A file with an
active HTTP playback lease is not eligible for LRU eviction.

The View runs in a cross-origin, opaque-origin iframe without
`allow-same-origin`. The sandbox origin serves only the MCP App proxy assets;
all Bridge API paths return `404` there. The default CSP denies network access.
Only validated HTTPS domains declared by the App are added, and the Host and
sandbox origins are always removed. Hosted deployments must route a dedicated
origin configured with `OPENGROVE_MCP_APP_SANDBOX_ORIGIN` to the Host's sandbox
handler.

When the Host advertises `fullscreen`, a View may request it through the MCP
Apps display-mode protocol. Fullscreen always retains a Host-owned exit button;
Escape exits whether focus is in the Host or the sandboxed View. If the iframe
reloads, the replacement bridge inherits the live Host display mode instead of
reporting stale `inline` state.

### Host UI capabilities

The Host declares its UI capabilities from a single registry, and every platform
advertises the same surface — a capability an App can use in the web Host it can
also use in the desktop Host. Apps never declare which Host
capabilities they need, and the manifest has no field for that.

| Capability | What the App can do | Where it lands |
| --- | --- | --- |
| `openLinks` | `app.openLink({ url })` | User confirms the destination once per request, then the browser opens it |
| `downloadFile` | `app.downloadFile({ contents })` | User confirms one batch, then the Host writes it through the browser download path |
| `serverTools` | `app.callServerTool(...)` | The per-App tools declared in `ui.view.tools` |
| `serverResources` | `app.listServerResources(...)`, `app.readServerResource(...)` | The App's own MCP resources |
| `logging` | `app.sendLog(...)` | Host diagnostics; never the conversation |
| `sandbox` | Read the CSP and iframe permissions the Host applied | Derived from `ui.view.csp` |

`message`, `updateModelContext`, and `sampling` are part of the spec's capability
set but are not advertised yet, so their requests are rejected. Never assume a
capability: read `app.getHostCapabilities()` after `connect()` and degrade in the
UI.

```ts
const capabilities = app.getHostCapabilities();

if (capabilities?.downloadFile) {
  await app.downloadFile({
    contents: [{
      type: "resource",
      resource: { uri: "file:///chapter-3.txt", mimeType: "text/plain", text },
    }],
  });
} else {
  showHint("Copy the chapter text manually.");
}
```

Rejection is shaped by the spec, not by convention. `ui/open-link` and
`ui/download-file` answer with `isError: true` when the user cancels or the Host
refuses.

Host-side limits apply before anything reaches the user: links up to 4096
characters and downloads up to 5 files of 8 MiB each. A background View is
refused both capabilities until the user brings it forward.

## File workbench tabs

Apps using `ui.surface: "file-workbench"` may declare workbench tabs. The built-in
component pool is closed and owned by OpenGrove. For business-specific UI, an App
may declare a `view` tab that owns the main canvas through the standard MCP App
contract; its code remains inside the cross-origin sandbox.

```json
{
  "ui": {
    "surface": "file-workbench",
    "workspace": "workspace",
    "workbenchLayout": { "filesWidth": 180, "chatWidth": 800 },
    "tabs": [
      { "component": "file-tree", "label": "Files" },
      { "component": "flow-list", "label": "Workflow" },
      {
        "component": "dashboard",
        "label": "Dashboard",
        "source": { "type": "local_mock" }
      },
      {
        "id": "work-management",
        "component": "view",
        "label": "Work management",
        "view": {
          "protocol": "mcp-app",
          "entry": "ui/work-management.html",
          "tools": ["opengrove.app.workspace.list"]
        }
      }
    ]
  }
}
```

`ui.workbenchLayout` optionally declares the file and chat widths, in pixels,
used the first time that App opens. The Host clamps declared values to its
supported range. A divider adjustment is stored locally per App and takes
precedence over the manifest default. Resizing the window only constrains the
effective width; it does not overwrite the saved preference, which returns when
space becomes available again. Apps that omit the declaration use the Host
defaults: `280px` for files and `420px` for chat.

If `ui.tabs` is absent, OpenGrove falls back to `file-tree` and `flow-list`.
Unknown components are ignored with a warning. Supported components:

- `file-tree`: App workspace file tree with create, import, rename, move, delete,
  and preview integration.
- `flow-list`: `*.flow.md` workflow status list backed by the App workspace.
- `dashboard`: Structured report list and detail pane. The dashboard bridge route
  returns desensitized grades and qualitative guidance. In the temporary local
  implementation, the whole dashboard can run from local mock data, and commission
  is a display-only mock field marked with
  `source: "local_mock"` and `mock: true`; Apps must not treat it as settlement
  data.
- `view`: An App-owned MCP View. It must declare a URL-safe, App-unique `id` and
  a complete `view` contract. When active it owns the workbench canvas while Host
  tabs and the current App Room chat remain available. Contract failures stay in
  that canvas, and each View Tab receives only its own `view.tools` allowlist.

## Workspace write experience

Apps that produce user-visible files should write to:

```text
workspace/runs/<task-or-command>-<timestamp>/
```

File workbenches must provide operations a user can understand: browse,
preview, create file/folder, rename, move, delete, and refresh. Every write must
stay inside the manifest-declared workspace or the App root.

## Required root

Each app should provide a manifest at:

```text
opengrove.app.json
```

Minimal manifest:

```json
{
  "id": "sample-workbench",
  "title": "Sample Workbench",
  "description": "Portable workflow package for OpenGrove.",
  "version": "0.1.0"
}
```

`id` must be stable, lowercase, and URL-safe. App and Employee ids are
case-insensitive identities, so manifests reject uppercase spellings instead of
silently collapsing two declarations. `title`, `description`, and `version`
are used for display and inventory only.

## Localized display metadata

An App may keep its default display strings at the manifest root and declare
display-only translations under `locales`. `defaultLocale` identifies the
language of the root strings. Locale keys must be valid BCP 47 language tags,
and localized tabs, employees, and CLIs are keyed by their stable manifest
ids:

```json
{
  "defaultLocale": "zh-CN",
  "welcome": { "message": "欢迎使用示例 App。" },
  "ui": {
    "tabs": [
      { "id": "workspace", "component": "file-tree", "label": "工作区" }
    ]
  },
  "employees": [
    {
      "id": "writer",
      "name": "作者",
      "role": "Canonical runtime role.",
      "publicDescription": "负责内容创作。"
    }
  ],
  "capabilities": {
    "cli": [
      { "id": "sample", "command": "sample", "title": "示例命令" }
    ]
  },
  "locales": {
    "en": {
      "title": "Sample App",
      "description": "A localized sample.",
      "ui": {
        "tabs": { "workspace": { "label": "Workspace" } }
      },
      "employees": {
        "writer": {
          "name": "Writer",
          "publicDescription": "Creates content."
        }
      },
      "capabilities": {
        "cli": {
          "sample": {
            "title": "Sample CLI",
            "description": "Runs the sample workflow."
          }
        }
      },
      "welcome": { "message": "Welcome to the Sample App." }
    }
  }
}
```

Only App `title`/`description`, tab `label`, employee `name` and
`publicDescription`, CLI `title`/`description`, and `welcome.message` are
localizable. Runtime identity and behavior fields such as `id`, technical
`name`, `role`, `instructions`, `inputSpec`, `outputSpec`, Skills, commands,
workspace paths, and `ui.agentContext` remain canonical. The Host never injects
localized display metadata into an Agent prompt. Categories, when present in a
catalog, are stable enum codes and are translated by the Host rather than by
the App manifest.

## Capability layout

OpenGrove scans these paths relative to the app root:

```text
opengrove.app.json
AGENTS.md
skills/<skill-name>/SKILL.md
skills/<group>/<skill-name>/SKILL.md
bin/<local-cli>
tools/
mcp.json
hooks.json
ui/
assets/
workspace/
```

Current runtime behavior:

- `skills/` is loaded into the skill catalog when the app is enabled. Apps may
  place skills directly under `skills/<skill-name>/SKILL.md`, let OpenGrove
  discover grouped skill roots recursively, or declare exact roots with
  `skills.roots`.
- `AGENTS.md` or `agents.md` is loaded as App-bound employee instruction
  context when the app is enabled.
- CLIs declared in `capabilities.cli` are added to the extension inventory.
  They remain business-level atomic commands that agents can run through Bash;
  OpenGrove does not turn them into tools by default.
- `mcp.json` and `hooks.json` are exposed as external app-owned configuration
  roots for kernels that support those concepts.
- `ui/` contains MCP App entry resources. A custom View should be built as one
  bundled HTML resource so another MCP Apps Host can render it without
  OpenGrove-specific asset routes.
- Manifest `ui.view.tools` selects the Host-owned per-App bridge tools exposed to
  that View; arbitrary tool definitions under `tools/` are not trusted merely
  because they exist on disk.
- `workspace/` is the default artifact directory for the App. OpenGrove file
  tree, raw file APIs, and previews read it through `WorkspaceStore`.

## CLI declarations

Apps can explicitly declare business CLIs in the manifest:

```json
{
  "capabilities": {
    "cli": [
      {
        "id": "sample-workflow",
        "title": "Sample Workflow",
        "command": "./bin/sample-workflow",
        "targets": {
          "darwin-arm64": "./bin/macos/sample-workflow",
          "darwin-x64": "./bin/macos/sample-workflow",
          "win32-x64": "./bin/windows-x64/sample-workflow.exe",
          "linux-x64": "./bin/linux-x64/sample-workflow",
          "linux-arm64": "./bin/linux-arm64/sample-workflow"
        },
        "doctor": ["doctor"],
        "smoke": ["smoke"],
        "env": ["SAMPLE_WORKFLOW_ROOT"],
        "artifacts": ["workspace/runs/**"],
        "allowNativeBash": true
      }
    ]
  }
}
```

OpenGrove resolves relative paths, checks whether the command is executable,
and shows the result in the CLI area of the extension manager. `doctor`,
`smoke`, `env`, and `artifacts` are currently inventory declarations; the
future Runner will use them for self-checks and managed runs.

An App-owned native CLI can declare a `targets` map keyed by
`process.platform-process.arch`: `darwin-arm64`, `darwin-x64`,
`win32-arm64`, `win32-x64`, `linux-arm64`, or `linux-x64`. The Host chooses
only from its actual process platform and architecture; browser platform
signals do not participate. Declared target paths must stay inside the App.
App validation and managed execution verify file presence, native format,
CPU architecture, and Unix execute permission before spawn. When `targets`
is present, a missing current-platform target is an error rather than a
fallback to another platform.

`command` / `bin` may name either an App-owned relative path or a bare command
installed independently by the user. For the latter, OpenGrove discovers the
executable from the current `PATH` and conventional user-level command
directories; it neither bundles the CLI into the App nor installs or logs in
for the user.

Fixed command arguments belong in `args`. They are placed before arguments
supplied by each `command.run` call and remain separate argv entries; the Host
does not concatenate them into a shell command. For example, an App-owned Node
script is declared as:

```json
{
  "id": "sync-report",
  "command": "node",
  "args": ["scripts/sync-report.mjs", "--fixed"]
}
```

The Host resolves the relative script against the App root and verifies it
during both publishing validation and managed execution, including scripts
that follow leading Node flags. Node source-text modes (`-e` / `--eval` and
`-p` / `--print`) are not treated as script paths. Root containment checks
resolve symbolic links before accepting the script. Existing manifests that
put fixed arguments in `command`, such as
`"node scripts/sync-report.mjs --fixed"`, remain supported, but new manifests
should use `command` plus `args`.

Every mounted App Employee runtime receives that same user-level command search
path, whether or not the App declares `capabilities.cli`. A CLI declaration is
inventory/readiness metadata and the allowlist for Host-managed
`opengrove.app.command.run`; it is not an OS-shell permission boundary. Native
App Employees can run commands visible to the current local OS user, and a
global CLI may use its own existing user login state. Enabling and running an
App Employee therefore trusts the App's employee instructions and skills as
local agent code. Do not mount or run untrusted Apps. The MCP App View remains
separately confined by its sandbox, CSP, and manifest-declared per-App tool
allowlist, and still cannot submit an arbitrary executable to `command.run`.
Future untrusted or multi-tenant execution requires an OS-level sandbox or a
separate execution identity before this trust decision can be relaxed.
Host-managed calls use the declaration `commandId`. The legacy Routine
`command` field is accepted only when it exactly matches that declaration; it
is never executed as an unresolved raw command.

Skills installed by a general Skills installer under
`~/.agents/skills` enter the OpenGrove catalog, but a specific Employee still
receives them only through the existing explicit Skill assignment.

## Skill roots

Apps with grouped skill collections can declare collection roots explicitly:

```json
{
  "skills": {
    "roots": [
      "skills/workflow-tools",
      "skills/document-tools"
    ]
  }
}
```

Each listed root should contain one or more `<skill-name>/SKILL.md`
directories.

## Default employees

Apps can declare default room employees in the manifest. OpenGrove reads these
declarations generically and binds each employee to the App id and App
workspace. If no employee is declared, the Host does not create a generic App
Operator. Unless `disablePmAgent` is true, the optional default PM can complete
safe work within the current App when it has the required capability, or ask
the user to add an employee. Users can remove or demote that PM like any other
Room member. Users can also add global employees from the App group member panel. Adding the App Builder
creates a scoped binding for the current App; the global `app-builder` member id
never joins an App group directly.

```json
{
  "employees": [
    {
      "id": "asset-editor",
      "name": "Asset Editor",
      "kernel": "claude-code",
      "model": "claude-code-default",
      "role": "Prepare workspace assets and previews.",
      "defaultSkillIds": ["asset-query", "project-render"]
    }
  ]
}
```

The same array may also appear at `capabilities.employees` or
`rooms.employees`. Employee ids must be lowercase, URL-safe, and unique across
all Employee declaration arrays in one App. OpenGrove scopes each Employee id
to the exact App id and uses an unambiguous component encoding when it creates
Room members. Default skills are merged from employee
`defaultSkillIds`/`skills`, manifest skill declarations, and `skills/*/SKILL.md`
names.

When an App Employee omits `kernel`, the Host materializes the product Kernel
`claude-code`; when that Employee also omits `model`, it receives the concrete
product model `deepseek-v4-flash`. An Employee that explicitly selects another
supported Kernel and omits its model keeps that Kernel's `${kernel}-default`
runtime marker. App seeding does not inspect machine-local Kernel configuration,
so the same App declaration remains portable between devices. Host product
Employees have their own defaults: Grove Guide uses `deepseek-v4-flash`, App
Builder uses `claude-opus-4-8`, and PM uses `deepseek-v4-flash`, all on
`claude-code`. These defaults leave the Employee Provider route empty so the
saved default for the selected model remains authoritative. The legacy model
value `native` is upgrade input only and is never emitted for new Employee
state.

## Runtime environment injection

Apps can ask OpenGrove to inject provider keys into that App's agent/runtime
environment. This is for private business CLIs that expect conventional env
vars, while the user configures credentials once in OpenGrove Providers.

```json
{
  "runtimeEnv": {
    "providerKeys": [
      {
        "providerId": "aws-bedrock-api-key",
        "env": {
          "apiKey": "AWS_BEARER_TOKEN_BEDROCK"
        },
        "required": false
      },
      {
        "providerId": "gemini",
        "env": {
          "apiKey": ["GOOGLE_API_KEY", "GEMINI_API_KEY"]
        },
        "required": false
      }
    ]
  }
}
```

OpenGrove resolves the provider from settings, reads the stored key or provider
key environment variable, and injects only the requested env names for turns
started from that mounted App. Secret values are not written into prompts,
events, file previews, inventory records, or App settings.

For Codex, OpenGrove starts an app-server process keyed by the injected runtime
environment, so App-specific env does not bleed into normal chat turns or other
Apps.

## Flow files

Apps may describe long-running, human-auditable workflows with `*.flow.md`
files inside the App workspace. A flow file uses YAML frontmatter for the
machine-readable state and ordinary Markdown for the human-readable record.
Older OpenGrove builds render the file as normal Markdown.

```yaml
---
flow: v1
title: SHZC-A01 Exception Handling
status: waiting_user
initiator: attribution-analyst
started: 2026-06-10T07:04+08:00
updated: 2026-06-10T07:08+08:00
steps:
  - id: s1
    title: Confirm anomaly and summarize data
    owner: attribution-analyst
    status: done
    output: attribution/reports/2026-06-09.md
  - id: s2
    title: Choose remediation plan
    owner: user
    status: waiting
    blocking: true
    note: Recommended option 2
---
```

`flow: v1`, `title`, `status`, and at least one `steps` entry are required.
Flow status is one of `pending`, `running`, `waiting_user`, `done`, or
`failed`. Step status is one of `pending`, `running`, `waiting`, `done`, or
`failed`.

OpenGrove treats flow files as a read-only preview surface. The bridge exposes
`GET /apps/:appId/flows` to list flow files and validation issues, and the file
workbench can preview a `.flow.md` with a status header, progress, steps, and
Markdown body. State changes still happen by editing the file through normal
workspace writes or by an App employee updating the file after a conversation.
The default collaboration surface for a mounted App is its App-bound group
room. Flow files are status records for that group; they should not create a
separate direct message or task product in v1.

## Skill-local paths

Skills inside an app may use:

```yaml
shell:
  - ${OPENGROVE_SKILL_DIR}/../../bin/example
paths:
  - ${OPENGROVE_SKILL_DIR}/../..
```

OpenGrove resolves these values relative to the mounted skill directory, so a
private app can be cloned anywhere on a user's machine without rewriting the
skill.

## Environment defaults

For headless launches, apps may be mounted with path-delimited environment
variables:

```bash
OPENGROVE_APP_DIRS="/path/to/app-a:/path/to/app-b"
```

`OPENGROVE_MOUNTED_APPS` is accepted as an equivalent name. Settings UI changes
are written to the normal OpenGrove settings file.

## Done and validation criteria

When an App import or creation task is complete, the agent must report:

- Where OpenGrove discovers it and which directory should be enabled in
  Settings.
- Whether `ui.surface` is `file-workbench`, `view`, or `none`; both a top-level
  `view` and every file-workbench `view` tab must use the standard MCP App contract,
  and deliverable Apps must not remain in `setup` or use an unsupported UI kind.
- Required input files, configuration, model/API dependencies, and local
  dependencies.
- Where user-visible outputs are written.
- Which CLI/skill/MCP/hook surfaces are actually exposed, and which are only
  documented.
- Validation performed: manifest discovery, frontend/server typecheck or build,
  file workbench write operations, CLI doctor/smoke, or a real dry run.

If validation cannot run because a key, model, or external service is missing,
the missing configuration and reproducible command must be stated explicitly.
