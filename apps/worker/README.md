# Sandbox worker

`zolt-worker` runs one cloud task inside its sandbox, using the daemon's shared
native task host and Claude or Codex adapter. It has no Local store, desktop
controller or subscription-login fallback. W6 remains in progress: killed-turn
and pending-tool continuation, the Docker build and whole-flow M1 harness remain
unfinished. The CLI offers `mac_exec` and `mac_status` through the cloud runner.

## Boot configuration

The orchestrator injects configuration through environment variables. No dotenv,
secret file or command-line credential is read.

| Variable | Meaning |
| --- | --- |
| `ZOLTBOT_CELL_URL` | HTTPS Cell origin |
| `ZOLTBOT_CLOUD_ORIGIN` | HTTPS account-service origin |
| `ZOLTBOT_ORG_ID`, `ZOLTBOT_TASK_ID` | The one organization/task this worker may run |
| `ZOLTBOT_MEMBER_ID`, `ZOLTBOT_RUNNER_ID` | Member and logical sandbox-runner identity |
| `ZOLTBOT_PROVIDER` | `claude` or `codex` |
| `ZOLTBOT_SLEEP_KEEPS_PROCESSES` | Explicit `true` or `false`, copied from the target capability |
| `ZOLTBOT_RUNNER_TOKEN` | Initial short-lived, task-bound ES256 Cell bearer |
| `ZOLTBOT_WORKER_REFRESH` | Opaque 32-byte base64url worker-refresh capability |
| `ZOLTBOT_PRIVATE_CONTEXT_KEY` | Stable 32-byte base64url task-vault key |
| `GITHUB_TOKEN` | Member's repository credential |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | API key for the selected provider |

Boot checks the injected token's decoded task/member/runner scope and lifetime.
Decoding does not authenticate it: the Cell independently verifies ES256 and
current account/resource authority. The worker keeps credentials in private closures and exposes them through
functions rather than enumerable JSON fields. The CLI removes recognized secret fields
from its own ambient environment after reading them. Native children receive only
explicit launch credentials. JavaScript strings cannot be erased reliably.

`workerCredentials` reuses a current token, then renews through
`POST /api/cloud/worker-token` using `Authorization: Worker …`. Its body contains
only org, task and runner IDs. Concurrent renewals share one request. Replies must
retain the injected task and Cell origin, have matching JWT/response expiry and
stay within the short lifetime. TLS, redirect refusal, deadlines, bounded response
bytes and fixed errors apply. The private API still needs to implement that route;
this client does not establish hosted refresh authorization by itself.

## Ownership and repository setup

A SQLite owner lock excludes a second worker before token requests or native
startup. The worker owns its environment object until close; callers must not
share that object across worker lifetimes. Production control data lives in
`/home/user/.zoltbot`. The repository lives at `/home/user/work/<repo>`, with
checkout bindings, task cache, encrypted private context and outbox outside it.
Tests supply separate disposable roots. The worker takes no Mac folder as input.

The shared workspace preparer pins a base commit and task branch, preserves edits
and refuses a different org/task. Setup runs before native startup while the task
cache's owner lock is held. Its durable checkpoint binds org, task, canonical cwd,
base commit and script hash. Completed setup does not run again on reconnect or
restart. A failed script stays failed; a process killed after setup began leaves
an interrupted checkpoint and cannot silently repeat uncertain side effects.

Setup accepts the protocol's 64,000-character script bound. Its default deadline
is fifteen minutes; the internal test/host option permits at most one hour.
Stdout/stderr are discarded, with a combined one-MiB cap. Failures expose fixed
codes, not script output or environment values. Setup receives a bounded explicit
environment, including the repository token, rather than all worker credentials.
The parent-owned process group stops on cancellation, timeout or parent death.

## Native execution and recovery

`startWorker` composes managed workspaces, the isolated task cache, the encrypted
vault, `InProcessRunner`, host MCP and the runner connection. Only the injected
provider may run. Version discovery receives no secrets and checks no login state.
The selected provider's API key is required even if a native login happens to exist.
Account and runner bearers never enter native launch environments.

The worker registers known environment values with native redactors before it
logs frames or observations. Frame suppression and normalized-output redaction
also cover a host tool whose synthetic result echoes the repository credential.
Private context uses the shared AES-GCM vault and the injected task key. Shutdown
settles task/native cleanup before closing the vault, releasing ownership and
clearing credential references.

A disconnect or credential renewal reconnects the existing native runtime.
Unacknowledged observations replay from the transactional SQLite/JSONL journal.
After a process restart, the task cache and native identity resume the original
conversation. Setup is not repeated. The orchestrator must preserve the task key
and restart the entrypoint after a wake whose target loses processes. The worker
advertises the explicit injected sleep capability; it never assumes memory pause.

## Build and checks

Run `pnpm build:worker` from the repository root. The bundler targets Node 22 and
keeps the existing desktop bundler's Node 24 default. Bare runtime imports must be
explicit worker dependencies; the build fails if one is undeclared. The resulting
entrypoint is `apps/worker/dist/main.mjs`. Its source-relative resources and pinned
dependencies remain in the repository layout used by the template image.

Headless tests use the public Claude/Codex protocol fakes, a localhost fake Cell,
disposable bare repositories and generated in-memory credentials. They cover
one-time setup, parent-crash cleanup, scope refusal, refresh response refusal,
reconnect replay, native resume and absence of credential bytes in fixture files
and transmitted events. The executable smoke test starts with no credentials and
must reach the fixed configuration error without opening an agent. No installed
provider CLI, owner keychain, desktop window or real provider request is used.

The [base template](../../templates/sandbox/README.md) still needs an actual Docker
build and E2B acceptance. Parsing its Dockerfile through the pinned E2B SDK is an
offline compatibility check, not either of those gates. `pnpm test:cloud-m1` and
live verification remain pending.

Mac tools first flush committed native observations through their Cell
acknowledgements, so the Cell has the calling turn before a tool request arrives.
Status, including that wait, has a 1.9-second deadline. An offline Mac returns an
error without requesting execution. A command uses the Mac's resolved folder and
target, then reads durable approval/result progress. Polls use the same task and
request ID; transient disconnects replay the transport request. Native tool result
IDs survive that connection's retry. Recovery of an outstanding tool after worker
process loss still needs the W6/W8 continuation work.

The tool host checks known private context and injected credentials before any
Mac RPC. Cloud command results use the bounded rich host-tool result, preserving
the Mac's output caps beyond the normal 4,000-character tool summary. These two
definitions are exported separately from the Local runtime tool set. Tests drive
both fake native providers through the default worker tools and assert that the
calling turn reaches the fake Cell first. The fake Cell supplies a scripted result;
these tests do not prove signed execution or the full M1 flow.

An explicit credential-service response of 401, 403 or 410 stops the connection,
queued cloud work and native runtime. A network failure, 429 or service error
keeps the runtime for offline replay and retries. The worker closes its remaining
vault/owner resources after revoked access. Cleanup failures return a fixed error
rather than being reported as successful shutdown. No response body enters these
errors. The native account callback must refresh its account session before
requesting a runner token, so ordinary access-token rotation does not look like
revocation. These rules also apply to the Mac transport and leave Local tasks alone.

A Cell HTTP authentication refusal or an explicit forbidden WebSocket close also
withdraws authority and stops native work. Protocol/transport outages still use
the reconnect path. The transport never logs a WebSocket refusal body or reason.
