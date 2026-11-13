FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive NODE_VERSION=22.23.4
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git gh python3 make g++ libatomic1 xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$(dpkg --print-architecture)" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) exit 1 ;; esac; \
    archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl --fail --silent --show-error --location --output "/tmp/${archive}" "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"; \
    curl --fail --silent --show-error --location --output /tmp/node-sha256 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    cd /tmp && grep " ${archive}$" node-sha256 | sha256sum --check -; \
    tar -xJf "/tmp/${archive}" -C /usr/local --strip-components=1; \
    rm "/tmp/${archive}" /tmp/node-sha256; \
    corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /opt/zoltbot
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm build:worker \
    && CI=true pnpm --filter-prod @zoltbot/worker... install --prod --frozen-lockfile --ignore-scripts \
    && pnpm --filter-prod @zoltbot/worker... rebuild better-sqlite3 \
    && npm install --global @anthropic-ai/claude-code@2.1.299 @openai/codex@0.164.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/chromium
RUN npx --yes --package playwright@1.58.1 playwright install --with-deps chromium \
    && chmod -R a+rX /opt/chromium \
    && chromium_binary="$(find /opt/chromium -type f -name chrome -print -quit)" \
    && test -n "$chromium_binary" && ln -s "$chromium_binary" /usr/local/bin/chromium \
    && useradd --create-home --shell /bin/bash user
COPY templates/sandbox/start.sh /usr/local/bin/zolt-worker
RUN chmod 755 /usr/local/bin/zolt-worker \
    && mkdir -p /home/user/work /home/user/.zoltbot \
    && chown -R user:user /home/user
USER user
ENV HOME=/home/user SHELL=/bin/bash
WORKDIR /home/user
ENTRYPOINT ["/usr/local/bin/zolt-worker"]
