# Changelog

Notable user-facing changes are collected here before release. During development,
add concise entries under `Unreleased`; when cutting a release, use this section
to draft `docs/releases/vX.Y.Z.md`.

## Unreleased

## v0.6.6 - 2026-08-31

- Separate replaceable Store App programs from user-owned Workspaces with a copy-validated, rollback-safe migration that never blocks OpenGrove startup, retains legacy data for recovery, and exports structured layout evidence in the diagnostic bundle.
- Prepare the public repository for external pull requests and its first formal desktop release, with administrator-owned review, protected finalization, and a checksum-pinned one-time v0.6.5-to-v0.6.6 update bootstrap.

## v0.6.5 - 2026-08-25

- Keep Store App programs in side-by-side generations outside persistent Workspaces so installs, repairs, rollbacks, formal-version switches, and deferred Windows cleanup preserve user data and use one recoverable activation boundary.
- Let eligible overseas authors complete Stripe Connect onboarding and follow payout progress from OpenGrove, with desktop deep-link return handling and server-owned country, provider, currency, signing, and readiness decisions.
- Keep silent successful App commands successful, isolate App JSON from Host-owned execution metadata, preserve Routine business-output references with deep-path support and visible missing-field diagnostics, and reject oversized or invalid structured output instead of exposing partial data.
- Stop abandoned MCP App media requests from exhausting desktop connections or leaking local file handles, let recoverable App panel failures retry in place, and keep Rooms snapshots atomic with their event cursors.
- Materialize concrete product model defaults, preserve explicit Employee choices, migrate the retired `native` model safely, and keep reasoning controls available while Kernel capabilities load or Provider availability changes.
- Make Release Control's returned recovery actions authoritative in App publishing, and harden desktop candidate readiness with full release checks, authenticated cloud probes, current gate replay, and aligned dependency/runtime images.
- Remove the retired Host-owned Story Seed dashboard and signing compatibility together with legacy same-origin web-app mounting; current Apps use supported UI surfaces, MCP App Views, declared commands, and explicit WW session injection instead.

## v0.6.4 - 2026-08-20

- Add recoverable Git-backed App publishing, one editable local draft, exact formal-version selection, and safe version switching without changing App workspaces or Room history.
- Use a bundled Models.dev catalog for supported public Providers, preserve separately named Fast/Free/HighSpeed/regional offerings and exact upstream model IDs, and load the complete model catalog separately from the bounded settings snapshot.
- Keep the Provider list limited to connected, enabled, or user-added services; move inactive built-ins into a searchable Add Provider dialog; stop importing Provider configuration from Kernels; and manage Codex, Claude, and Kimi account Login separately through native system-terminal actions.
- Give App Rooms explicit persisted scope, make the App PM optional, preserve user membership and administrator choices, and migrate legacy Room and Employee identities without disconnecting history.
- Give Kimi and other MCP-capable ACP Kernels session-scoped OpenGrove Host Tools for new and restored sessions while preserving Room, Employee, permission, approval, and audit boundaries.
- Ask for residence country or region only when WW identifies a new-account registration, show the registered region read-only in the account profile, and preserve existing-account login behavior.
- Restore desktop MCP App media playback through the authenticated local proxy, including byte ranges, and allow declared App commands to run for up to one hour.
- Build, gate, finalize, deploy, and promote desktop releases as separate trusted stages so the exact three-platform candidate bytes are verified and registered before the active update pointer changes.

## v0.6.3 - 2026-08-13

- Let the authoritative Room Run backend validate each Employee's model and Provider route instead of blocking valid messages from incomplete frontend Kernel state, while preserving localized failure details in Room history.
- Show the automatically selected PM's running state immediately only when the browser has the same routing facts as the Bridge, and reconcile optimistic feedback against the authoritative result across Rooms and App workspaces.
- Restore App-owned Employee defaults with an explicit confirmation of the affected local fields while preserving Provider bindings, and keep selection overlays and Employee settings usable across narrow and wide layouts.
- Keep localized Employee display names authoritative in Room identity and align each reply's language with the exact current message without changing user-authored text or App-owned instructions.
- Route Codex through DeepSeek's native Responses API so reasoning and tool-call turns retain their required state, while preserving compatibility routes for explicitly Chat-only Providers.
- Upgrade the bundled Claude Agent SDK and Claude engine so custom Provider Gateway keepalives prevent false stream-idle failures and long Gateway reasoning streams stay connected more reliably.
- Preserve desktop refresh and session cookies when Electron combines multiple `Set-Cookie` headers, keeping login state and authenticated update checks available after the access token rotates.

