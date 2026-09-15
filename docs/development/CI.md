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

Documentation-only PRs run link checks. Unknown or unavailable change scopes
select the conservative checks. A selected job that is skipped, cancelled or
fails blocks the result; an intentionally unselected job must be skipped.
GitHub Actions definitions are checked with checksum-pinned actionlint, and
behavioral tests cover selection, ownership, prerequisite order and evidence
rejection. Deterministic jobs use a normal Linux user/process environment;
browser dependencies are installed only for runtime checks.

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

The generated certified ledger supplies required Kernel/runtime/capability pairs;
historical certification rows are never treated as a fresh CI run. Configure the
repository variable `OPENGROVE_REAL_AGENT_IMAGES` as a JSON map keyed by Kernel ID.
Each entry has an `image` pinned as `ghcr.io/OWNER/IMAGE@sha256:DIGEST`, and optionally
`kernelVersion` when intentionally testing a newer engine than the ledger.
The expected version is the complete discovery string, not just a semver prefix.
The existing image-version manifest check and probe identity checks both run.
Claude SDK uses the platform Engine installed by the repository lockfile.

Provider credentials belong to the `opengrove-real-agent-test` environment:

- `DEEPSEEK_API_KEY` enables a disposable DeepSeek profile for each Kernel.
  `DEEPSEEK_MODEL` is an optional environment variable in GitHub (default
  `deepseek-flash`). Claude uses the Anthropic API; Codex uses Responses;
  OpenCode, Pi, Kimi and Hermes use their OpenAI-compatible routes. OpenClaw
  starts an owned loopback Gateway with the same-version DeepSeek provider
  baked into its image. No native account is copied into these profiles.
- Without the DeepSeek secret, Claude/OpenCode retain the existing Cloudflare
  gateway variables and token.
- Pi may use `REAL_RUNTIME_OPENAI_BASE_URL`, `REAL_RUNTIME_OPENAI_API_KEY` and
  `REAL_RUNTIME_MODEL`.
- `REAL_AGENT_RUNTIME_ENVIRONMENTS` is an optional JSON secret mapping Kernel IDs
  to their supported vendor/OpenGrove environment variables. It reaches only the
  probe subprocess. Configure a disposable Codex profile or an accessible
  OpenClaw Gateway using that Kernel's actual authentication contract. Images
  must not contain credentials; a custom Hermes build needs its own pinned image.
  The image workflow builds Claude, Codex, Pi, OpenCode, Kimi and OpenClaw with
  exact npm versions. Run it with `publish: false` for build/version validation
  without registry credentials; publication runs only after image verification. Hermes must be built from the exact source revision being
  tested; substituting an official release does not verify a customized build.

A successful DeepSeek call verifies that selected provider route, not every native
account feature. Codex ChatGPT `auth.refresh`, for example, still requires its
native account. Required model-dependent capabilities must actually pass;
unsupported features and version mismatches are not waived by a working API key.

The environment profile is an integration seam, not automatic account provisioning.
Missing images, credentials, services, skipped probes or incomplete coverage leave
the release unverified. A successful single-Kernel diagnostic may be green, but its artifact remains
`ready: false` and never counts as full coverage.
The old opt-in switch cannot make a skipped matrix qualify a release.

Only leak-checked successful case evidence is uploaded. The aggregate artifact
`real-agent-coverage-RUN_ATTEMPT` records all required capabilities and binds them
to the workflow run, attempt, commit, runtime modes and tested engine versions.
Release eligibility downloads that artifact from the latest successful Nightly,
checks completeness and individual case freshness, and compares a digest of tracked runtime/build/probe inputs
with the candidate. Failed-job reruns may reuse passing cases from an earlier
attempt of the same run/SHA for up to 24 hours; the newest case wins, and a failed
matrix cannot qualify a release. Changed configuration requires a new run. A recent ancestor's evidence is reusable only when those
inputs are identical; otherwise run Nightly again. PRs receive no live-provider
or signing secrets.

Package jobs upload phase timings and gate diagnostics on failure as well as
success. Cache hits accelerate inputs; they never replace artifact identity or
execution receipts. Use the Actions job durations and these phase records to
measure improvements rather than adding repeated test jobs as a proxy for confidence.

See [the release process](RELEASE_PROCESS.md) for candidate authorization and the
resumable pipeline's endpoint controls.
