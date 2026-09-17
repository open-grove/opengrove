# Release process

OpenGrove desktop releases are built by CI from an explicit candidate commit.
The same gated bytes are finalized, deployed, and promoted; downstream stages
never rebuild an installer.

## Invariants

- Do not create the formal version tag before every candidate gate passes.
- Dispatch the workflow from trusted `main`. The `ref` input selects candidate
  code, but does not replace the workflow or release-control code from `main`.
- When candidate identity is resolved, it must equal the current `main` tip.
  A newer `main` push supersedes older Main CI work and becomes the next
  eligible candidate.
- A full candidate must have a successful latest `Main CI` run for the exact
  candidate SHA.
- The latest completed `Nightly` run on `main` must be successful, no more than
  24 hours old, and its tested SHA must be an ancestor of the candidate.
- Only `platforms=all` can assemble a registrable candidate. Partial platform
  runs are diagnostics and cannot be promoted.
- A release is identified by its candidate commit, workflow run, version,
  `clientReleaseNumber`, immutable artifact bytes, and gate receipt.
- Before the first schema v3 candidate is registered, WW must have applied its
  localized release-note migration and deployed schema v3 registration support.
  Failing closed is intentional; do not drop localized notes to work around an
  older release-control service.

Nightly owns external services, online production installation and baseline
availability. Release eligibility also downloads its complete Real Agent coverage
artifact, verifies run/attempt identity and compares tracked runtime input digests.
A recent ancestor is reusable only when those inputs are unchanged; otherwise run
Nightly again. Native platform and unsigned installed-startup checks belong to
exact-SHA Main CI. See [CI ownership and configuration](CI.md).

## Continue to an authorized endpoint

`desktop-release-pipeline.yml` dispatches the existing candidate, finalizer,
deployment and control workflows in order. It accepts an exact authorized `ref`
SHA and an explicit `stop_after`: `candidate`, `finalize`, `register` or `promote`.
The default is `candidate`; **stop before registration** means `finalize`.
Nothing is dispatched by a normal Main push. Release notes and version preparation
must already be complete before starting the pipeline.

The pipeline derives the version and client release number from that SHA, records
child run IDs immediately, and uploads `release-progress-<run-id>-<attempt>` even
when a stage fails. To resume, dispatch it with the same SHA and the original
`resume_run_id`, explicitly selecting the newly authorized endpoint. It first loads the latest persisted progress and verifies its candidate SHA,
version and release number. Separate pipeline runs use the same identity for the
same candidate. It then verifies existing child workflow identities and conclusions and reuses successful runs.
A failed child is not automatically redispatched: fix the cause, rerun that child
when appropriate, then resume. Ambiguous identities fail closed. Each stage keeps
its existing environment, permissions, exact-byte checks and remote verification.
The pipeline neither rebuilds finalized bytes nor promotes past its endpoint.

## Prepare a candidate

1. Start from a clean, current `main`.
2. Update `version` and increment `clientReleaseNumber` in `package.json`.
3. Refresh every certified Kernel capability row whose
   `legacyHostVersion` no longer matches the candidate version. Run the real
   Runtime probes on that candidate, use
   `scripts/import-kernel-evidence-receipt.mjs` to import only the passing
   certification rows, then run `npm run generate:kernel-evidence` and
   `npm run test:capabilities`. A release must not extend the legacy migration
   version or hand-edit the generated ledger to keep a capability enabled.
4. Curate and confirm the paired release notes using the process below, then
   add `docs/releases/vX.Y.Z.md` and `docs/releases/vX.Y.Z.zh-CN.md`.
