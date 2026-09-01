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

Nightly evidence proves the additional platform and live-provider health of a
recent ancestor, not necessarily the exact candidate SHA. Commits after that
Nightly are covered by exact-SHA Main CI and the final candidate artifact gates.

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
4. Add paired `docs/releases/vX.Y.Z.md` and
   `docs/releases/vX.Y.Z.zh-CN.md` notes.
5. Update `CHANGELOG.md`.
6. Run the focused checks for the changed areas.

The imported baseline is deliberately valid only for the Host version named by
`legacyHostVersion`. Imported rows bind `hostVersion`, `kernelVersion`,
and `runtimeMode`; CI can verify their schema and reproducibility but does not
pretend to rerun a locally configured real Kernel. The real-runtime run and its
raw receipt remain untracked local release evidence. Only the importer's
minimal certification batch enters the repository, after human review.

The candidate workflow first verifies the exact Main CI and recent Nightly
evidence. It then performs the required lightweight release-readiness checks
against the authorized candidate commit:

```bash
npm run release:readiness
```

That command checks release notes, release configuration and workflow
contracts, and the npm package manifest. It intentionally does not repeat the
full harness, complete Browser UI suite, Web package integration, or
cross-platform regression already owned by Main CI and Nightly.

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

For the first public release only, dispatch `v0.6.6` with the explicit
one-time bootstrap input:

```bash
gh workflow run desktop-release.yml --ref main \
  -f ref=<current-main-commit> \
  -f platforms=all \
  -f first_public_release=true
```

This path is accepted only while the public repository has no GitHub Release
and the candidate tag is exactly `v0.6.6`. It downloads the reviewed `v0.6.5`
production installers from the protected release root and verifies their fixed
file names, sizes, and SHA-256 identities before running the normal N-1 update
gate. After the first GitHub Release exists, the bootstrap is rejected and
later candidates automatically use the previous public GitHub Release.

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
