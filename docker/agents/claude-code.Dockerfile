# Claude Code agent CI image.
#
# One image per kernel. Claude Code is installed from its npm package at an exact
# version (a clean image allows only one install source). Authentication is not
# baked in: the smoke workflow injects AWS Bedrock credentials via environment
# variables at run time, and OpenGrove's default Claude runtime is the Agent SDK
# pinned by package-lock.json.
#
# Build:
#   docker build -f docker/agents/claude-code.Dockerfile \
#     --build-arg ENGINE_VERSION=2.1.220 \
#     -t ghcr.io/open-grove/opengrove-agent-claude-code:2.1.220 .
FROM node:24-bookworm-slim

# Links the published GHCR package to this repository so repository-scoped
# GITHUB_TOKEN (packages: read) can pull it in CI.
LABEL org.opencontainers.image.source=https://github.com/open-grove/opengrove

ARG ENGINE_VERSION
ARG KERNEL=claude-code

RUN test -n "${ENGINE_VERSION}" || (echo "ENGINE_VERSION build-arg is required" >&2 && exit 1)

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@anthropic-ai/claude-code@${ENGINE_VERSION}"

RUN mkdir -p /opt/opengrove \
  && printf '{"schemaVersion":1,"kernel":"%s","engineVersion":"%s","source":"npm:@anthropic-ai/claude-code@%s","sourceRevision":null,"sourceSha256":null,"imageDigest":null}\n' \
    "${KERNEL}" "${ENGINE_VERSION}" "${ENGINE_VERSION}" \
    > /opt/opengrove/agent-manifest.json

COPY scripts/verify-agent-image-version.sh /opt/opengrove/verify-agent-image-version.sh
RUN chmod +x /opt/opengrove/verify-agent-image-version.sh

ENV OPENGROVE_AGENT_MANIFEST=/opt/opengrove/agent-manifest.json
