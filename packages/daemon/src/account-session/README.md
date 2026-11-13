# Native account sessions

The session module owns keychain-backed credentials, refresh rotation and account
HTTP requests. Calls share one queue: a 401 triggers one refresh, saves the rotated
credentials to keychain, then retries. The reference file contains only an opaque
keychain reference. A refused refresh clears the local session. Errors do not open
a browser; browser authorization remains an explicit desktop action.
Reopening before sign-in or sign-out resolves the existing reference before
replacing/removing it, so those actions do not leave old credentials in keychain.
Queued inputs and returned credentials use copies to protect the session state.

The desktop account controller now uses the daemon broker while retaining its existing
sign-in, sign-out, artifact and session-management flows. Its IPC methods continue
to return metadata. Credential-bearing `load` and `save` are internal native ports,
never renderer endpoints. A process that owns this session must proxy other native
callers through that same owner. Separate processes must not independently rotate
the same account credentials.

The broker below provides the native IPC seam. The daemon owns it when its account
origin is configured; the desktop controller uses that owner. Mac runner startup
and client settings wiring remain unfinished. The headless fake
whole-flow command now passes for both providers. Tests use
generated memory-only credentials, a fake keychain and an injected HTTP transport.

## Native broker

`startAccountBroker` owns the session and its refresh queue. Native callers use
`accountBrokerClient` over a Unix socket in an owner-only directory. Socket
permissions are 0600, the directory is 0700, and separate locks protect both the
endpoint and the credential reference. It refuses live endpoint replacement and
preserves unrelated files. The client verifies ownership and permissions before
sending. There is no TCP listener, browser route or renderer endpoint.

The client can save credentials from native authorization, clear the session,
read signed-in/session-ID metadata and call the existing allowlisted account and
artifact endpoints. It cannot load credentials or bypass refresh through an auth
endpoint. Access and refresh values stay in the broker and keychain; a response
containing a known credential is refused, including after rotation. Artifact
content capabilities remain native-only and still need the desktop controller's
existing filtering before renderer IPC.

Keychain records bind credentials and the exact origin in one atomic envelope.
A changed origin cannot receive the previous origin's bearer. Legacy unbound
credentials require one fresh Google sign-in when this broker is selected.
The desktop uses this broker; the daemon rotates and persists credentials.
The disk reference remains an opaque keychain reference.

Requests serialize through one owner, including session-change notification.
The notification is for local cleanup; it must not reenter this broker. A failed
notification is reported and retried on the next action. Shutdown aborts account
HTTP I/O and drains accepted work before releasing ownership. Native callbacks
must bound their own cleanup and keychain work.

The package caps active requests at two, text bodies at 1 MiB, binary artifact
bodies at 25 MiB, complete request frames at 36 MiB and responses at 8 MiB. These
limits and the account-route allowlist are implementation choices for M1. Tests
cover two clients sharing one refresh, private socket modes, restart cleanup,
origin and legacy refusal, endpoint ownership, binary uploads, invalid routes,
shutdown, cleanup retry and credential-echo refusal. They use no real keychain,
account service or native application. Packaged W5 wiring remains unfinished.


The native runner uses `brokerRunnerRequest` through the same owner. The runner
adapter calls GET device keys, PUT runner grants and POST runner tokens
through this port. Account metadata and cloud calls share refresh rotation and keychain
persistence. The runner receives its own scoped Cell token, never the account
access or refresh credential. A grant refusal stops runner authority while
leaving a still-valid account session signed in. Configuration must select one
of native-session requests or direct bearer access; it cannot select both.

Canceled requests do not start after waiting in the native client's queue.
The socket closes on cancellation, and the server skips disconnected requests
that have not started dispatch. An accepted refresh still drains and persists
before shutdown releases credential ownership. Tests cover the actual private
socket path with a memory keychain and injected account transport. Packaged
startup and settings still do not select this port; W5 remains unfinished.

## Cloud settings ports

Session-bound native settings may register/revoke public device keys, request a
client Cell token and write Anthropic, OpenAI or GitHub credentials. Inputs use
the public schemas. Key and device writes return only `{ ok: true }`; unexpected
response fields fail with a fixed error before the broker can return them. No
secret read route exists. These ports do not enable Cloud, grant a runner or
start a process themselves.

The packaged daemon supplies its native keychain to this owner; the desktop
uses the private socket and retains browser authorization. Legacy credentials
without an origin binding require one fresh Google sign-in.
The controller captures the current session before queueing protected actions,
so a status reload cannot move an old-account action onto a new account.
No Cloud runner grant or connection starts merely because an account is present.

Native broker paths resolve from the configured app data directory. The desktop
passes its absolute data path to the daemon, including when a developer supplies
a relative data-directory override. Account startup failure logs a fixed code
and leaves Local work available.

The desktop waits up to five seconds for the daemon’s private socket during cold
startup. It rechecks its session after waiting and preflights the owner before
opening the sign-in browser. It does not create a second credential owner.

Cancel sign-in also cancels the owner preflight. Its loopback listener closes
and the browser stays unopened when cancellation arrives during readiness.
