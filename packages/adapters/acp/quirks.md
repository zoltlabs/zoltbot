# ACP flavor verification

The stable protocol remains version 1 on SDK 2.0.2. Declarative flavor files contain data only. Cursor code hooks are bundled trusted modules with separate state for each session.

Cursor 2026.10.22 initializes, while session creation needs authentication. The older PATH version lacks ACP. Native questions use option ids and have no free text answer field. Plans require concrete markdown and an explicit offered acceptance. Todo merges remain within one session; cancelled native todos are removed from the active plan. Task and image notifications preserve their native payload as generic tool output. Official app session visibility is conservatively no. Authenticated HTTP MCP tool execution and native resume passed on 2026-11-04 with the pinned CLI. Instructions are injected only in a new conversation, not periodically or after resume.

OpenCode 1.19.4 initializes and creates a session without a model call. Its per session HTTP MCP route performed authenticated tool discovery. Mode selection uses advertised config options; plan was confirmed by a real control request. Session creation alone does not prove tool execution, provider authentication, cancellation, or resume.

Gemini 0.40.1 initializes with --acp. API key authentication is selected only when its key is explicitly supplied and the native method is advertised. Interactive OAuth is not initiated automatically. Native session and MCP behavior still need a configured canary.

Grok 1.0.70 initializes with auto updates disabled. The isolated runtime advertises only interactive grok.com login, so no authentication was attempted. The flavor uses explicit API key or cached token methods only when advertised, with headless metadata. Approvals remain coarse and steering queued. No billing or question extension is invented.

Read only built in flavors must advertise a configured safe mode before opening. Permission requests for execution, edits, or unknown tools are denied independently. These native controls do not substitute for OS isolation. Coarse or unprompted provider behavior still needs canary evidence and Doctor labeling before production enablement. Native session listing remains WP-21 work.

Antigravity 1.4.12 exposes ACP v1 through `agy acp --process-per-session`. The installed help confirms the worker flag; HTTP MCP and native resume passed authenticated canaries. Cached native credentials are reused; API-key authentication is selected only when explicitly configured and advertised. Interactive login uses bare `agy`, since the installed ACP help does not advertise the documented `--login` flag. It is a standard provider since D130; capabilities outside the verified set stay conservatively labeled. The client identifies as Zoltbot and accepts the models actually offered to that client.


2026-11-04 provider scope: OpenCode 1.19.4 and Copilot 1.0.105 passed live authenticated MCP and native restart/resume checks. Antigravity (agy) is the Gemini path; standalone Gemini CLI is removed from built-in definitions/flavors and canaries by user direction. Earlier Gemini checkpoint notes are historical. See docs/run-opencode-copilot.md.
