#!/bin/sh
set -eu
worker='^node /opt/zoltbot/apps/worker/dist/main\.mjs$'

# A warm Boat resume can retain processes. Let the worker close its durable cache first.
pkill -TERM -u "$(id -u)" -f "$worker" || exit 0
for _ in $(seq 45); do
    pgrep -u "$(id -u)" -f "$worker" >/dev/null || exit 0
    sleep 1
done
pkill -KILL -u "$(id -u)" -f "$worker" || true
