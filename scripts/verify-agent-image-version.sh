#!/usr/bin/env bash
# Verify that a pinned agent engine inside a CI image matches its manifest.
#
# Before any model test runs we prove the engine binary actually present in the
# image reports the exact version recorded in its machine-readable manifest. Any
# mismatch fails immediately and blocks the model tests from starting.
#
# The manifest is produced at image build time and shaped like:
#   {
#     "schemaVersion": 1,
#     "kernel": "opencode",
#     "engineVersion": "1.18.3",
#     "source": "npm:opencode-ai@1.18.3",
#     "sourceSha256": "<artifact-sha256>",
#     "imageDigest": "sha256:<image-digest>"
#   }
#
# Usage:
#   scripts/verify-agent-image-version.sh <kernel> [manifest-path]
#
# manifest-path defaults to $OPENGROVE_AGENT_MANIFEST or /opt/opengrove/agent-manifest.json.

set -euo pipefail

kernel="${1:-}"
manifest_path="${2:-${OPENGROVE_AGENT_MANIFEST:-/opt/opengrove/agent-manifest.json}}"

if [[ -z "${kernel}" ]]; then
  echo "verify-agent-image-version: kernel argument is required" >&2
  echo "usage: $0 <kernel> [manifest-path]" >&2
  exit 2
fi

if [[ ! -f "${manifest_path}" ]]; then
  echo "verify-agent-image-version: manifest not found at ${manifest_path}" >&2
  exit 2
fi

# Read expected values from the manifest. `node` is always present because the
# image builds on the OpenGrove Node base and CI runs npm.
read_manifest_field() {
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = manifest[process.argv[2]];
    if (value === undefined || value === null) process.exit(3);
    process.stdout.write(String(value));
  ' "${manifest_path}" "$1"
}

manifest_kernel="$(read_manifest_field kernel)"
expected_version="$(read_manifest_field engineVersion)"

if [[ "${manifest_kernel}" != "${kernel}" ]]; then
  echo "verify-agent-image-version: manifest kernel '${manifest_kernel}' does not match requested '${kernel}'" >&2
  exit 1
fi

# ===== per-kernel version probe =====
#
# Each kernel exposes its version through a different command surface. We only
# read the version string here; deeper health checks (doctor, gateway status,
# acp --check) belong to the probe runner, not this supply-chain gate.
#
# The extractor greps the first semver-ish token from the command output, which
# tolerates prefixes like "opencode 1.18.3" or "hermes 0.18.2 (2026.7.7.2)".
extract_semver() {
  grep -oiE '[0-9]+\.[0-9]+\.[0-9]+([.-][0-9a-z.]+)?' | head -n1
}

case "${kernel}" in
  codex)
    actual_version="$(codex --version 2>&1 | extract_semver)"
    ;;
  claude-code)
    actual_version="$(claude --version 2>&1 | extract_semver)"
    ;;
  opencode)
    actual_version="$(opencode --version 2>&1 | extract_semver)"
    ;;
  pi)
    actual_version="$(pi --version 2>&1 | extract_semver)"
    ;;
  hermes)
    actual_version="$(hermes --version 2>&1 | extract_semver)"
    ;;
  kimi)
    actual_version="$(kimi --version 2>&1 | extract_semver)"
    ;;
  openclaw)
    actual_version="$(openclaw --version 2>&1 | extract_semver)"
    ;;
  *)
    echo "verify-agent-image-version: unknown kernel '${kernel}'" >&2
    exit 2
    ;;
esac

if [[ -z "${actual_version}" ]]; then
  echo "verify-agent-image-version: could not read a version from the ${kernel} binary" >&2
  exit 1
fi

if [[ "${actual_version}" != "${expected_version}" ]]; then
  echo "verify-agent-image-version: version mismatch for ${kernel}" >&2
  echo "  manifest engineVersion: ${expected_version}" >&2
  echo "  binary --version:       ${actual_version}" >&2
  exit 1
fi

echo "verify-agent-image-version: ${kernel} ${actual_version} matches manifest"
