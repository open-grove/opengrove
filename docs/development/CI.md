# Continuous integration

[中文](CI.zh-CN.md)

CI assigns each check an owner. PR and Main share `.github/workflows/ci-checks.yml`;
`scripts/ci-check-plan.mjs` selects jobs and `scripts/ci-harness-inventory.mjs`
assigns deterministic harnesses to suites. Change those sources rather than
copying commands between entrypoints.

| Entry | Responsibility | Required result |
| --- | --- | --- |
| PR / merge queue | Affected source checks, integration, UI, native filesystem behavior and packaged startup | `PR required`; every selected job succeeds |
| Main | All deterministic source/harness/UI checks plus native platform and packaged startup | `Main CI result` for the exact commit |
| Nightly (02:00 / 14:00 UTC), manual | Online production dependency installation, external baseline availability, real Agent coverage | Every owner succeeds, including complete runtime evidence |
| Desktop candidate, manual | Release notes, infrastructure, golden replay, verified N-1 bytes, signed artifacts, real upgrade and source/receipt identity | Full three-platform candidate and gate receipt |
| Finalize / register / promote | Publish the same verified bytes through the authorized endpoint | Existing artifact and remote identity checks |

Documentation-only paths run link checks with Node alone: no application install
or build. Markdown under runtime skills, prompts or fixtures is product input.
Unknown/unavailable diffs select conservative coverage. PR harness selection is
the union of baseline integration and changed module owners; Main runs every
owner. `src/tests/*-harness.ts` must have an inventory entry, and duplicate
same-environment execution entries fail the inventory contract. Windows aliases
and native jobs consume the same records. Node unit tests own their `*.test.js`
files; static Server checks do not repeat the Host contract unit test.

Each planned task states its preparation needs. Harness jobs build once before
executing their selected tests. Offline package contents (including bundled
Skills and package import targets) run before merge; online dependency installation
remains in Nightly. Cross-OS and installed-product validation are distinct
scenarios, not duplicate tests. Native/package scope stays conservative until
measured cost and regression data justify narrowing it.

Selected tasks must succeed; skipped/cancelled/failed selected work blocks the
result. Unselected jobs must be skipped. Workflow definitions use checksum-pinned
actionlint; behavioral tests cover selection, recovery and evidence rejection.

Native Windows and macOS jobs run the shared integration suite against their
actual filesystem, with Windows discovery/state/App activation checks where
applicable. The cleanup test produces its existing filesystem acceptance receipt,
including junction and symlink cases. A separate package job on Windows x64 and
macOS arm64 builds, checks generated source, stages runtime dependencies, packages
an installer, installs it and requires the renderer/Bridge readiness receipt.
These unsigned/ad-hoc packages exercise startup; formal signing, notarization,
macOS Intel packaging and real N-1 updater verification remain candidate gates.
Both the early generated-source check and final source-manifest check are needed:
they protect different points in the build.

Nightly no longer repeats Main's Linux harness, complete UI or web-package jobs.
The temporary production `npm install` probe is a network integration check,
separate from lockfile-based `npm ci`. Its 300-second deadline is unchanged. Its
artifact identifies pack/install/import phase, platform, exit category and elapsed
time, plus selected npm fetch/lifecycle/timer metrics; raw npm configuration,
log files and credentials are not uploaded. A timeout is an
installation failure, not evidence that a product assertion failed. Investigate
before rerunning; CI does not blindly retry the test.

The repository variable `OPENGROVE_DESKTOP_RELEASE_PUBLIC_ROOT` exposes only the
public download root to secret-free baseline health checks. Keep it aligned with
the release environment; scheduled checks do not enter the protected publishing
environment. Baseline health checks verify availability and expected size for the pinned
historical golden and current stable installers. They are not byte-integrity
proof. The candidate still downloads/replays golden bytes and acquires all three
N-1 installers before any platform build. N-1 size/SHA-256 comes from the stable
GitHub Release asset inventory (or the reviewed one-time bootstrap). The exact
artifact ID is carried to each platform, which verifies those bytes again before
using the real updater.

## Real Agent configuration and evidence

[`scripts/ci/real-agent-support.json`](../../scripts/ci/real-agent-support.json)
is the versioned list of required cases, modes, capabilities and provider profiles.
It records requirements, not successful evidence. Historical certifications remain
separate and are never rewritten to declare a CI run successful. New capabilities
or authentication routes need explicit cases and an implementation before they
can be certified.

