# Claude Code adapter

The adapter drives Claude Code through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), one `query()` per native process with streaming input. The SDK's `spawnClaudeCodeProcess` hands the launch to ClaudeHost, so the daemon still supervises the person's own `claude` binary, redacts its frame log, and supplies a private MCP configuration file that keeps credentials out of argv. The SDK's bundled per-platform binaries are never installed or shipped. Permission prompts arrive through `canUseTool`, MCP forms through `onElicitation`, and control routes (initialize, mcp_status, set_permission_mode, interrupt, stop_task, rewind_files, get_context_usage) through the Query methods. Startup checks the initialize result and mcp_status before exposing session.ready. Later system/init must match the requested native session id.

The stateful synthetic provider tests queueing, interruption, approvals, questions, duplicate question text, plan review, tool results, diffs, usage, crashes, malformed frames, host MCP authentication, permission suggestions, elicitation, manual compaction, background tasks, and file rewind. The shared conformance suite exercises all 22 scenarios. Focused tests cover idle process closure, lazy resume, context summaries, permission ceilings, and exclusive native writers.

After ten idle minutes, the process closes while the logical session keeps its writer reservation, unless a background task is still running. The next send resumes the same native id. Model and effort changes apply to the running process; name changes apply through the next process launch. Steering sends the input with priority "now" into the running turn after moving running subagents to the background, as T3 Code does; the segment it ends does not end the turn. Read only sessions offer only the default and plan modes and never auto accept edits.

Desktop parity: tool events carry titles, locations, and the interactive flag for AskUserQuestion and ExitPlanMode. Edit approvals carry diffs. Native permission suggestions become a session-only `allow_session` choice and a narrow `ruleSuggestion`. Plan review can switch to acceptEdits. `mode.changed` follows ready, setMode, plan answers, session grants, and native reports. Elicitation maps to forms. `compact`, `stopBackground`, and `rewindFiles` use native control routes.

Only startup controls and HTTP MCP discovery have real Claude 2.1.299 evidence. Some parity shapes were read from the 2.1.42 bundle. Turn protocol fixtures remain synthetic until the real canary. This package is not ready to merge. See quirks.md.

Cloud hosts can set `hostMcp.tokenEnv` and its matching environment entry. The MCP
file then contains a header placeholder, while the credential reaches the native
process through its environment. Invalid bindings fail before writing the file.
The existing Local path is unchanged. This uses Claude's documented
[environment expansion in MCP headers](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).
Tests inspect the file, verify the synthetic child receives the variable, and make
an authenticated localhost tool call without credential bytes in any fixture file.
These fake-provider checks do not replace the live sandbox acceptance gate.
