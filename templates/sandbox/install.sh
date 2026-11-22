#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive

install_runtime() {
    apt-get update
    apt-get install -y --no-install-recommends bash ca-certificates curl git gh python3 make g++ libatomic1 procps xz-utils \
      xvfb x11vnc openbox fonts-dejavu-core
    rm -rf /var/lib/apt/lists/*

    node_version=22.23.4
    case "$(dpkg --print-architecture)" in
        amd64) node_arch=x64 ;;
        arm64) node_arch=arm64 ;;
        *) exit 1 ;;
    esac
    archive="node-v${node_version}-linux-${node_arch}.tar.xz"
    release="https://nodejs.org/dist/v${node_version}"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl --fail --silent --show-error --location --output "$tmp/$archive" "$release/$archive"
    curl --fail --silent --show-error --location --output "$tmp/SHASUMS256.txt" "$release/SHASUMS256.txt"
    (cd "$tmp" && grep " ${archive}$" SHASUMS256.txt | sha256sum --check -)
    tar -xJf "$tmp/$archive" -C /usr/local --strip-components=1
    corepack enable
    corepack prepare pnpm@11.25.0 --activate
}

install_worker() {
    cd /opt/zoltbot
    pnpm install --frozen-lockfile --ignore-scripts
    pnpm build:worker
    CI=true pnpm --filter-prod @zoltbot/worker... install --prod --frozen-lockfile --ignore-scripts
    pnpm --filter-prod @zoltbot/worker... rebuild better-sqlite3
    npm install --global @anthropic-ai/claude-code@2.1.299 @openai/codex@0.164.0

    export PLAYWRIGHT_BROWSERS_PATH=/opt/chromium
    npx --yes --package playwright@1.58.1 playwright install --with-deps chromium
    chmod -R a+rX /opt/chromium
    chromium_binary="$(find /opt/chromium -type f -name chrome -print -quit)"
    test -n "$chromium_binary"
    ln -sf "$chromium_binary" /usr/local/bin/chromium

    id user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user
    install -m 755 templates/sandbox/start.sh /usr/local/bin/zolt-worker
    install -m 755 templates/sandbox/desktop.sh /usr/local/bin/zolt-desktop
    install -d -o user -g "$(id -gn user)" /home/user/work /home/user/.zoltbot
}

case "${1:-all}" in
    runtime) install_runtime ;;
    worker) install_worker ;;
    all) install_runtime; install_worker ;;
    *) exit 2 ;;
esac
