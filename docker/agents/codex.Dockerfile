# Codex agent CI image.
#
# One image per kernel. OpenAI publishes `@openai/codex` to npm with linux
# x64/arm64 binaries, so Codex is pinned from npm exactly like OpenCode and Pi.
#
# Build:
#   docker build -f docker/agents/codex.Dockerfile \
#     --build-arg ENGINE_VERSION=0.146.0 \
#     -t ghcr.io/open-grove/opengrove-agent-codex:0.146.0 .
FROM node:24-bookworm-slim

# Links the published GHCR package to this repository so repository-scoped
# GITHUB_TOKEN (packages: read) can pull it in CI.
LABEL org.opencontainers.image.source=https://github.com/open-grove/opengrove

ARG ENGINE_VERSION
ARG KERNEL=codex

RUN test -n "${ENGINE_VERSION}" || (echo "ENGINE_VERSION build-arg is required" >&2 && exit 1)

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${ENGINE_VERSION}"

RUN mkdir -p /opt/opengrove \
  && printf '{"schemaVersion":1,"kernel":"%s","engineVersion":"%s","source":"npm:@openai/codex@%s","sourceRevision":null,"sourceSha256":null,"imageDigest":null}\n' \
    "${KERNEL}" "${ENGINE_VERSION}" "${ENGINE_VERSION}" \
    > /opt/opengrove/agent-manifest.json

COPY scripts/verify-agent-image-version.sh /opt/opengrove/verify-agent-image-version.sh
RUN chmod +x /opt/opengrove/verify-agent-image-version.sh

ENV OPENGROVE_AGENT_MANIFEST=/opt/opengrove/agent-manifest.json
