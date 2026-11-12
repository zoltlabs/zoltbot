# Cloud runner

This package is in progress. It contains the durable event journal for the Mac
runner and sandbox worker, plus their reconnecting transport. Managed checkouts,
native command execution and signed Mac bridge integration are not complete. W5 is not
signed off, and this code does not connect a Local project to a cell.

## Event journal

`RunnerOutbox` owns one JSONL file per org/task, named with a hash of those IDs.
Its header binds the org, task, thread and lease. An observation from another
thread fails before writing. Its caller must supply the privacy guard and keep
one journal owner per task. The caller must keep account credentials and runner
bearer tokens out of journal inputs. New files use owner-only permissions and
refuse symlinks.

The journal appends and fsyncs an event before returning its runner sequence.
The runtime's optional `persistObservation` hook awaits that write before passing
the normalized, redacted event to other readers. It stays active without a stream
reader, so startup observations are not dropped. Local callers omit the hook and
retain the existing reader behavior and execution path.

Acknowledgements also fsync before releasing retained entries. A new connection
reconciles the cell's cursor before processing its lease, including when a recreated
cache has no old events. A regressed cell cursor fails explicitly; the journal
does not invent replacement history. Repeated or older ordinary acknowledgements
do not advance it backwards.

Startup scans bounded chunks and retains only file offsets for unacknowledged
events. It truncates a partial final line, but refuses a complete corrupted record
or a changed binding. Event records carry a content hash. Replay reads a bounded
batch; it does not hydrate the full transcript. Once a journal exceeds one MiB
and at least half its bytes are no longer needed, compaction writes a new file,
fsyncs it, renames it atomically and fsyncs the directory. Pending events and sequence
numbers survive compaction. Filesystem failures stop the journal with fixed error
codes rather than logging paths or content.

Tests cover reopening, acknowledgement replay, compaction, partial-tail recovery,
cell cursor seeding, scope refusal, known-private-value refusal and symlink safety.
The runtime test also checks durable observations without a reader and redaction
before persistence. The worker/daemon end-to-end replay gate still needs managed execution and the
W8 harness.

## Connection transport

`RunnerConnection` gets short-lived credentials from an injected account client.
Credentials remain in memory and the WebSocket authorization header. Production
connections require WSS; the explicit test option admits only numeric loopback
addresses over WS. URL credentials, query parameters, redirects and oversized
frames are refused. The transport reconnects with exponential backoff capped at
thirty seconds and renews credentials before expiry. Closing cancels credential
requests, reconnect timers and the host's lifetime signal. Hosts must honor that
signal during startup and command execution.

The first Cell acknowledgement reconciles each outbox before native startup.
Acknowledgements run separately from serialized lease/command work, so a blocked
native command cannot stall delivery receipts. Each task sends at most eight
unacknowledged frames. Incoming queued work and the socket buffer have byte caps.
Task sessions stay alive across reconnects. A later lease updates the existing
runtime; it cannot replace its task, thread, org, member or lease binding.

Mac task execution requires an explicit `acceptTasks: true` on the receiving
runner, even if a forged Cell sends a lease. Sandbox runners require their injected
task ID. Execution metadata must agree with the manifest, profile, definition and
cloud project. The bridge callback remains available when Mac task execution is
off; its host must apply W7 policy, signature verification and output redaction.
Transport dispatch alone grants no shell execution permission.

Tests use a localhost fake Cell and synthetic credentials. They cover lost-ack
replay without duplicate application, bounded sends while a command blocks,
credential renewal without a second native runtime, cancellation, insecure-URL
refusal, missing cursors, wrong-task sandbox leases and mismatched metadata.
The transport is not yet wired into `zoltd` or a sandbox worker. The fake bridge
callback is not the W7 signature or host-command gate.

The full-suite run exposed timing assumptions in existing daemon integration tests.
The real PTY shutdown check now waits up to five seconds for OS PID removal after
shutdown requests complete. The detached-shell check waits for its spawn event
before inspecting its process group. Real Git publishing cases have a forty-five
second test budget for repeated clone/commit/push work. These changes preserve
all cleanup and publishing assertions and alter no Local runtime behavior.

The transport advertises only task runtimes that finished startup. It sends an
immediate heartbeat after startup and hello, then every fifteen seconds. A clone
or native startup still in progress therefore cannot receive a private handoff
through a stale lease-presence marker. The fake-Cell test holds startup behind a
barrier and verifies that the lease appears only after the task host is ready.
