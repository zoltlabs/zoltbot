# ACP adapter implementation status

The adapter uses the stable ACP version 1 entry point of `@agentclientprotocol/sdk` 2.0.2. The SDK package version is independent of the negotiated protocol version. Initialization rejects a negotiated version other than 1.

The daemon supplies process policy through AcpHost. The adapter receives byte streams and a close hook. Host MCP injection uses the advertised HTTP capability and keeps the bearer token in the session creation payload. A flavor contains provider specific authentication and extension hooks. Flavor hooks are registered as trusted application code. Declarative flavor files are validated JSON and cannot import code.

Implemented and covered by focused tests: initialization, native session creation, text and thought assembly, tool results and diffs, opaque approval choices, form schema validation, queue fallback for steer, cancellation, stall detection, context and USD cost mapping, model and effort option discovery, and dynamic flavor loading. Interaction identity comes from Zoltbot profile and thread ids supplied at open.

All 22 shared conformance cases now run against a stateful ACP wire fake through the shared daemon supervisor transport. Focused tests also cover form responses, model and effort wire calls, manual compaction after command advertisement, and validation before SDK diagnostics. The shared suite honors capabilities for native questions and token usage; it still exercises those paths against the reference adapter.

Extension interaction integration and cancel then resume tests now pass as well. Remaining dependency work: authenticated session loading and real MCP behavior in S9. No real flavor is enabled by this implementation checkpoint. S9 and WP-12 remain incomplete.

Protocol sources: [official SDK](https://github.com/agentclientprotocol/typescript-sdk), [stable protocol initialization](https://agentclientprotocol.com/protocol/initialization).

WP-14 adds Cursor, Gemini, OpenCode, and Grok definitions and flavor registration. All 88 flavor conformance cases pass against the stateful wire fake, including Cursor questions and plan review. The suite now validates every normalized event against its public schema. Real initialization recordings validate against the pinned official ACP schema. OpenCode HTTP discovery and plan mode control are verified without inference. Authenticated canaries and production enablement remain pending. See quirks.md.

WP-15 adds validated Cline, Goose, Qwen, Kimi, and Copilot definition data with unverified runtime labels. Experimental Antigravity metadata is constructed only after the current warning receipt. Its unregistered flavor deliberately prevents execution. The Settings warning and preference persistence have Electron coverage in both themes.


2026-11-04 production integration: ACP is wired into production provider hosts and the daemon runtime. Cursor and Antigravity use the official ACP routes, with absolute binary selection, native login commands, durable normalized approval choices, host MCP, restart/resume and delegation coverage. Antigravity 1.4.12 and Cursor 2026.10.22-27dcf5f passed authenticated MCP and native resume smoke tests. Cursor instructions are now injected once and never replayed on resume. Earlier checkpoint notes above describe historical status. See docs/run-cursor-antigravity.md for setup, supported scope and canary instructions.

D130 moved Antigravity out of the experimental preference. Its definition ships in `definitions/antigravity.json` with the other ACP definitions, and the Settings warning is removed.


2026-11-04 provider scope: OpenCode 1.19.4 and Copilot 1.0.105 passed live authenticated MCP and native restart/resume checks. Antigravity (agy) is the Gemini path; standalone Gemini CLI is removed from built-in definitions/flavors and canaries by user direction. Earlier Gemini checkpoint notes are historical. See docs/run-opencode-copilot.md.
