#!/bin/sh
set -eu
# Template warm-up has no task credentials. A task boot obtains its first Cell token
# through its injected refresh capability after the account service records the VM.
if [ "${ZOLTBOT_WORKER_REFRESH+x}" != x ]; then
  exec sleep infinity
fi
exec node /opt/zoltbot/apps/worker/dist/main.mjs
