# Source identity is baked using Hermes' own container build-info contract.
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv
FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source=https://github.com/open-grove/opengrove
ARG ENGINE_VERSION
ARG SOURCE_REVISION
RUN test -n "$ENGINE_VERSION" && echo "$SOURCE_REVISION" | grep -Eq '^[a-f0-9]{40}$'
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-dev build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv
WORKDIR /opt/hermes
RUN git init . && git remote add origin https://github.com/NousResearch/hermes-agent.git \
    && git fetch --depth=1 origin "$SOURCE_REVISION" && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$SOURCE_REVISION" \
    && printf '%s\n' "$SOURCE_REVISION" > .hermes_build_sha && rm -rf .git
RUN uv sync --frozen --no-dev --extra acp --extra mcp --python /usr/bin/python3
ENV PATH=/opt/hermes/.venv/bin:$PATH
ENV PYTHONDONTWRITEBYTECODE=1
RUN mkdir -p /opt/opengrove && node -e 'const fs=require("node:fs"); fs.writeFileSync("/opt/opengrove/agent-manifest.json",JSON.stringify({schemaVersion:1,kernel:"hermes",engineVersion:process.argv[1],source:"https://github.com/NousResearch/hermes-agent",sourceRevision:process.argv[2]}))' "$ENGINE_VERSION" "$SOURCE_REVISION"
COPY scripts/verify-agent-image-version.sh /opt/opengrove/verify-agent-image-version.sh
ENV OPENGROVE_AGENT_MANIFEST=/opt/opengrove/agent-manifest.json
WORKDIR /workspace
RUN bash /opt/opengrove/verify-agent-image-version.sh hermes
