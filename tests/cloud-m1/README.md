# Cloud milestone 1 headless harness

Run `pnpm test:cloud-m1` from the repository root. It needs no accounts, keys,
installed provider CLIs, owner keychain or desktop windows. It starts only owned
localhost services and native CLI stand-ins in disposable folders.

The identity fixture generates an ephemeral ES256 signing key in memory. Its
localhost JWKS test uses the real Cell verifier for desktop, phone, Mac-runner
and task-bound sandbox identities. The account fixture extends the existing
`tools/fakes/src/cloud.ts` server with native test sessions, device keys, explicit
runner grants, scoped token issuance, refresh rotation and write-only secrets.
It uses separate phone and desktop sessions. HTTP clients cannot create fixture
sessions or load signing keys. No provider, account or cloud credentials are
needed. These are test fixtures, not deployable authentication services.

The tests exercise these components over localhost. The real Durable Object
fixture bundles the Cell in memory, restricts outbound requests to numeric
loopback, and checks authorization and persisted project state across a runtime
restart. The TLS fixture generates its private key in memory and passes it to
OpenSSL through a private pipe. Isolated Node children trust its public
certificate through an environment variable while keeping TLS verification on.
Miniflare debug-config file output is refused before service credentials are set.

The worker component tests build the actual worker CLI from source, start it in
an owned directory through the sandbox fake target, and connect it to the real
Cell through verified localhost TLS. Both native provider stand-ins deliver a
turn to review. The fake Global injects task-bound credentials in the child
environment and uses the public orchestrator journal. A Git shim maps the
fixture's canonical repository URL to a disposable bare remote and refuses
other remote operations. The Codex shim also serves the checked-in protocol
schema for its native schema-generation command.

The headless Mac fixture starts the actual daemon API in an isolated Node child.
It uses an in-memory keychain and the private account broker, explicitly opts
into Mac execution and leaves Mac task execution off. Its HOME and ZDOTDIR point
to a disposable folder. The child trusts only the public localhost test
certificate in addition to Node's normal roots; TLS verification stays on.
Scripted phone clients hold independent device keys and account sessions.

The joined component tests request a task revision, sign its exact `uname`
approval on the phone, and check that the result returns to the same sandbox
thread with the host's output and exit code 0. Both providers then receive a
phone answer to their next native question and finish that revision. A forged
phone signature must be refused by the Mac before any process output file is
created. The synthetic providers use explicit `[cloud-m1:...]` markers inside
real task prompts to select these scenarios; ordinary task prose keeps its
existing behavior.

The whole-flow test runs independently for Claude and Codex. Each case starts
three sandbox tasks, answers a native question on the phone, requests a revision
that runs `uname` through the signed Mac gate, kills a worker mid-turn and resumes
its native conversation, commits the reviewed diff, pushes its branch to bare
Git and records one synthetic PR. It advances the usage clock to refuse a fourth
task, then deletes the account and checks the sandboxes, secrets, device keys and
persisted Cell project/event/identity records are gone.

The network fault hook duplicates one real event and drops later acknowledgements;
it preserves the required initial cursor. Recovery reconciles the on-disk outbox
against the Cell and finishes with one assistant result and no duplicate transcript
IDs. The fixture's hang scenario recognizes the native restart continuation;
ordinary task prose keeps its previous behavior. Cell source and its authorization
checks remain unmodified in the runtime fixture.

The command also runs the existing signed-in Local boundary tests. Any HTTP
request during Local task execution fails those tests, including when a cloud
host fails to start. These fake results do not prove Docker/E2B template behavior,
real provider permissions, client UI or the live milestone. Native pending
questions and tools still need process-loss recovery in the worker. Docker
build and live owner-gated checks remain separate gates.

Keys, tokens and provider stand-ins stay in memory or private process pipes.
The test server must listen on numeric loopback only. No browser or Electron
window, real keychain, real provider or external network request belongs here.