## v0.6.2 - 2026-08-12

- Route each Employee through an explicit Login or Provider selected for that Employee or model, preserve installer-owned choices, expose discovered services as ordinary Providers, and keep direct Kernel chat behind a dedicated developer setting.
- Make Electron own the desktop Bridge lifecycle behind a stable authenticated protocol proxy, recover safely from stale locks and local access failures, and keep the existing desktop window usable while the service restarts.
- Install and update identity-assigned default Apps through the normal Store pipeline, retire Knowledge Vault without deleting its data, and replace broad browser polling with bounded incremental synchronization.
- Rework Settings around unified controls, compact Employee runtime choices, a dedicated Software Update page, persistent automatic-download preferences, and clearer update/install feedback.
- Export complete run and system forensic bundles from the relevant UI actions while excluding credentials and local state stores, preserving hashes, logs, paths, scoped evidence, and explicit completeness metadata.
- Preserve per-App workbench layout preferences, stabilize mounted-App resizing, restore safe local resource actions and desktop media previews, and tighten Room routing, native session, and App migration boundaries.
- Upgrade native Kernel integrations and capability evidence, remove obsolete compatibility and OpenAI HTTP paths, and isolate workers by the concrete Provider, model, workspace, and runtime ownership boundary.
- Add privacy-bounded daily desktop activity reporting and immutable Cloudflare R2 mirroring without changing the WW-controlled release promote, rollback, or withdraw boundary.

## v0.6.1 - 2026-07-31

- Initialize new-account App welcomes from the browser language before default Apps run, while preserving explicit language choices and avoiding duplicate welcomes across locale changes.
- Make the App Builder explain outcomes and data boundaries in business language, continue feasible UI work when backend fields are missing, and apply the same responsibility contract in every App entry point.
- Restore desktop-native scrollbars, resize interruption cleanup, transform-safe button feedback, reduced-motion behavior, and consistent dismiss/focus handling across menus and popovers.
- Enable MCP App external links and file downloads through explicit Host capabilities, the existing destination confirmation flow, and tested Web/desktop parity boundaries.
- Open workspace absolute-path links in the File Workbench while treating every outside path as reveal-only local metadata that OpenGrove never reads or previews.
- Enrich redacted employee-run diagnostics with safe provider/model/runtime context, failure duration, stable idle-timeout classification, and verified upstream Claude request IDs without adding chat noise.
- Add Tailwind CSS v4 as an opt-in utility layer without Preflight or the default color palette, retaining OpenGrove tokens and strengthening real-CSS UI and scrollbar regression gates.
- Make packaged Locale Registry imports resolve outside the monorepo and keep Web assets working when OpenGrove is served from a nested subpath.

## v0.6.0 - 2026-07-31

- Unify the visual and interaction system across Rooms, Contacts, Settings, Extensions, the App Store, and App workbenches with shared identity controls, Phosphor icons, motion primitives, clearer surface hierarchy, and stronger keyboard and high-contrast behavior.
- Add persistent Room message replies with validated parent/root relationships, cancellable quote context, author mentions, bounded Agent context, and more precise default-Skill delivery.
- Make Room execution and history more trustworthy by limiting ledger reads to visible content by default, correlating native tool calls by ID, reporting Claude's actual context occupancy, and rotating mounted-App Agent sessions only when their definitions change.
- Centralize Host, Web, and Desktop localization behind one locale registry, complete English coverage for Host-owned surfaces, and preserve user-authored, third-party, historical, and unknown diagnostic text verbatim.
- Harden cross-platform App CLIs and packaged runtimes with declarative platform targets, shared publish/run validation, App-root confinement, native binary checks, safer runtime scanning, media-cache paths, and hidden Windows command windows.
- Restore Knowledge Vault's built-in file workbench, unify App icon and avatar editing, preserve settings drafts during refresh, and make WW account names and avatars flow into local identity surfaces.
- Redesign the authentication gate around the Grove identity and automatically request invite codes only for new accounts while retaining compatibility with older WW responses.
- Add frontend/Bridge version reporting, exportable server diagnostic bundles, typed Bridge JSON contracts, tighter Electron security, a unified Vite build loop, real-Agent CI evidence gates, and a smaller, faster release-candidate pipeline.

