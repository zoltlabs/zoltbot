# D10: Zoltbot's daemon in a container, for a server or VM. Build from the repository root:
#
#   docker build -f deploy/self-host/Dockerfile -t zoltd .
#
# The image has no coding tool in it. Extend it with the ones your agents use (Claude Code,
# Codex, …) and sign in to them inside the container; see docs/self-host.md.
FROM node:24.22.1-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && node scripts/build-daemon.mjs

FROM node:24.22.1-slim
ENV NODE_ENV=production \
    ZOLTBOT_DATA_DIR=/data/zoltbot \
    ZOLTBOT_SECRETS_DIR=/data/secrets \
    ZOLTBOT_SECRET_KEY_FILE=/run/secrets/zoltbot_secret_key
RUN apt-get update && apt-get install -y --no-install-recommends git lsof ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The bundle loads its dependencies from the checkout it was built in, so the image keeps it.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "dist/daemon/zoltd.mjs"]
