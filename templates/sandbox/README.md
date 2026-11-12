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
SDK without an account or network request. An actual Docker build and live E2B
acceptance remain unverified.

`e2b.toml` names `zoltbot-base`, four vCPUs and 8 GiB. Its template ID is a
placeholder. Generated account/template IDs and publish configuration belong in
the private repository. The publisher must use an archive of the approved public
commit and pass the root ignore rules to the SDK's file-context configuration. Publish only after the owner supplies O1 and the public
source has been approved and pushed.

E2B starts template commands during template warm-up, before task secrets exist.
The entrypoint therefore idles without an injected runner token. The orchestrator
starts the same entrypoint with the task environment after create and after a wake
without processes. Docker starts it directly when create supplies the environment.
Secrets are never baked into the image, readiness command, argv or a startup file.
This uses the documented [E2B template build/start process](https://e2b-preview.mintlify.app/sandbox-template).
The private orchestrator wiring and its live verification are still pending.
