# Cloud runner

This package is in progress. It contains the durable event journal for the Mac
runner and sandbox worker, plus their reconnecting transport, managed checkouts and
native Claude/Codex task hosts. Daemon opt-in and the signed Mac bridge are not complete. W5 is not
signed off, and this code does not connect a Local project to a cell.

## Event journal

`RunnerOutbox` owns one JSONL file per org/task, named with a hash of those IDs.
Its header binds the org, task, thread and lease. An observation from another
thread fails before writing. Its caller must supply the privacy guard and keep
one journal owner per task. The caller must keep account credentials and runner
bearer tokens out of journal inputs. New files use owner-only permissions and
refuse symlinks.

The journal appends and fsyncs an event before returning its runner sequence.
`ObservationJournal` first saves the normalized, redacted observation in the task
cache's SQLite transaction with its projection. Streaming deltas use a separate
SQLite transaction. This cache explicitly uses synchronous FULL. Pending rows flush
to JSONL before startup, after each runtime observation and before cache shutdown.
The runtime's optional record hooks write inside the projection transaction;
`persistObservation` then flushes the queue before notifying other readers. It stays active without a stream
reader, so startup observations are not dropped. Local callers omit the hook and
retain the existing reader behavior and execution path.

The cache has a persistent random source ID and monotonically increasing source
sequence. Each JSONL copy includes that source sequence and an observation digest.
If the process dies after fsync but before deleting the SQLite row, retrying the
last identical copy returns its original wire sequence. Compaction retains this
last source cursor even after acknowledgement. Changed payloads, skipped or older
source sequences, lost cache identity and regressed cache history fail closed.
Only one pending SQLite row is loaded at a time. Tests kill a child process after
its cache commit and before flush, and inject failure after fsync and compaction.

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

## Managed checkouts

`ManagedWorkspaces` prepares a separate clone for each org/task, under a hash-named
directory supplied by the runner host. It takes no Local store or Local project
path. A SQLite owner lock excludes another initializer, including another process;
the OS releases that lock after a crash. Calls within one instance share startup
work and recheck their scope before returning.

The first clone freezes the base commit and creates its own `zoltbot/task-…`
branch. Owner-only control metadata lives beside the repository. Initialization
writes and fsyncs a prepared binding before renaming the clone, then writes a ready
binding and fsyncs the directory before a caller can start a native session. A
prepared clone can recover at its frozen base even if the default branch advanced.
A missing ready checkout fails explicitly: restarting cannot replace lost edits
with a fresh clone. Reopening preserves tracked edits, untracked files and HEAD.
Scope, Git directory, top-level path, binding symlinks and remote changes are checked.

Production remotes are HTTPS GitHub owner/repo URLs. The explicit local-repository
callback exists for the headless bare-repository fixture. Git gets an allowlisted
environment, disabled global/system configuration, hooks and credential helpers,
no redirects or prompts, and bounded output and runtime. An optional GitHub
credential callback receives the runner lifetime signal; cancellation does not
wait for a blocked credential lookup. Authentication enters Git through temporary
environment configuration, never its argv, remote URL or on-disk configuration.
Git's stderr is discarded and failures use fixed codes. On Unix a pipe watcher
stops Git's process group if its runner parent dies, including SIGKILL.

Tests use disposable bare repositories to check edits/base preservation, interrupted
initialization, task/org isolation, scope and symlink refusal, cancellation and
exclusive ownership. Separate synthetic Git child tests verify cleanup after
both cancellation and a killed parent. No network or desktop input is involved.
The task host below composes this preparer with leases. Production Mac resources
and `zoltd` settings wiring remain unfinished. These tests do not complete W5 or W8.

## Task cache and runtime composition

`cloudTasks` connects a managed checkout, an exclusive per-org/task SQLite cache,
`InProcessRunner` and the journal to `RunnerConnection`. It takes the authenticated
member ID and no Local store. Its host supplies a pinned definition and task-owned
native/tool resources. Incoming launch recipes are never evaluated. Definition
validation requires opaque vault references for private environment values before
the definition can enter the cache. The host must honor the supplied lifetime
signal during definition lookup, resource creation and native startup.

The cache contains only the leased project, task, thread, profile, pinned definition
and queued inputs, followed by that task's runtime state. Its project root is the
managed checkout. Bindings cover org, member, lease, task, thread, project, profile,
provider, repository, default branch, location, cwd and base commit. Repeated leases
preserve local input delivery state; canonical input IDs survive command retries.
Local item sequence numbers are assigned inside this cache, because the Cell may
have additional items. Duplicate IDs, changed input bodies, regressed revisions,
changed bindings and different native IDs fail before a new assignment is applied.

Restart runs the existing recovery logic, closes stale session rows and retains
the original native identity and configuration. An uncertain native send stays on
hold instead of being sent again. A Cell continuation without its corresponding
task cache fails with `runner_cache_missing`; it cannot bypass lost privacy-vault
references by inventing a prior session row. Normal process restarts preserve the
cache and resume the original native session. Missing disks require recovery.

Only normalized runtime observations enter the outbox. Readiness requires both a
live native session row and its fsynced `session.ready` observation. Stop, process
fault or cleanup withdraws readiness. The connection sends an immediate heartbeat
when readiness changes and excludes stopped hosts from private-handoff presence.
An exception from a host's readiness check also withdraws it.

