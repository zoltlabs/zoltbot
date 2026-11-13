# Phone Cloud account

The phone has its own native account session. Its credential owner uses the
system authentication session with a fixed `zoltbot://account/callback`, random
state and S256 PKCE. Google still returns to the hosted broker. The owner
validates the broker URL and exact callback before redeeming a one-time handoff.
A redirect cannot choose another account-service origin or native app.

`nativePhoneAccount` is a singleton with Expo WebBrowser, asynchronous native
random bytes and SecureStore. `EXPO_PUBLIC_ZOLTBOT_HOSTED_ORIGIN` selects the hosted
account origin at build time; an unconfigured build starts no authorization.
Account records are bound to that origin and accessible only on this device after
its first unlock. Raw credentials stay in SecureStore or the owner closure.
React receives projected metadata, not access/refresh credentials or CSRF values.
The browser and native storage adapters are ports in headless tests; no test
opens an authentication session, native app or owner keychain.

Implementation choices:

- Serialize native account I/O and persist refresh rotation before using its new
  bearer. If persistence fails, clear the uncertain session before accepting more
  work. Rotation must keep the same session. If cleanup itself fails, refuse
  further use; the same rendered session may retry its local cleanup.
- Validate state, callback shape and the sole code/state pair before redemption.
  Cancellation invalidates late responses and removes a saved result if it arrives
  while secure storage is completing. Duplicate sign-in attempts are refused.
- Bind sign-out to the rendered session before HTTP or storage effects. A remote
  logout failure still clears local account custody and reports that remote
  revocation could not be confirmed.
- Store account credentials under a separate key. Account sign-out never removes
  the Local pairing identity or paired Mac. Pairing remains an independent path.
- Hold no offline account content cache. An outage reports offline; a revoked
  refresh removes account custody. Unexpected API fields are not projected to UI.

The account owner and Expo adapter are not yet selected by the phone screens.
Device-key registration, Cloud transport/Needs you, signed approval UI, push and
simulator verification remain W11 work. This module is not W11 sign-off.

## Notification routing

Cloud notices carry an explicit org scope and opaque event digest. The decoder
returns `open_cloud` for a normal tap; Cloud quick-action identifiers never become
an unsigned answer. A malformed or conflicting scope is quarantined before any
Local action or chat navigation. Equivalent nested scopes are accepted regardless
of JSON property order. Existing paired-Mac approvals and thread taps keep their
previous behavior.

The native notification handler does not yet dispatch `open_cloud`. Cloud account
validation, navigation, registration and signed approval UI still need integration.
The tests check the actual relay payload and phone decoder together, with no real
APNs traffic or native notification registration.


## Native Cloud API port

The account owner exposes fixed methods for registered device keys, notification
tokens and short-lived Cell connections. Each call carries the account session
shown by the screen. An old session is refused before Cloud HTTP, request bodies
are frozen before entering the shared refresh queue, and acknowledgement responses
accept only `{ ok: true }`. A registered key must derive the supplied device ID.
The phone cannot use this port to read provider secrets or call an arbitrary URL.

A Cell connection returns its HTTPS origin, expiry and a memory-only token reader.
JSON serialization and secure storage contain no Cell token. Clearing the handle,
signing out, changing sessions or reaching expiry disables its reader. Cell tokens
are bounded to eleven minutes including clock allowance. The phone pins the returned claims to the current member, org, session and device,
requires a phone client token without runner authority, and limits expiry to the
signed expiry. This decoding is not signature verification: the Cell verifies the
signature and current account/device authority. A malformed successful
account refresh clears uncertain custody rather than retrying a consumed value.

These methods are not yet selected by Cloud screens or transport. Tests use the
loopback fake broker, RAM-only keys/store and fake Cloud responses. No phone app,
keychain, real Google account or hosted service was contacted.

A refused Cloud permission returns `account_access_refused`, so the Cloud owner
can discard its projections without signing the person out of their account.
Rejected native refresh authority clears account custody before any Cloud retry.


## Work-in-progress checkpoint

The owner requested this checkpoint before the milestone checks passed. The
account API tests last printed `28 passed` before adding the connection's owner
metadata. Mobile typecheck passed with that metadata and `connection.ts`. The
new connection has no transport tests or native adapter yet, and no screen selects
it. Verify reconnect races, authority loss, read-only caches, command outcomes,
subscription isolation and teardown before connecting it to the phone. This is
unverified implementation work, not W11 sign-off.
