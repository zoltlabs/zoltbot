# Native connection ownership

The main-process manager owns one Local connection for its whole lifetime and,
when explicitly selected, one personal-org Cell connection. Views address an
owner, not a project ID alone: Local and Cloud may contain the same ID. Method
location rules prevent Local-only methods from reaching the Cell and Cloud-only
methods from reaching the daemon. No request falls back to a different owner.

The manager's Cloud factory is a native-only port. `cellConnection` acquires a
scoped Cell token through `brokerCellCredentials`, using the selected native
account owner. Its authenticated WebSocket stays in main; the renderer receives
projections and status. Packaged startup, preload integration and view selection
remain unfinished. This module does not
select the new credential broker or change the existing sign-in flow.

Implementation choices:

- Keep cached projections in memory only. An ordinary Cloud outage retains them
  read-only; all Cloud RPC calls fail while offline. No commands queue for replay.
- Purge the previous Cloud entry before creating its replacement. Every call and
  notification retains its entry identity, so old replies cannot cross an account
  switch. Logout, opt-out and revocation remove the cache; Local stays connected.
- A transport must report authorization loss as `unauthorized`, which removes the
  Cloud entry, rather than as a generic connection outage. Reconnecting it requires
  fresh native account validation. Other failures retain the read-only cache.
- Pin the configured HTTPS Cell origin and refuse redirects or returned tokens
  for another user, session, org, device or runner. Token bytes stay in native
  memory and the TLS WebSocket authorization header. Renew before expiration;
  reconnect with bounded backoff and no command replay.
- Coalesce Cell events into fresh authoritative snapshots. The Cell uses scoped
  reads to build these projections. Do not reconstruct private native provider
  conversations from display data.
- Clone state at native subscription and return boundaries. Subscribers cannot
  mutate another view's projections or retain transport/credential references.

The manager tests use independent fake native ports with colliding project IDs,
delayed old-account replies, late callbacks, revoked authority and an offline
mutation. The transport tests use the actual private Unix broker, a memory
keychain, a fake account service and the real Cell over verified localhost TLS.
They follow project changes, keep credentials out of view state and refuse new
calls after losing the Cell. No test launches a native application. Packaged
connection routing remains unfinished.