Turn commands, interaction answers, interrupts and stop use the existing runner
and interaction engine. The command input ID is canonical when supplied; older
frames without it use a stable command-derived ID. Only the Cell drives interaction
timers. Diff collection and branch publication remain refused until their bounded
wire results are implemented. Native assembly is available below; daemon opt-in
and signed Mac execution are not connected yet.

Tests drive real `InProcessRunner` instances with synthetic native sessions and
disposable local Git repositories. They cover native resume, one-time input and
answer delivery, private-output redaction restored from an in-memory vault,
cross-member refusal and cleanup. The localhost fake Cell disconnects after its
first persisted event; the same native runtime replays the remaining journal and
finishes once. These are composition tests, not the W6 CLI/template or W8 whole-flow
gates. Local task wiring is unchanged.

## Native task resources and private context

`nativeCloudTasks` supplies the production task resource assembly for the Mac and
worker. It accepts only the built-in Claude and Codex definitions, discovers their
locally pinned binaries and clones each definition before use. Its injected native
ports support headless fixtures; Cell recipes never select executables. The host
creates a task-owned localhost MCP server with environment-only bearer credentials.
Every tool call checks the task profile, thread, running session and current turn
before applying the supplied tool policy. No Local runtime or desktop controller
is an input. The caller supplies the tool set; the W7 bridge tools remain pending.

Provider keys enter only through an injected keychain/environment callback and
the native process environment. They stay out of cached definitions and discovery
probes. The host registers them with the redactor and private context before the
native session opens. Mac tasks can use the provider's existing native login when
no API key is supplied. Worker assembly must require its injected API key instead.
Cloud inputs refuse file paths: a Cell path cannot grant access to the receiving
machine's filesystem. Inline images and text remain valid. Client attachment
serialization is part of the later client work.

`taskVault` wraps private-context references with org/task metadata and rejects
other tasks' and unwrapped Local references. The Mac caller supplies its keychain.
`EncryptedTaskVault` supplies sandbox persistence with AES-256-GCM, a fresh nonce,
and org/task/reference authenticated data. Its 32-byte key arrives through the
worker environment; files contain only bounded authenticated ciphertext, use
owner-only permissions and atomic fsynced replacement, and refuse symlinks. Reads
validate metadata and value bounds. Key and plaintext buffers are cleared where
possible; JavaScript strings cannot be erased reliably. The caller closes the
vault only after task shutdown and private-context writes settle, then clears its
key buffer. It must retain the same injected key across a sandbox wake.

Headless native tests use disposable Git repositories, synthetic environment keys
and the protocol fake executables. Both adapters call a scoped host tool and
resume the original native ID after reopening the factory. Tests scan fixture
files for secret bytes and cover scoped-vault refusal, authenticated ciphertext
recovery, tampering and missing keys. No installed agent CLI, real keychain,
provider service or visible app is used. These tests do not complete W6 or W8.

## Account client and Mac lifecycle

`runnerAccount` reads the current native account bearer through an injected
keychain/memory callback. It accepts only an HTTPS account origin; the explicit
headless test option admits numeric loopback HTTP. Requests refuse redirects,
time out after ten seconds, bound response bytes and return fixed errors without
response content. Credential results use the public cloud contracts, validate the
short expiry and Cell origin, and construct the org's WSS connection path. Account
bearers never become Cell credentials or native process environment values.
Grant creation takes both capability booleans explicitly and verifies the result.

`startMacRunner` composes that client, managed checkouts, native task resources,
outboxes and the reconnect transport. Constructing it requires explicit local
capabilities; a bridge capability additionally requires a W7 execution host. It
accepts no Local store. Its known account/runner/GitHub/provider values are guarded
before persistence. It does not create grants during startup or reconnect: the
settings action must first enroll the registered Mac session explicitly. A grant
revoked on another owned device therefore stays revoked. Disabling closes local
execution while requesting server revocation, and reports any unconfirmed cleanup
or revocation. Ordinary process shutdown preserves the owner's grant preference.

`startDaemon` has an optional cloud-host factory, absent by default. The factory
gets only a separate cloud data directory and status callback. Cloud startup
failure logs a fixed code and leaves Local startup intact. Daemon shutdown owns
the separate host's cleanup exactly once. The packaged daemon entry point and
desktop account broker still need to supply this factory through W10's settings
flow; no default cloud connection has been added. CLI discovery for hello metadata
is the caller's responsibility. W5 remains incomplete until that wiring and the
W7 signed bridge are connected and the whole-flow harness passes.

Focused tests use synthetic account responses and a localhost Cell to check bridge
transport while task acceptance is off, explicit grant use, revocation on reconnect
and disable cleanup. The injected bridge returns `approval_required`; it runs no
command and does not establish W7. Daemon tests verify isolated lifecycle cleanup.
C1 tests first authenticate to the fake account, then run a real Local task through
the daemon with the cloud host off or forced to fail startup. They fail on any HTTP
request during task execution and verify the Local result. No real keychain,
provider, account, desktop window or command approval is used.

The public dependency scanner permits the two account HTTP route strings used by
this client as values. Those same strings still fail when used as module imports,
as do private service/filesystem paths. A headless scanner test checks both cases.
The allowlist grants no access to service implementation code or hosted values.
