# OpenCode and GitHub Copilot

Both providers run on the supervised ACP runtime with native session storage. Select the provider in a profile and its installed executable in **Doctor**, then connect a chat. The Context panel shows the native sign-in command: `opencode auth login` or `copilot login`. Credentials stay with the native tool. OpenCode 1.19.4 and Copilot 1.0.105 are tested.

## Authenticated smoke test

```sh
TSX_DISABLE_CACHE=1 node --import tsx tools/canary/src/index.ts opencode --authenticated
TSX_DISABLE_CACHE=1 node --import tsx tools/canary/src/index.ts copilot --authenticated
```

To test a specific executable, put its path before `--authenticated`. Each run works like the [Cursor and Antigravity test](run-cursor-antigravity.md#authenticated-smoke-test): one scoped MCP ping, then a native resume that recalls the first reply. It uses a disposable folder and deletes its temporary files.

## Gemini

Antigravity is the supported Gemini path. See [Cursor and Antigravity](run-cursor-antigravity.md). The standalone Gemini CLI is not in the built-in catalog.

Sources: [OpenCode ACP](https://opencode.ai/docs/acp/), [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
