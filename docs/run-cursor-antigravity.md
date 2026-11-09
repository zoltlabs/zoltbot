# Cursor and Antigravity

Zoltbot runs both providers through their official [ACP](https://agentclientprotocol.com) stdio interfaces. The daemon supervises the processes, so closing a chat view does not stop a turn. Conversations stay native provider sessions and resume through `session/load` without replaying history.

## Setup

1. Install the provider CLI with its official installer and sign in with its native login.
2. Open **Doctor** and scan for coding tools. Cursor needs an ACP-capable version; `2026.10.22-27dcf5f` is tested. For Antigravity, `agy` 1.4.12 is tested. Zoltbot launches it as `agy acp --process-per-session`, which session-supplied HTTP MCP servers need.
3. Select the provider when you create a profile. Choose a project folder, or let the chat use a private app workspace. Then connect the chat.
4. The Context panel shows a sign-in command for the selected executable. Cursor uses `login`. Antigravity signs in through interactive `agy`.

If several CLI versions are installed, choose one with the installation selector. Zoltbot preserves the native `HOME` and configuration roots, and never copies native credentials into its database.

## Behavior

- Replies, tools, diffs, approvals and forms use the normal chat and **Needs you** surfaces.
- Cursor questions and plan review use Cursor's documented extension methods. Antigravity forms use ACP elicitation.
- Antigravity 1.4.12 does not advertise modes. Its default is workspace-write with approval requests. Read-only profiles fail closed when the provider has no safe mode to offer. Native modes are not OS-level isolation.
- Approvals return the provider's exact option ID. An indefinite native grant is never shown as a session-only grant.
- Messages you send during a running turn wait in a queue until it finishes.
- Models and effort levels come from the provider.
- Instructions are injected once per new session, never resent on resume.

## Authenticated smoke test

```sh
TSX_DISABLE_CACHE=1 node --import tsx tools/canary/src/index.ts cursor --authenticated
TSX_DISABLE_CACHE=1 node --import tsx tools/canary/src/index.ts antigravity --authenticated
```

To test a specific executable, put its path between the provider name and `--authenticated`. Each run uses your existing native login and makes two short model turns in a disposable folder: one scoped MCP ping, then a resume that recalls the first reply. It cancels any unexpected permission request, prints only the provider, its version and pass/fail results, and deletes its temporary files.

Sources: [Cursor ACP](https://cursor.com/docs/cli/acp), [Antigravity ACP](https://antigravity.google/docs/cli/acp/).
