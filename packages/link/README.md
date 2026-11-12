# Device links and approvals

The package provides the portable pairing transport and Ed25519 identities used
by desktop and phone clients. The Mac approval helpers use those same device
identities, with a separate signature domain from pairing and relay proofs.

`signApproval` signs a fixed-order JSON array of the versioned approval fields.
`verifyApproval` requires both the expected payload and a registered public key
from its caller. A key or expected command supplied by the Cell does not establish
authority. Unknown fields, noncanonical base64url, invalid signatures, expired
approvals and a clock more than thirty seconds before issuance are refused.
One-command approvals last at most five minutes. Prefix approvals carry an
explicit task lifetime; the Mac must also check that the task remains active.

The signature binds organization, member, approving device, request, task, turn,
target Mac, command or prefix, absolute folder, exact stdin hash, timeout and
issuance/expiry times. This prevents a relay from substituting execution options
that the person did not approve. The stdin hash uses SHA-256 over UTF-8 bytes.
The signer must display those options before signing.

Verification only authenticates an exact payload. It does not consume a request,
match command prefixes, fetch device keys or run a shell. Those responsibilities
belong to the Mac runner, including durable replay protection, key revocation,
task expiry and the rules that always require a fresh approval. W7's runner,
Cell routing and client integration remain unfinished.
