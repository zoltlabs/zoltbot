# Cloud wire contracts, v1

Public request/response schemas cover native PKCE handoff and refresh credentials,
artifact reservation/list/view/visibility and the integration broker's authorization,
provider-token and catalog surfaces. Artifact manifests use the protocol schema.
Blob bodies are bytes; commit/revoke/logout success is acknowledged by HTTP status.
The artifact view schema describes the fields the desktop consumes: content capability
URLs and additional server metadata must never cross renderer IPC.

Servers retain endpoint/redirect validation, consent, authorization, storage quotas,
provider custody, content validation and rate limits. Schema validity grants no access.
Broker token responses follow OAuth wire names; never persist them in fixtures.

Additive response fields remain compatible within v1. Removing fields or changing
semantics requires a new contract version and a migration. The supported old-client
window is an owner decision, not defined by this package. Synthetic credentials are
examples only. Private PostgreSQL and broker tests parse real server responses with
these schemas; public controller tests use an independent synthetic HTTP fake.

## Cloud tasks

The M1 wire types contain cell and runner claims, public JWKS entries, member device
keys, write-only secret inputs, and cell-to-orchestrator operations. Hosted configuration
and credentials remain in the hosted service.

Cell tokens use audience `cell`; cell-to-orchestrator tokens use `orchestrator` and a
separate signing key. Claims use standard `sub` for the member and `org`, `device` and
`surface` for authorization. Token verification must also enforce issuer, time, runner
grant and sandbox-task binding; schema validation alone does not authenticate a token.

Secret names are `anthropic`, `openai` and `github`. Sandbox create calls carry repository
and provider metadata, not credentials or task transcripts. The orchestrator loads and
injects the member's credentials at create time. Usage operation ids support idempotent
accounting when a cell retries a lifecycle call.

Runner-grant input requires both task-execution and Mac-command capabilities.
Org, member, session, expiry and grant identity are server-derived and cannot enter
that input. Result/list schemas expose only grant metadata; no account or runner
credential belongs there. A null result means the session has no enabled grant.
Creation is an explicit owner action. Reconnects request tokens against the existing
grant and must never recreate a grant that another owned device revoked.

The worker-token request contains only org, task and logical runner IDs. Its opaque
refresh capability belongs in the authorization header, and provider/vault keys
never enter this request. The worker validates the returned token's injected scope;
the Cell still verifies its signature and current resource authorization. The
private hosted refresh route is not implemented by these wire types.

The device-list wrapper contains only registered public-key metadata. Mac command
approval verification reads it through the Mac's own account session, checks the
member and revocation state, and pins the key identity. A Cell-supplied key or a
wire schema match cannot authorize execution.

## Content-free phone notifications

Cloud registration accepts an APNs environment and bounded hexadecimal device
token. The Global API must authenticate the phone session and its registered
device before storing it. No read response exposes that token.

Cell notifications carry only the member/org/task/thread identifiers, a digest
of the originating event ID, a fixed kind and a bounded count. They contain no
question, command, task title or credential. The Global API must enforce the org
service token and current membership; these schemas grant no authority.

The push context marks a Cloud org and notification digest. Phone decoding must
keep it separate from Local pairing and fetch the current request before an
answer. A push notice never authorizes a Mac command. These are additive v1
contracts. Hosted registration, delivery and deletion remain integration work.
