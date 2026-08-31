# Pi agent CI image.
#
# One image per kernel. The Pi CLI is installable from npm at an exact version.
# Note: OpenGrove's default Pi runtime uses the in-repo SDK (@earendil-works/pi-*),
# which is pinned by package-lock.json and installed via `npm ci` in CI, not baked
# into this image. This image pins the Pi CLI so command discovery resolves a
# known binary.
#
# Build:
#   docker build -f docker/agents/pi.Dockerfile \
#     --build-arg ENGINE_VERSION=0.74.0 \
#     -t ghcr.io/open-grove/opengrove-agent-pi:0.74.0 .
FROM node:24-bookworm-slim

# Links the published GHCR package to this repository so repository-scoped
# GITHUB_TOKEN (packages: read) can pull it in CI.
LABEL org.opencontainers.image.source=https://github.com/open-grove/opengrove

ARG ENGINE_VERSION
ARG KERNEL=pi

RUN test -n "${ENGINE_VERSION}" || (echo "ENGINE_VERSION build-arg is required" >&2 && exit 1)

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@earendil-works/pi-coding-agent@${ENGINE_VERSION}"

RUN mkdir -p /opt/opengrove \
  && printf '{"schemaVersion":1,"kernel":"%s","engineVersion":"%s","source":"npm:@earendil-works/pi-coding-agent@%s","sourceRevision":null,"sourceSha256":null,"imageDigest":null}\n' \
    "${KERNEL}" "${ENGINE_VERSION}" "${ENGINE_VERSION}" \
    > /opt/opengrove/agent-manifest.json

COPY scripts/verify-agent-image-version.sh /opt/opengrove/verify-agent-image-version.sh
RUN chmod +x /opt/opengrove/verify-agent-image-version.sh

ENV OPENGROVE_AGENT_MANIFEST=/opt/opengrove/agent-manifest.json
