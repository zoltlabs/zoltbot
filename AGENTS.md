# Repository instructions

## Default native computer use

- Prefer Cua Driver (`cua-driver` MCP server and its installed skill) for native macOS app inspection and interaction. Use `~/.local/bin/cua-driver` when the MCP tools are unavailable in the current session.
- Prefer service APIs and connected tools when they directly support the task. Keep browser tests headless with Playwright.
- Read the Cua Driver skill before use. Discover targets from fresh state, use current snapshot tokens, and verify action results with a fresh accessibility read and screenshots when needed; an action acknowledgment alone is not proof of success.
- Start with background delivery. The successful local smoke trial does not guarantee that Electron input preserves focus. Follow the desktop authorization rules below, including for foreground fallbacks and app launches.
- Do not bypass Cua permission refusals. Launch trial apps through Cua when lifecycle control is needed, and use separate synthetic app data for tests.


## Keep testing off the user's desktop

- Run browser tests headlessly by default. Collect screenshots, traces, logs, and other artifacts for verification without opening foreground windows.
- Run Electron and other native UI tests in CI or an isolated environment with its own display when possible. Do not assume that launching Electron locally is headless or will avoid stealing focus.
- Do not launch visible test windows, bring apps to the foreground, move the user's mouse, send desktop-wide keyboard input, or otherwise take control of the user's desktop without explicit user authorization for that run.
- Prefer non-interactive checks and isolated automation. If a required check cannot run without disrupting the user's desktop, complete the unaffected checks, explain the limitation, and ask before running the disruptive check. Do not silently skip it or claim it passed.
- These instructions apply to all work in this repository, including test scripts, debugging, verification, and delegated agents. Preserve this behavior when adding or changing test tooling.
