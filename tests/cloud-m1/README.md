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

The tests currently exercise these components over localhost. They do not run
the whole outcome. The harness still needs the real Durable Object, the fake
execution target and worker CLI, the packaged headless daemon, scripted device
clients, the bare Git remote and the assertions for Mac execution, recovery,
quota refusal and deletion. Native pending questions and tools also still need
process-loss recovery in the worker. The eventual command must assert every
outcome before W8 can pass.

Keys, tokens and provider stand-ins stay in memory or private process pipes.
The test server must listen on numeric loopback only. No browser or Electron
window, real keychain, real provider or external network request belongs here.
