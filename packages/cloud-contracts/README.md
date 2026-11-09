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
