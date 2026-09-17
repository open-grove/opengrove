# openclaw CI runtime. Pin the published npm engine; credentials are supplied only at run time.
FROM node:24-bookworm-slim

# Links the published GHCR package to this repository so repository-scoped
# GITHUB_TOKEN (packages: read) can pull it in CI.
LABEL org.opencontainers.image.source=https://github.com/open-grove/opengrove

ARG ENGINE_VERSION
ARG KERNEL=openclaw

# Fail the build early if the caller forgot to pin a version; a floating install
# would defeat the entire supply-chain baseline.
RUN test -n "${ENGINE_VERSION}" || (echo "ENGINE_VERSION build-arg is required" >&2 && exit 1)

# git is needed by several engines for workspace operations; ca-certificates for
# provider TLS. Keep the layer minimal.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "openclaw@${ENGINE_VERSION}" "@openclaw/deepseek-provider@${ENGINE_VERSION}"

# Load the same-version provider locally, so Gateway startup never downloads a floating plugin.
RUN mkdir -p /opt/opengrove \
  && ln -s /usr/local/lib/node_modules/@openclaw/deepseek-provider /opt/opengrove/deepseek-provider

# Record the machine-readable manifest the Layer 0 preflight verifies against.
# sourceSha256 and imageDigest are filled in by the build workflow after the
# artifact and image digests are known; the engineVersion is authoritative here.
RUN mkdir -p /opt/opengrove \
  && printf '{"schemaVersion":1,"kernel":"%s","engineVersion":"%s","source":"npm:openclaw@%s","sourceRevision":null,"sourceSha256":null,"imageDigest":null}\n' \
    "${KERNEL}" "${ENGINE_VERSION}" "${ENGINE_VERSION}" \
    > /opt/opengrove/agent-manifest.json

COPY scripts/verify-agent-image-version.sh /opt/opengrove/verify-agent-image-version.sh
RUN chmod +x /opt/opengrove/verify-agent-image-version.sh

ENV OPENGROVE_AGENT_MANIFEST=/opt/opengrove/agent-manifest.json
