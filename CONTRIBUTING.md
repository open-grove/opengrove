# Contributing to OpenGrove

Thank you for helping improve OpenGrove.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Install Node.js 24 and the npm version declared in `package.json`, then install
the locked dependencies:

```bash
npm ci
```

See [Building from source](docs/development/BUILDING.md) for desktop and browser
development profiles, build outputs, and troubleshooting.

## Branches and commits

Create a focused branch from the latest `main` using:

```text
<type>/<short-kebab-description>-<issue>
```

Examples: `feat/local-mode-812`, `fix/cloud-auth-gate-813`, and
`docs/provider-setup-814`.

Write commit subjects in this form:

```text
<type>: <brief imperative summary>
```

Use `feat`, `fix`, `refactor`, or `docs` as the type. Keep formatting-only
changes separate from behavior changes.

## Before opening a pull request

1. Search existing issues and pull requests.
2. Open an issue before substantial product, architecture, or compatibility
   work so scope and acceptance criteria are visible.
3. Keep changes focused and add tests for behavior changes.
4. Run lint and formatting checks, then the narrow validation command from
   `AGENTS.md`; widen validation in proportion to risk.
5. Do not commit credentials, private data, local runtime evidence, internal
   plans, QA recordings, research notes, or third-party source snapshots.

Frontend changes must follow the [Web design system](web/src/styles/design.md)
and pass the relevant CSS and token checks.

## Minimum verification

Every code contribution starts with:

```bash
npm run lint
npm run format:check
```

Then run the smallest relevant project check:

| Change | Minimum additional command |
| --- | --- |
| Documentation | `npm run check:doc-refs` |
| Web UI | `npm run typecheck:web` |
| Server or Kernel | `npm run smoke:server` |
| App Store install behavior | `npm run build:server && node dist/tests/app-store-harness.js` |

Use `npm run smoke:critical` when a change crosses several of these boundaries.

## Pull request lifecycle

1. Open or reference an issue for substantial work.
2. Open a focused pull request and explain its user-visible effect.
3. Keep the branch current with `main` and respond to review with additional
   commits.
4. Make the required checks pass and record the commands you ran.
5. A maintainer merges after review and CI approval.

## Contribution licensing

Unless explicitly stated otherwise, contributions intentionally submitted for
inclusion in OpenGrove are provided under the [Apache License 2.0](LICENSE).
OpenGrove does not require a Contributor License Agreement or per-commit DCO
sign-off.

## Review expectations

- Explain user-visible behavior and compatibility impact.
- Call out migrations, stored-data changes, new network access, and dependency
  changes explicitly.
- Preserve existing product behavior unless the pull request is intentionally
  changing it and the issue documents that decision.
- Update public documentation when a public contract changes.
