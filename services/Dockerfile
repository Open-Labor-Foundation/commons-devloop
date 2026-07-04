FROM node:20-bookworm-slim AS dashboard-build
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

FROM node:20-bookworm-slim

ARG AE_IMAGE_VERSION=local
ARG AE_IMAGE_COMMIT_SHA=unknown
ARG AE_IMAGE_CREATED=1970-01-01T00:00:00Z
ARG AE_IMAGE_EDITION=local

LABEL org.opencontainers.image.title="commons-devloop" \
  org.opencontainers.image.description="Reusable autonomous GitHub repo engine with role-based containers." \
  org.opencontainers.image.version="${AE_IMAGE_VERSION}" \
  org.opencontainers.image.source="https://github.com/Open-Labor-Foundation/commons-devloop" \
  org.opencontainers.image.revision="${AE_IMAGE_COMMIT_SHA}" \
  org.opencontainers.image.created="${AE_IMAGE_CREATED}" \
  org.opencontainers.image.licenses="AGPL-3.0-or-later" \
  com.commons-devloop.edition="${AE_IMAGE_EDITION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    docker.io \
    docker-compose \
    gh \
    git \
    jq \
    openssh-client \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN mv /usr/bin/docker /usr/bin/docker-real \
  && printf '#!/bin/sh\nif [ "$1" = "compose" ]; then\n  shift\n  exec docker-compose "$@"\nfi\nexec /usr/bin/docker-real "$@"\n' > /usr/local/bin/docker \
  && chmod +x /usr/local/bin/docker

# Pinned for reproducibility — bump deliberately, not implicitly on every image rebuild.
RUN npm install -g @openai/codex@0.142.5

WORKDIR /engine

COPY package.json /engine/package.json
COPY package-lock.json /engine/package-lock.json
RUN npm install

COPY . /engine
COPY --from=dashboard-build /dashboard/dist /engine/dashboard/dist

RUN mkdir -p /engine/state /engine/logs /engine/.codex /workspace/target-repo

CMD ["node", "scripts/engine-role.mjs", "--role", "autonomous"]
