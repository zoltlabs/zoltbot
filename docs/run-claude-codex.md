# Claude Code and Codex

Zoltbot drives Claude Code and Codex through their native CLI protocols. Each chat is a native session with its own conversation ID, so the chats stay visible in the providers' own tools.

## Sign in

You don't need a separate Zoltbot sign-in. Zoltbot leaves provider configuration unset, so each CLI uses its existing login and configuration. It respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and it never copies credentials into its database. If a CLI reports an expired login, run that CLI's sign-in command from the chat's Context panel.

## Try it

Start the app (see the [quick start](../README.md#quick-start)). To keep this trial separate from your normal app data, point the app at a scratch data folder:

```sh
ZOLTBOT_DATA_DIR="$PWD/.cache/try" pnpm dev:desktop
```

1. Create a profile for Claude Code or Codex, then open a chat and click **Connect**.
2. Ask a manager chat to delegate a bounded brief to a child that uses another profile. The child appears in the sidebar. The manager receives the child's result and can read its later results. Children can't create delegates of their own.
3. Questions and approvals appear in the conversation and in the Inbox.

Closing and reopening the app keeps chat history. Reconnecting resumes the same native conversation without resending old messages.

To work on code, create a workspace and choose its code folder. Every conversation in that workspace uses that folder. Without one, each conversation gets a private app working folder.