## v0.5.20 - 2026-07-24

- Replace blocking product-wide loading and connectivity screens with consistent in-context skeletons, title-bar progress, and recoverable offline notices that preserve the local workspace.
- Add an English-first localization foundation that follows the system language, keeps canonical Employee and runtime identities stable, localizes App display metadata, and gives Agents a bounded per-turn language preference.
- Redesign Room execution feedback around branded Thinking Orbs, one collapsed tool aggregate between visible responses, directly actionable questions and approvals, human-readable monitoring, and safer in-place stop controls.
- Make withdrawals available to every authenticated WW user while restricting browser money actions to trusted origins and requiring desktop Bridge capability for cross-origin calls.
- Restore legacy Web App proxy and MCP sandbox paths without weakening their existing access boundaries.
- Keep ordinary PR CI fast and deterministic while moving browser integration, full harnesses, signed packaging, installation, updater, and previous-version gates into the explicit desktop release candidate workflow.

## v0.5.19 - 2026-07-22

- Keep the trusted packaged desktop usable when the WW account service is temporarily unavailable, surface a retryable title-bar notice, and safely recreate a destroyed main window on a second launch.
- Complete the authenticated withdrawal flow from account overview and profile validation through worker signing, confirmation, history, and server-driven status recovery.
- Let Apps declare a minimum Host release, block incompatible installs and updates before any local mutation, and make published employee defaults explicitly separable from local overrides.
- Support MCP App media caching behind Clash Fake-IP DNS without weakening private-network, DNS-rebinding, or SSRF protections.
- Keep the title bar free of stale download prompts when a packaged desktop update check fails after the installed release was already confirmed current, while preserving manual fallback for genuinely available updates.
- Preserve third-party runtime files while excluding renderer-only dependencies from desktop packages, reducing the measured macOS arm64 ASAR by 28.8%.
- Move formal desktop builds to main-reachable SHA candidates with pinned-artifact gate replay, immutable gate receipts, and tag finalization only after every platform gate passes.

## v0.5.18 - 2026-07-22

- Make updater-launched assisted Windows installers honor the user's existing Host confirmation by switching the standard `--updated` path to silent mode inside the candidate, including updates started by already-published legacy clients; manual installs remain interactive.

## v0.5.17 - 2026-07-22

- Complete user-confirmed Windows updates without a second hidden installer interaction by running the assisted NSIS candidate silently after Host confirmation, while preserving forced post-update restart and native macOS behavior.

## v0.5.16 - 2026-07-22

- Preserve the updater installer while closing legacy Windows app processes: terminate each exact-name OpenGrove process without recursively killing the installer launched by its parent, and make update-gate installer logs plus process snapshots deterministic.

## v0.5.15 - 2026-07-22

- Close same-token Windows app processes without username-string filters before invoking the previous uninstaller, while retaining user-scoped elevation and capturing installer-stage plus process diagnostics on update-gate failures.

## v0.5.14 - 2026-07-22

- Make Windows updater process detection domain-aware, keep unattended process-cleanup failures noninteractive, and bound the real N-1 updater gate so a hidden installer prompt cannot consume a runner indefinitely.

## v0.5.13 - 2026-07-22

- Verify the Windows installer's fail-closed unattended path separately from its administrator-preprovisioned idempotent install path, without adding a release-only bypass to the public installer.

## v0.5.12 - 2026-07-21

- Keep unattended Windows installs noninteractive while preserving the loopback firewall boundary, and recognize canonical macOS process paths when the N-1 update gate verifies the post-update restart.

## v0.5.11 - 2026-07-21

- Keep Windows ASAR lookup paths native while normalizing inventory comparisons, and invalidate cached ASAR headers when the N-1 update gate replaces an installed archive in place.

## v0.5.10 - 2026-07-21

- Preserve dependency runtime modules stored under `node_modules/**/doc` or `docs` in desktop packages and require the affected YAML module during package-input audit; also normalize Windows ASAR inventory paths, isolate Windows PowerShell module lookup, tolerate runner-only cleanup locks, fail native PowerShell steps immediately, and select N-1 installers from published GitHub Releases instead of failed tags.

