# Cloud milestone 1 harness (in progress)

This folder does not yet provide `pnpm test:cloud-m1` or pass W8.

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

These checks do not run the whole outcome. The harness still needs to join the
headless daemon and scripted phone client, with assertions for Mac execution,
review publication, process recovery, quota refusal and account deletion. Native pending questions and tools also still need
process-loss recovery in the worker. The eventual command must assert every
outcome before W8 can pass.

Keys, tokens and provider stand-ins stay in memory or private process pipes.
The test server must listen on numeric loopback only. No browser or Electron
window, real keychain, real provider or external network request belongs here.
