<p align="center">
  <img src="docs/assets/readme-banner.svg" alt="Zoltbot — Your coding agents. One team." width="100%">
</p>

Zoltbot is a local-first Mac app for running coding agents as a team. Run Claude Code, Codex, Cursor, Antigravity, OpenCode, GitHub Copilot, Grok, Pi or any [ACP](https://agentclientprotocol.com) agent side by side. They can message each other and hand off tasks into isolated git worktrees. When an agent needs you, its question shows up as a card you can answer quickly, on the Mac or from your phone.

Zoltbot drives each agent through its own CLI and keeps conversations in that tool's own session store. It never copies or replays your history, and your existing logins and configuration keep working.

> **Status:** early and macOS only. There are no signed downloads yet, so build from source.

## Quick start

You need macOS 13 or later, Node 24 (see `.nvmrc`), pnpm 11, and at least one supported agent CLI that is installed and signed in.

```sh
pnpm install
pnpm dev:ui        # terminal 1: renderer dev server
pnpm dev:desktop   # terminal 2: builds and opens the app
```

Open **Doctor** in the app to detect your installed agents, then create a profile and start a chat.

Hosted features (accounts, sharing, broker-based integrations, phone relay) are off unless you configure them. Everything else runs locally. See [hosted services](docs/hosted-services.md). You can also [run your own phone relay](services/relay/README.md).

## Docs

- [Development](docs/development.md): checks, tests and the repository layout
- [Architecture](docs/architecture.md): design invariants and glossary
- Provider setup: [Claude Code and Codex](docs/run-claude-codex.md), [Cursor and Antigravity](docs/run-cursor-antigravity.md), [OpenCode and Copilot](docs/run-opencode-copilot.md)
- [Packaging](docs/releasing.md): building a local `.dmg`

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). The Zoltbot name and logo are covered by the [trademark policy](TRADEMARKS.md), not the license. Third-party notices are in [docs/third-party](docs/third-party).
