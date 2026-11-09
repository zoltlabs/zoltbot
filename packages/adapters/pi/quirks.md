# Pi 1.4.0

The verified runtime is @earendil-works/pi-coding-agent. The older @mariozechner package is deprecated. No global Pi install was changed.

RPC uses strict LF JSON records. Unicode line and paragraph separators remain inside strings. Match responses by both request id and command. Continuously drain stdout.

agent_end closes one internal run. The user turn remains open until agent_settled, including retries and tool follow ups. Handled extension commands do not create a user turn. Usage from multiple assistant messages accumulates within that turn; get_session_stats supplies cumulative session usage and context.

Explicitly load the bundled gate and builtin:mcp while automatic discovery is disabled. Hash check the installed source before spawning. Verify get_commands source metadata, then a nonce bearing readiness notification. MCP discovery can complete after command registration, so readiness waits up to ten seconds for the host namespace.

The gate blocks unknown actions without an explicit confirmation. Read only profiles cannot execute or edit. Workspace edit paths resolve existing ancestors and symlinks before checking containment. This is a permission gate, not an OS sandbox. Filesystem races require the separate isolation work package.

Native questions and plan review are unavailable. The host MCP interaction route will supply these product features. Unsupported native dialogs cancel rather than receiving an automatic approval. Native session listing remains WP-21 work. Permission profiles are immutable for an open Pi process.

The real bundled gate canary uses a deterministic loopback completion fixture. It verifies explicit decline and cancellation without external inference. It does not validate DeepSeek or OpenRouter behavior, billing, cache thresholds, authenticated resume, or provider model catalogs. DeepSeek and OpenRouter definitions and the PKCE backend are implemented with tests. Daemon credential storage wiring and the live authorization and provider canaries remain pending. Keep the package unmerged until those acceptance gates pass.