## v0.5.9 - 2026-07-21

- Ship the v0.5.8 product changes from a new immutable release tag after the original candidate was blocked before packaging, while tightening macOS release-secret scope and correcting the package audit's localized API-key-label false positive without weakening real credential detection.

## v0.5.8 - 2026-07-21

- Add a recoverable, idempotent Admin publishing flow for mounted Apps, including release-time validation, employee defaults, and atomic rollback when local finalization or App updates fail.
- Add Host-managed MCP App media caching, secure capability playback, Range support, escapable fullscreen, and App-owned MCP View tabs inside file workbenches.
- Complete English and Simplified Chinese coverage across the Web UI, including live language switching and locale-independent mentions, runtime messages, and downloads.
- Remove fallback App Operators, support room-scoped on-demand App Builder bindings, and discover independently installed user CLIs and Skills across supported runtimes.
- Upgrade and verify Claude, Pi, Hermes, OpenCode, Kimi Code, OpenClaw, and Codex integration behavior against their current supported versions.
- Add shared Toast, ConfirmDialog, and EmptyState primitives, then apply the refreshed feedback, contrast, spacing, motion, and accessibility gates across the desktop UI.
- Close and verify the complete Windows desktop/Bridge process tree during install, and recover automatically when legacy JSON and SQLite history coexist.
- Move formal desktop releases to immutable CI-built macOS arm64, macOS x64, and Windows x64 candidates with final-installer smoke tests, N-1 updater tests, explicit WW registration, promote, rollback, and withdraw controls.

## v0.5.7 - 2026-07-20

- Restore desktop startup after v0.5.6 by packaging every compiled runtime module and smoke-testing the real packaged Bridge before release.
- Restore in-app automatic updates by shipping the electron-updater bootstrap config, and make manual browser downloads an explicit failure fallback instead of the default title-bar action.
- Verify OSS releases with HEAD size plus CRC64/XZ and one deterministic SHA-256 sample, while failing preflight immediately when required release tools are unavailable.

## v0.5.6 - 2026-07-20

- Move local state to transactional SQLite plus content-addressed compressed blobs, retain complete durable history behind bounded in-memory windows, and preserve a conflict-safe migration backup from legacy JSON state.
- Add deterministic new-App setup, a unified App workbench/development shell, sandboxed custom Views, and same-turn native question cards without granting imported or historical Apps new builder privileges.
- Consolidate Story Seed review, work analytics, and signing eligibility into one WW-backed workspace while removing the contract-signing Employee and keeping account transactions in Host-owned UI.
- Add optional per-Employee context token budgets across Codex, Claude Code, Hermes, OpenCode, Kimi, OpenClaw, and Pi; undeclared budgets continue to preserve each Kernel's native behavior.
- Keep real Room delegation provenance in the Ledger while hiding duplicate Employee transport bubbles from ordinary chat and conversation previews.
- Close destructive-action, save-failure, and approval feedback loops; improve streaming persistence and rendering; and reduce the initial Web bundle through lazy loading and splitting.
- Harden App packaging and publication metadata: exclude nested dependencies, virtual environments, VCS data, and `.env*`, avoid JavaScript identifier false positives, retain real secret detection, and reject stale publish manifests.
- Restore intentionally removed seeded App Employees, forward WW authentication to declared MCP App commands, and add the Admin-only withdrawal experiment.
- Raise the development runtime to Node 24, pin npm, parallelize TypeScript/client builds, verify compiler-output compatibility, and remove the retired Provider HTTP-capture stack.

## v0.5.5 - 2026-07-16

- Keep the desktop app open in a recoverable setup state when no Kernel credential is available, then restore the selected runtime automatically after WW login and Provider provisioning.
- Show Employees outside developer mode and disable unavailable Employee, queued, and message-level send actions with an actionable configuration reason.
- Correct native Provider availability for Pi and OpenClaw, and reject incomplete Claude AWS/Google credential routes before a user starts a run.
- Record safe WW response-shape diagnostics across retries and deadlines, including status, request IDs, field names, types, counts, and missing fields without persisting secrets.
- Add the sandboxed MCP Apps UI channel and App Builder starter flow, runtime Provider model discovery, trusted Codex model-cache handling, and clearer Kernel binding state.
- Add the authenticated single-user Web runtime and make Knowledge Vault installation explicitly opt-in.
- Fix Windows CRLF parsing, Hermes `.cmd` health checks, non-admin junction-based security tests, and related first-run UI regressions.
- Reduce duplicated work in the signed desktop release pipeline and retain deterministic release provenance across platform artifacts.

