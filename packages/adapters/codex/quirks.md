# Codex 0.164.0 notes

Thread sandbox modes use read-only, workspace-write, and danger-full-access. Approval policy uses on-request. Tagged turn sandboxPolicy objects use camel case and must not be substituted for thread sandbox strings.

Command and file approval bodies contain decision. Additional permission replies contain permissions and scope. The successful response envelope contains id and result. The RPC peer validates each body against the generated versioned schema before writing it.

Question answers are keyed by question id and contain arrays of strings. Identical question text is safe because text is never used as an answer key. The current native question schema has no standard multiSelect property. The adapter defaults to single selection and preserves a supplied multiSelect extension; array answer interpretation still needs the live canary. Secret questions are marked for the interaction store's redaction.

The prompt free thread/start capture reports source vscode, even though the process was started through app-server with serviceName zoltbot. An immediate appServer filtered list was empty. This does not prove visibility in any official application. Native indexing explicitly requests the source kinds from the generated schema, and visibility remains unknown.

Per thread config.mcp_servers.zoltbot accepts an HTTP URL, http_headers.Authorization, and required true. Tool discovery was verified while signed out. Actual model tool execution, cross thread token isolation, and resume injection still need live checks. Never write a session token to the default global config.

Unknown notifications are recorded by the supervisor and ignored by the adapter. Malformed known frames produce a protocol error without printing the native payload. Failed sessions ignore late provider completions. Explicit overload responses retry with bounded backoff. Ambiguous timeouts are not replayed; a config/read probe determines whether the peer remains responsive.
