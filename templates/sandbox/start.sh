#!/bin/sh
set -eu
# Template warm-up has no task credentials. The orchestrator launches this entrypoint
# with the task's environment after create, and again after a wake without processes.
if [ "${ZOLTBOT_RUNNER_TOKEN+x}" != x ]; then
  exec sleep infinity
fi
exec node /opt/zoltbot/apps/worker/dist/main.mjs