5. Update `CHANGELOG.md`.
6. Run the focused checks for the changed areas and complete [Claude Auto acceptance](#claude-auto-acceptance).

The imported baseline is deliberately valid only for the Host version named by
`legacyHostVersion`. Imported rows bind `hostVersion`, `kernelVersion`,
and `runtimeMode`. CI verifies their schema and reproducibility, then requires
fresh probes for every certified pair from configured test images and providers.
Local raw receipts remain untracked. Only the importer's minimal certification
batch enters the repository after review; historical rows cannot substitute for
the Nightly coverage artifact.

### Claude Auto acceptance

OpenGrove offers Auto for Claude SDK without model-by-model checks in the UI or Employee lifecycle.
Before publishing a candidate, verify every supported Claude model using the candidate's SDK/Engine
and its supported Provider route in a disposable Workspace:

- Select Auto and confirm the native session acknowledges `auto`.
- Run a harmless, fixed tool action in that Workspace and verify native automatic review completes.
  Confirm the same action can require a human decision under Ask; a model response alone does not
  prove automatic review works.
- Treat an Auto-to-Ask fallback as a failed Auto acceptance case, even if the conversation succeeds.
- Record the candidate SHA, SDK/Engine versions, model IDs, Provider route and results in release
  evidence. Fix a failing route or revise the supported roster before publishing; do not push model
  discovery or cache-dependent permission checks into ordinary user operations.

This is real-runtime release acceptance. Unit tests and ordinary CI do not substitute for it or use
a developer's credentials automatically. Stored user permissions remain unchanged by this acceptance.

### Curate and confirm release notes

Release notes are a product summary over the complete change range, not a list
of pull-request titles. Before drafting, generate the exact review inventory:

```bash
npm run release:notes:context -- --from <previous-release-tag> --to HEAD
```

The command defaults `--from` to the latest reachable tag matching `v*`. A repository with no
previous public tag must pass the audited release-boundary ref explicitly. The
output lists the first-parent history, every commit, every changed path, and the
diff summary. It is an input inventory, not generated release copy.

The Agent preparing a release must inspect every merged change in that exact
range, including the actual diff and linked pull request where available. In
the Codex conversation it should privately classify changes as product-facing,
technical, or omitted; combine related changes across pull requests into a few
coherent themes; and explain any material omission. That coverage mapping is
review evidence and must not be copied into the public Release or committed as
a permanent per-PR checklist.

Draft both languages with exactly these public sections, in this order:

```markdown
## Product Updates

## Technical Improvements
```

```markdown
## 产品更新

## 技术改进
```

`Product Updates` describes outcomes in language useful to people using the
App. `Technical Improvements` summarizes architecture, compatibility,
reliability, and contributor-facing work without repeating one bullet per PR.
The two locale files must communicate the same facts; they are not independent
change logs.

Keep `Product Updates` readable as plain text: clients through v0.6.5 display the
legacy English `release_notes` field without rendering Markdown. Use inline
emphasis and links sparingly while those clients remain supported. The legacy
field must equal the localized English Markdown, so it cannot use a separate
plain-text projection. Each locale's extracted `Product Updates` must fit within
65,535 UTF-8 bytes; ordinary CI validates both current-version files when present.

Before writing the files, the Agent presents the complete English and Chinese
drafts in the Codex conversation and waits for explicit user confirmation.
After confirmation it writes the paired files and opens the release-preparation
PR. Merging that PR freezes the release copy at the candidate commit. CI only
validates the two-section contract and extracts each locale's `Product Updates`
Markdown into desktop update metadata; it never regenerates or rewrites the
confirmed text. GitHub Release composition continues to use both complete
files, including `Technical Improvements`. Gate receipt schema v3 binds the
confirmed `en` and `zh-CN` bytes with one SHA-256 digest before WW registration.

The candidate workflow first verifies the exact Main CI and recent Nightly
evidence. It then performs the required lightweight release-readiness checks
against the authorized candidate commit:

```bash
npm run release:readiness
```

That command checks release-mode notes and the npm package manifest. Release
configuration and workflow contract tests already passed in exact-SHA Main CI.
Candidate-only infrastructure, signing, baseline and installer gates remain
separate prerequisites; source harness, UI and web-package checks are not repeated.

To catch deterministic source and release-metadata failures before starting a
cloud candidate, you may optionally run:

```bash
npm run release:check
```

This is a broader local confidence check than the candidate workflow runs. It
may create temporary Web and npm package artifacts, but it does not build,
sign, install, or upload a desktop installer, access local signing identities,
or download a previous release. It is optional and is not a substitute for
the recorded Main CI and Nightly evidence.

## Build and gate

Dispatch the trusted candidate workflow from `main`:

```bash
gh workflow run desktop-release.yml --ref main \
  -f ref=<current-main-commit> \
  -f platforms=all
```

For the first public release only, dispatch `v0.7.0` with the explicit
one-time bootstrap input:

```bash
gh workflow run desktop-release.yml --ref main \
  -f ref=<current-main-commit> \
  -f platforms=all \
  -f first_public_release=true
```

This path is accepted only while the public repository has no GitHub Release
and the candidate tag is exactly `v0.7.0`. It downloads the reviewed `v0.6.5`
production installers from the protected release root and verifies their fixed
file names, sizes, and SHA-256 identities before running the normal N-1 update
gate. After the first GitHub Release exists, the bootstrap is rejected and
later candidates automatically use the previous public GitHub Release.

Known-good replay uses the independently pinned `v0.6.0` baseline. Candidate
workflows read that historical installer from the public release root after its
connectivity check, retaining the original size, SHA-256, and dist inventory
checks. This does not require creating historical GitHub Releases in the public
repository or changing the `v0.6.5` N-1 bootstrap artifacts. Standalone replay
dispatches may supply `public_root`; omitting it retains GitHub Release downloads.

The full workflow checks all of the following before it assembles the immutable
candidate:

- version and paired release notes;
- a successful latest Main CI run for the exact candidate SHA;
- a successful, recent latest Nightly run whose SHA is in the candidate's
  history;
- replay of the installer and Bridge gates against pinned known-good artifacts;
- signed/notarized macOS Apple Silicon and Intel packages;
- the Windows x64 package;
- package inventory and final installed-artifact smoke;
- independently generated and verified updater metadata;
- update behavior from the previous published release; and
- one combined gate receipt over the exact platform bytes.

A platform-only run such as `platforms=windows-x64` is useful for diagnosis but
intentionally produces no registrable candidate or gate receipt.

### Real-filesystem acceptance for storage changes

Changes to recursive cleanup or local cache policy require real-filesystem
acceptance on every affected platform in addition to automated gates. A local
machine or a GitHub-hosted Windows/macOS runner may perform this check, but it
must run the production cleanup code against native filesystem links. Use
temporary test data and verify before and after the operation that
works, conversations, settings, account state, Knowledge, the current App, and
current diagnostic logs remain intact.

- On Windows, test this irreversible-risk case: create a directory
  junction inside an OpenGrove cleanup boundary that points to a test directory
  outside that boundary, then exercise the real `fs.rm` cleanup path. Confirm
  that cleanup does not follow the junction or remove the external files. A
  normal symbolic link or mock is not a substitute for this test.
- On macOS, create a symbolic link inside an OpenGrove cleanup boundary that
  points to a test directory outside that boundary. Confirm that cleanup does
  not follow the link or remove the external files.

Record the candidate SHA, client and operating-system versions, filesystem,
test paths, before-and-after checksums, and the result, identifying whether the
execution used a local machine or a GitHub runner. PR/Main's native platform jobs
run the cleanup acceptance and upload
`storage-cleanup-<platform>-<run-attempt>` receipts; Windows verifies NTFS and Junction
types. This evidence covers filesystem cleanup behavior, not installation or UI
acceptance on a physical device. If an item was not run, say so in the release
record; mocks, static checks, or unrelated passing tests are not substitutes.

If evidence shows a transient infrastructure failure and candidate code is
unchanged, rerun only the failed jobs:

```bash
gh run rerun <run-id> --failed
```

Deterministic product, test, signing, notarization, packaging, metadata, or
updater failures require a fix, a new candidate commit, and a new complete run.

## Finalize, deploy, and control

After every full-candidate gate passes:

1. Dispatch `desktop-release-finalize.yml` with the candidate run ID and
   expected tag. It verifies candidate identity, downloads the gated candidate,
   creates the formal tag at that exact commit, and attaches those exact bytes
   to the GitHub Release.
2. Dispatch `desktop-release-deploy.yml` with the same run ID and tag. It
   downloads, verifies, uploads, and registers the same gated bytes. It does not
   rebuild and does not change the active update pointer.
3. Dispatch `desktop-release-control.yml` to explicitly `promote`, `rollback`,
   or `withdraw` the active release pointer.

Rollback repoints what eligible clients are offered; it does not force an
already newer installation to downgrade. Withdraw clears the active candidate.
Neither action deletes immutable candidates, tags, GitHub Releases, or retained
artifacts.

Deployment endpoints, account identifiers, bucket names, signing material, and
access tokens are provided through protected GitHub environments, variables,
and secrets. Never place their values in tracked files, issue text, PR logs, or
local evidence intended for publication.