`OPENGROVE_REAL_AGENT_IMAGES` is a repository JSON variable keyed by **case ID**
(currently the seven Kernel IDs). Each value requires an immutable
`ghcr.io/OWNER/IMAGE@sha256:DIGEST` image and optionally overrides `kernelVersion`,
`model` and non-sensitive `configRevision`. The default version/model comes from
the support policy. `kernelVersion` is the complete discovery identity, not a
semver prefix. Bump `configRevision` when rotating credentials or changing external
configuration without a model/image change. Never publish credentials or hashes of
raw secrets. A changed configuration invalidates the corresponding plan.

The plan artifact freezes each case's source-input digest, policy, mode, version,
image, provider/protocol/model and configuration revision. The runner executes that
profile; aggregate and release checks compare results to the resolved plan, not
merely to nonempty version strings or historical defaults. Source/dependency inputs
remain conservative, but unrelated scripts and Web UI do not invalidate live
certification. Case evidence expires after 24 hours independently of rerun time.

The current certified profile uses the `DEEPSEEK_API_KEY` secret in the
`opengrove-real-agent-test` environment. Model selection lives in the resolved
plan, not a second environment override. Hidden `REAL_AGENT_RUNTIME_ENVIRONMENTS`,
legacy Cloudflare/Pi bootstrap variables and `DEEPSEEK_MODEL` no longer override
certification. To support another provider, add an explicit policy profile and
matching runner implementation. Claude uses Anthropic; Codex uses Responses;
other Kernels use their existing OpenAI-compatible routes. OpenClaw starts an
owned Gateway. A working API key does not certify native-account-only features.

The image workflow builds six npm-based Kernels and source-pinned Hermes, verifies the actual image before
publication, and reports a **local build digest** separately from the **published
immutable registry reference**. Only the latter belongs in the mapping. Hermes
requires `source_revision` to name a full upstream commit and installs its frozen
Python dependency lock. Its official baked build-SHA mechanism avoids mutable
local branch metadata in the version banner; verification checks that SHA too.
Claude SDK selects its lockfile-installed Engine and checks its actual identity.
No credentials belong in an image. Configure package Actions access for this
repository before enabling the complete live gate; absent images/access or failed
required capabilities block release. Deterministic CI success is not rollout proof.

A manual single-Kernel run is diagnostic and cannot substitute for a complete
Nightly receipt. `exploratory: true` uses the separate
`OPENGROVE_REAL_AGENT_EXPLORATORY_IMAGES` mapping for new pinned versions; its
purpose and plan cannot satisfy release certification. PR jobs receive no live
provider or signing secrets.

Successful raw evidence is leak-checked before upload. Failures publish only safe
case identity, stage, category and duration, explicitly marked unsuccessful.
Individual case receipts retain their actual run/attempt and immutable artifact
ID. A newer failed case always overrides an older success.

The final **Nightly result** job creates
`nightly-release-evidence-RUN_ATTEMPT`, even when an unrelated branch alone was
rerun. It can reference fresh cases from earlier attempts of the same run/SHA.
Missing, expired, wrong-input or unsuccessful cases remain blocking; the final
receipt must belong to the current run attempt. Release checks also re-resolve
current repository configuration, so changing a model/image invalidates old
certification. A recent ancestor is reusable only with identical relevant inputs.
Baseline availability and immutable installer SHA-256 remain separate evidence;
a network recovery does not renew old case timestamps.

## Diagnostics and maintenance

Every harness has a bounded timeout and an owned process tree. The runner records
exit category, timeout/cancellation, duration, platform and Node version in
`test-results/ci/`. A probe initialization/version failure produces failed evidence
and cleans its resources rather than aborting all collected results.
Playwright saves JSON plus HTML reports, and CI uploads results even when a retry
turns a failure green. Failure/flaky traces and videos follow Playwright's retention
policy. A retry is diagnostic recovery, not a root-cause fix.

Actions use full commit SHAs enforced by a workflow contract; Dependabot maintains
weekly Action and dependency updates with limited open PRs. CodeQL scans Actions
and JavaScript/TypeScript once per configured event; do not also enable duplicate
default setup. Repository administrators own required checks, CODEOWNERS review,
bypass permissions and credential scopes; workflow files cannot establish those
settings by themselves. Publishing keeps its protected environments and existing
credential contracts; use OIDC only where the target service supports it.

Package jobs upload phase timings and gate diagnostics on failure as well as
success. Cache hits accelerate inputs; they never replace artifact identity or
execution receipts. Use the Actions job durations and these phase records to
measure improvements rather than adding repeated test jobs as a proxy for confidence.

See [the release process](RELEASE_PROCESS.md) for candidate authorization and the
resumable pipeline's endpoint controls.
