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