## v0.5.4 - 2026-07-15

- Move the Knowledge Library into the optional public `opengrove.knowledge-vault` App, migrate existing users through the authenticated App Store, and keep new installations explicitly opt-in.
- Let users archive custom App groups while preserving their Room history, blocking deletion during active runs, and returning safely to the default group.
- Keep workspace files and Markdown image downloads inside the authenticated Bridge path, with a no-progress timeout that allows large files to continue while bytes are still arriving.
- Run Node-based App CLIs on Windows through the packaged Electron runtime and block Room execution when a declared CLI doctor check fails.
- Check the current e-sign flow before creating a signing link, reuse an existing fill link, and stop duplicate work once signing is in progress or complete; keep the internal signing handoff out of user-visible Room history.
- Treat App Store package keys as stable identities across registry URL changes, support recoverable uninstall and safe residual-directory adoption, and use native directory selection when creating Apps on Windows.
- Keep the complete Kernel inventory and active Kernel visible, expose installed Apps on mobile, and add a platform-specific latest-version download action to Desktop settings.

## v0.5.3 - 2026-07-14

- Keep desktop updates visible through download and require an explicit user confirmation before restarting to install them.
- Run Windows Apps that declare `python3` through safe `py -3` or `python` fallbacks when the requested launcher is genuinely unavailable, without rerunning failed business scripts.
- Keep packaged App inventory available when the knowledge root cannot be initialized, and place desktop knowledge data under the writable OpenGrove data directory.
- Make App Store update detection trust the full registry URL and package key plus the installed archive fingerprint, reject malformed checksum metadata, and refuse to overwrite a same-named App from another source.
- Show legacy manual and JSONC mounts as “Relink”; after explicit confirmation, OpenGrove records the current Store source without downloading or overwriting App program files, settings, or workspace data.
- Preserve authenticated local sessions through temporary WW timeouts, rate limits, and server errors instead of treating them as logout events.
- Restore Room collaboration with server-owned run context and safer delegation scheduling. On the first run after upgrading, each Room member starts a new kernel session thread; Room message history remains available, but context held only in the previous kernel thread does not carry forward.
- Export bounded, redacted diagnostic bundles that consistently connect Room and Routine failures to structured incidents and stable error codes.
- Remove the frozen Cloud Connector, server profile, Postgres deployment, Matrix remote Room, and Invite Landing stacks while retaining supported local data and App Store settings migrations.
- Bound release-network waits, speed up verified artifact publication, and retain structured timing evidence for each release stage.

## v0.5.2 - 2026-07-13

- Parallelize isolated macOS arm64 and x64 release builds, notarization, and packaging while preserving per-architecture retry state.
- Add one-command OSS publication for installers and updater files, with public remote hash verification before WW latest-version registration.
- Add a temporary Windows unsigned-release escape hatch that only works with zero signing configuration and verifies every EXE is genuinely `NotSigned`.

## v0.5.1 - 2026-07-12

- Make Kernel and model discovery follow the runtime that is actually installed, selected, and executable in the packaged product.
- Deliver required and optional Skills through each Employee instead of implicitly publishing OpenGrove Skills into user Kernel directories.
- Expose one logical App Builder in global contacts while retaining App-scoped workspace, Room, and Session isolation where a builder is enabled.
- Add a scoped App Builder only for Apps scaffolded through OpenGrove's new-App flow; imported, store-installed, mounted, and historical Apps keep their own Employee structure.
- Keep a newly selected direct conversation focused while Room snapshots synchronize, preventing an older conversation from taking over the visible chat.

## v0.5.0 - 2026-07-11

