# Core

This package contains Node-free domain decisions. Task transitions and readiness
checks remain shared by Local projects and cells. `queuedTasks` preserves the
scheduler's creation-time ordering, with task id as the tie-breaker.

Connected runner leases are plain values in `runner-scheduling.ts`. The cell supplies
server receive times and persists the results. Heartbeats run every 15 seconds; a
runner becomes offline at 60 seconds. Offline status never authorizes another native
writer. Reassignment requires the caller to explicitly release the old lease.
A sleeping sandbox receives one wake request until a matching heartbeat returns.
Local native process ownership remains with the daemon's existing ownership locks.
