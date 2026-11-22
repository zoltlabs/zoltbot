#!/bin/sh
set -eu

test "$(id -u)" != 0
test "$HOME" = /home/user
test "${CI+x}" != x
test -x /usr/local/bin/zolt-worker
test -r /opt/zoltbot/apps/worker/dist/main.mjs
test "$(node --version)" = v22.23.4
git --version
gh --version
chromium --version
claude --version | grep '^2\.1\.299\([[:space:]]\|$\)'
codex --version | grep '^codex-cli 0\.164\.0$'
cd /opt/zoltbot/apps/worker
node -e 'const db = require("better-sqlite3")(":memory:"); if (db.prepare("select 1 as result").get().result !== 1) process.exit(1)'