- Mark development desktop builds explicitly and simplify desktop settings around user-facing recovery and data actions.
- Separate employee Skills into an available scope and host-required defaults, preserve native Codex/Claude disclosure, and keep Skill activity collapsed by default.
- Remove the Qwen Code, DeepSeek TUI, and Gemini CLI kernels while keeping DeepSeek and Gemini as model providers.
- Derive the active kernel and model from the installed runtime and selected provider instead of a product-wide vendor default.
- Repair App Store installations without opening employee packages or native/custom Apps as workbenches, and preserve explicit post-install recovery state in the UI.
- Stabilize Radix dialogs on React 19 and make email login, registration, verification-code, and invite-code states explicit and recoverable.
- Harden incremental desktop releases with exact-tag source provenance, architecture-aware manifests, resumable notarization, signed Windows builds, and remote artifact verification before publish.
- Keep desktop packages target-specific, exclude local/release state from build inputs, and provision a Windows firewall rule restricted to OpenGrove's IPv4 loopback bridge.
- Add one-click diagnostic bundles with bounded structured records, incident references, and shared credential, token, email, and path redaction.
- Reconcile WW API keys before replacement, isolate recovery across account switches, reuse in-flight idempotency keys safely, and fail closed after the replay window expires.
- Let the same employee run concurrently in different rooms while preserving same-room turn ordering.

## v0.4.2 - 2026-07-09

- Finalize the signed desktop release workflow with DMG notarization finalization, desktop release manifests, and WW latest-version handoff files.
- Fix WW provider defaults and Claude Code runtime controls so model and reasoning selections stay visible and persist across refreshes.
- Make mounted App employee prompts include useful default skill descriptions while avoiding skills that forbid model invocation.
- Repair mounted App CLI execution in packaged desktop sessions by injecting a Node runtime fallback and preserving `bin/` executable bits through App packaging.
- Align default reasoning effort display with runtime behavior.

## v0.4.1 - 2026-07-09

- Remove the bundled Story Seed App from the npm and desktop package; authenticated desktop sessions now rely on the default App Store install for `opengrove.story-seed`.
- Add the Story Seed signing handoff: when the WW review dashboard reports `contract_signing.status = pending_info`, OpenGrove posts a platform message and targets the product-level `签约员`.
- Add packaged desktop auto-update support using WW latest-version metadata, updater feed URLs, and electron-updater, with safer install prep before restart.
- Treat WW-provisioned Claude Code provider credentials as runtime auth so Claude Code can be selected without local Claude auth files.
- Surface `workflow.create` definitions and runs in mounted App workbenches, grouping activation/manual/scheduled runs by workflow initiator.
- Add the shared glossary and collaboration-process docs (`CONTEXT.md`, `CLAUDE.md`, issue conventions, and plan-review checklist).

## v0.3.1 - 2026-05-22

- Remove private App example identifiers from the published package, tests, docs, and UI placeholders.
- Replace hard-coded mounted-App employee detection with generic manifest-declared employees under `employees`, `rooms.employees`, or `capabilities.employees`.
- Republish the v0.3 line as a sanitized patch after unpublishing the original v0.3.0 package artifact.

## v0.3.0 - 2026-05-22

- Add the workspace/app shell: mounted Apps, App workspace files, visual preview workbench, developer sessions, preview annotations, and voice input.
- Expand settings for kernels, providers, mounted Apps, voice, remote Matrix/Tuwunel messaging, proxy, appearance, and diagnostics.
- Add extension inventory and native skill publishing flows for mounted skills, CLIs, MCP config, hooks, plugins, and tool roots.
- Split local Rooms/Ledger state from optional Matrix/Tuwunel projection; remote metadata is now generic `remote` provenance on bridge-owned room records.
- Make room employees explicit contact entities instead of auto-creating employees from newly detected kernels.
- Add GitHub Copilot CLI terminal login and improve OpenCode provider binding through generated inline provider config.
- Refresh the app shell visual system, sidebar overflow behavior, settings surfaces, contacts UI, and room/member management states.
- Smooth mounted App chat composer chrome and remove the unused visual-developer voice tool from the floating annotation toolbar.
- Add release-note preflight checks and document the current release process.
- Audit and trim code: stricter server unused-code checks, dead shared UI removal, extracted contacts model helpers, and extracted reusable settings inline select.
- Refresh public docs to keep product boundaries, repository layout, App spec, technical reference, design guide, and release notes concise and current.
