# OpenCode agent CI image.
#
# One image per kernel, each pinning a single engine version so that updating one
# kernel never entangles another's dependencies. OpenCode publishes a
# linux-capable npm package, so the engine is installed with an exact pinned
# version (no floating installer).
#
# Build:
#   docker build -f docker/agents/opencode.Dockerfile \
#     --build-arg ENGINE_VERSION=1.18.3 \
#     -t ghcr.io/open-grove/opengrove-agent-opencode:1.18.3 .
FROM node:24-bookworm-slim

# Links the published GHCR package to this repository so repository-scoped
# GITHUB_TOKEN (packages: read) can pull it in CI.
LABEL org.opencontainers.image.source=https://github.com/open-grove/opengrove

ARG ENGINE_VERSION
ARG KERNEL=opencode

# Fail the build early if the caller forgot to pin a version; a floating install
# would defeat the entire supply-chain baseline.
RUN test -n "${ENGINE_VERSION}" || (echo "ENGINE_VERSION build-arg is required" >&2 && exit 1)

# git is needed by several engines for workspace operations; ca-certificates for
# provider TLS. Keep the layer minimal.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "opencode-ai@${ENGINE_VERSION}"

# Record the machine-readable manifest the Layer 0 preflight verifies against.
# sourceSha256 and imageDigest are filled in by the build workflow after the
# artifact and image digests are known; the engineVersion is authoritative here.
RUN mkdir -p /opt/opengrove \
  && printf '{"schemaVersion":1,"kernel":"%s","engineVersion":"%s","source":"npm:opencode-ai@%s","sourceRevision":null,"sourceSha256":null,"imageDigest":null}\n' \
    "${KERNEL}" "${ENGINE_VERSION}" "${ENGINE_VERSION}" \
    > /opt/opengrove/agent-manifest.json

COPY scripts/verify-agent-image-version.sh /opt/opengrove/verify-agent-image-version.sh
RUN chmod +x /opt/opengrove/verify-agent-image-version.sh

ENV OPENGROVE_AGENT_MANIFEST=/opt/opengrove/agent-manifest.json
