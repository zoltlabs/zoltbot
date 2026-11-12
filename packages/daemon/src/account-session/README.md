# Native account sessions

The session module owns keychain-backed credentials, refresh rotation and account
HTTP requests. Calls share one queue: a 401 triggers one refresh, saves the rotated
credentials to keychain, then retries. The reference file contains only an opaque
keychain reference. A refused refresh clears the local session. Errors do not open
a browser; browser authorization remains an explicit desktop action.
Reopening before sign-in or sign-out resolves the existing reference before
replacing/removing it, so those actions do not leave old credentials in keychain.
Queued inputs and returned credentials use copies to protect the session state.

The desktop account controller now uses this module while retaining its existing
sign-in, sign-out, artifact and session-management flows. Its IPC methods continue
to return metadata. Credential-bearing `load` and `save` are internal native ports,
never renderer endpoints. A process that owns this session must proxy other native
callers through that same owner. Separate processes must not independently rotate
the same account credentials.

This extraction prepares the daemon credential broker; it does not wire daemon
IPC, start a Mac runner or complete the whole-flow harness. Tests use generated
memory-only credentials, a fake keychain and an injected HTTP transport.
