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

The packaged phone routes select the account and Cell transport. Cloud Needs you
uses the phone's existing Keychain identity for device registration and signs
Run on my Mac approvals from the pending request. Walk the native Google sign-in,
notification delivery and screen states in an isolated iOS simulator for W11.

## Notification routing

Cloud notices carry an explicit org scope and opaque event digest. The decoder
returns `open_cloud` for a normal tap; Cloud quick-action identifiers never become
an unsigned answer. A malformed or conflicting scope is quarantined before any
Local action or chat navigation. Equivalent nested scopes are accepted regardless
of JSON property order. Existing paired-Mac approvals and thread taps keep their
previous behavior.

The native notification handler validates the selected session and personal org
before it opens Cloud Needs you. The tests check the relay payload and the phone
decoder. Live APNs delivery still needs verification.


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

The account tests use the loopback fake broker and in-memory credentials. The
packaged account and Needs you screens obtain their state from the native owner.

A refused Cloud permission returns `account_access_refused`, so the Cloud owner
can discard its projections without signing the person out of their account.
Rejected native refresh authority clears account custody before any Cloud retry.


## Phone Cell transport

The native adapter uses the phone account's short-lived bearer in the TLS
WebSocket handshake. The connection keeps its last snapshot in memory and
marks it read-only during reconnect. It renews credentials before expiry and
resubscribes from the previously observed sequence. If a command loses its
reply, the caller gets an unknown outcome. Reconnect sends only subscription
and snapshot requests.

When the account owner loses its session or the Cell revokes access, the
connection clears the credential handle and cached snapshot and stops trying
to reconnect. Local pairing has its own transport and storage.

The transport tests cover late credentials and frames, subscription
listeners, close errors, offline commands, renewal and revocation. The
headless Cloud M1 harness also uses the phone account with a real Cell over
localhost TLS. The simulator run remains part of W11.
