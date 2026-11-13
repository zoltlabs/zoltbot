# Sandbox execution targets

Slice S1 of the cloud sandbox plan (docs/cloud/sandboxes.md §2, D134). One interface, `ExecutionTarget`, wraps a sandbox provider: `create`, `wake`, `sleep`, `destroy`, streaming `exec`, `files.read`/`write`/`list`, `ports.expose`, `snapshot` and `status`, with declared capabilities (snapshot, persistent volume, max lifetime, SSH, GPU, whether sleep keeps processes, port exposure and sizing) and a declared version range. Provider names stay under `src/targets/*` (I4).

| Target | Import | Purpose |
|---|---|---|
| Fake | `@zoltbot/sandbox/fake` | Each sandbox is a private folder on this machine; processes run in their own process group with a clean environment. Sleep stops the group and wake continues it. Offline and headless. |
| Docker | `@zoltbot/sandbox/docker` | Dev target for the conformance suite and template work, through the docker CLI. Not offered to users. Default image `node:24-bookworm-slim`. |
| E2B | `@zoltbot/sandbox/e2b` | Managed target on E2B's hosted service through the official `e2b` SDK (2.62.2, declared range `>=2.62.2 <3`). Takes the API key from the caller. |

## Conformance

`@zoltbot/sandbox/conformance` holds the shared scenarios: lifecycle, exec output, streaming, environment and working directory, kill, missing command, files, files through exec, ports, sleep and wake, snapshot, and sizing. Each scenario creates and destroys its own sandboxes. Capabilities decide what is asserted: a target that declares `sleepKeepsProcesses` must keep a background process alive across sleep, and one that declares `ports: "declared"` must refuse an undeclared port.

- Fake: always runs in `pnpm test`.
- Docker: runs in `pnpm test` whenever a docker daemon answers and skips otherwise. Set `ZOLTBOT_TEST_DOCKER=1` to make the daemon required, so a missing daemon fails the run. Containers and snapshot images carry the label `ai.zoltbot.sandbox=conformance` and are removed after the run.
- E2B: opt-in. `E2B_API_KEY=… pnpm vitest run packages/sandbox/src/targets/e2b` runs the conformance suite against the hosted service (`E2B_TEMPLATE` picks a template). The key is read from the environment, passed to the SDK only and redacted from errors (I7). Never commit it or put it in a file in this repository.

The E2B acceptance checks from §2 are scripted in `acceptance/e2b.ts`; see `docs/cloud/sandbox-s1-implementation.md` for how to run them and which have run.

The base worker image is defined in `templates/sandbox/`. An offline test converts
its Dockerfile through the pinned E2B SDK, catching unsupported instructions before
an account is used. This does not replace Docker build or live provider acceptance.
The worker requires the target's explicit `sleepKeepsProcesses` value at boot and
can resume its native session after restarting with preserved task storage.

The fake target's default sleep preserves processes. A fixture that explicitly
sets `sleepKeepsProcesses: false` instead kills its owned groups, waits for their
process streams to close, and preserves only files. Wake permits new processes;
it does not restart an old worker implicitly. This mode exercises orchestration
and native-resume recovery without pretending that a file-only target pauses RAM.

`find(labels)` discovers live or sleeping resources without waking them. It
requires a nonempty bounded label filter and returns references only. The hosted
adapter checks returned metadata and bounds pagination; the Docker adapter also
checks labels/state after its filtered container listing. Docker's operator label
cannot be overridden by task metadata. Scripted SDK/CLI tests use no account or
Docker engine; actual Docker conformance and live provider lookup remain unrun.

`@zoltbot/sandbox/orchestrate` supplies the generic provider-operation helper.
Its [README](src/orchestrate/README.md) records journal, reconciliation and retry
choices and the Global-service responsibilities that remain unfinished.


When the fake target declares that sleep loses processes, it retains each owned
process group until captured streams close. It retries group termination for at
most three seconds, then reports a fixed provider error if processes remain. A
missed first signal must not make the fake claim a successful processless sleep
or wait indefinitely. Tests deliberately drop that first signal and verify the
owned process exits; ordinary sleep still preserves the sandbox files.
