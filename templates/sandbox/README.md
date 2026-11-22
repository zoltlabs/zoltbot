# Base sandbox template

The M1 image uses Ubuntu 24.04, Node 22.23.4, Git, `gh`, Chromium, Claude Code
2.1.299, Codex 0.164.0 and `zolt-worker`. Node is downloaded from its official
release directory and checked against the release SHA-256 list. The Node pin comes
from the [22.23.4 release](https://nodejs.org/en/blog/release/v22.23.4). Agent pins
must track their public adapter definitions and conformance fixtures.

Build from the public repository root:

```sh
docker build -f templates/sandbox/Dockerfile -t zoltbot-base .
```

The root `.dockerignore` excludes local dependencies, caches, environment/key
files, machine settings, generated native projects and old private checkout paths. The image builds the Node 22 worker and compiles
the SQLite binding for that runtime. Source-relative worker resources retain their
repository layout under `/opt/zoltbot`. Task execution uses the unprivileged
`user` account and `/home/user/work/<repo>`.

The Dockerfile has one stage because the pinned E2B SDK rejects multi-stage
Dockerfiles. `packages/sandbox/src/worker-template.test.ts` converts it through that
SDK without an account or network request. The local ARM64 Docker build and a network-disabled runtime check passed.
The check verified the pinned CLIs, Chromium, the Node 22 SQLite binding, an
unprivileged user and absence of the build-only `CI` setting at runtime.
Live E2B acceptance remains unverified.

`e2b.toml` names `zoltbot-base`, four vCPUs and 8 GiB. Its template ID is a
placeholder. Generated account/template IDs and publish configuration belong in
the private repository. The publisher must use an archive of the approved public
commit and pass the root ignore rules to the SDK's file-context configuration. Publish only after the owner supplies O1 and the public
source has been approved and pushed.

E2B starts template commands during template warm-up, before task secrets exist.
The entrypoint therefore idles without an injected task refresh capability. The
orchestrator starts the same entrypoint with the task environment after create
and after a wake without processes. The worker can obtain its first Cell token
through that capability once the account service records the VM; a still-creating
record returns a retryable 503 instead of causing a premature Cell authentication
refusal. Docker starts it directly when create supplies the environment.
Secrets are never baked into the image, readiness command, argv or a startup file.
This uses the documented [E2B template build/start process](https://e2b-preview.mintlify.app/sandbox-template).
The private orchestrator wiring and its live verification are still pending.

The production-dependency install sets `CI=true` for that command only, so pnpm
can replace the build-time modules without a TTY. The agent runtime does not
inherit that build-only setting.

Docker and Boat build the worker with `install.sh`. Run the shared runtime
checks against a local image with Docker networking disabled.

```sh
docker run --rm --network none --entrypoint sh zoltbot-base /opt/zoltbot/templates/sandbox/verify.sh
```

With the approved Boat account available, build the managed snapshot from
the approved public commit. The builder reads `BOAT_API_KEY` from the
environment and verifies a fresh sandbox from the saved snapshot.

```sh
node --import tsx packages/sandbox/acceptance/boat-template.ts <published-public-commit>
node --import tsx packages/sandbox/acceptance/boat.ts --native --us-region <us-runner-region>
```

The acceptance run also needs the Claude Code and Codex API keys in the
environment. Its report is stored under `.cache/sandbox-acceptance`.

## The agent's desktop (B8)

The image also ships Xvfb, Openbox and x11vnc. `zolt-desktop` starts a virtual screen, the
window manager and a VNC server on `ZOLTBOT_DESKTOP_PORT` (default 5900). Nothing starts it at
boot; the worker runs it when an agent asks for a desktop.

`ZOLTBOT_VNC_PASSWORD` is required, letters and digits only. Classic VNC auth uses just its
first 8 characters and is weak against anyone who can watch the traffic, so the password is a
second lock; the first is that the port is reachable only from the daemon's machine. The
password reaches x11vnc through a file x11vnc deletes once read, never through argv.

Only targets whose capabilities say `privatePorts: true` may expose that port. Docker
publishes it on 127.0.0.1 and puts sandboxes on a bridge with container-to-container traffic
off, so one sandbox can't reach another's desktop. E2B exposes ports through a public proxy,
so it says false until a private route exists. The conformance scenario `private_port` checks
the address handed out is loopback and that raw TCP reaches the sandbox; it doesn't probe the
target's isolation. The Mac's Desktop view needs a bundled noVNC (MPL-2.0, unmodified, with
its notice), which is not added yet.
