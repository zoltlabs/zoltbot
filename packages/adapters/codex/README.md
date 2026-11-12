# Codex adapter status

The adapter uses versioned app server schemas supplied by the daemon host. Protocol schemas and a prompt free initialization are verified on Codex 0.164.0. A real local experiment also verified per thread HTTP MCP configuration and authenticated tool discovery. Model turns and real approval canaries remain pending.

The generic daemon supervisor owns process policy. One RPC peer serves threads for one provider definition and CODEX_HOME. Session leases keep another thread running when one closes. Native resume rejects an existing local writer; fork creates a separate thread. Instructions and host MCP configuration are restored on resume. Model and effort overrides are sent only after an explicit setting change.

All 22 shared conformance cases pass against a stateful fake that validates calls and approval replies against the generated schema. Focused tests cover schema contracts, duplicate question text, permission grants, cumulative usage, process sharing, fork ownership, native listing, authentication, overload retry, timeouts, terminal state fencing, broken binaries, and retry after a failed preflight. No tests are skipped.

WP-11 remains unmerged until the real installed CLI canary passes. Binary probing and schema cache provisioning are host services; the Doctor and session manager packages supply them in the product.

Cloud hosts can bind the host credential to an explicit child environment entry
with `hostMcp.tokenEnv`. Their per-thread MCP configuration uses
`bearer_token_env_var`, so it contains no credential value. The shared SDK rejects
missing or mismatched bindings. The existing header-based Local route is unchanged.
This follows the documented [HTTP MCP configuration](https://developers.openai.com/codex/mcp/).
Unit tests and the synthetic native HTTP fixture verify authenticated tool calls
and absence of credential bytes in fixture files. Live sandbox acceptance remains
unverified.
