# Zoltbot desktop app

The Zoltbot desktop app: Electron main, preload and a SolidJS renderer. The renderer and IPC
design come from [OpenBot](https://github.com/NorbertBodziony/openbot) v0.1.11 (Apache-2.0, see
`LICENSE` and `NOTICE`); the agents run in the Zoltbot daemon (`packages/daemon`).

From the repository root:

- `pnpm dev:desktop` builds the daemon and opens the app with hot reload.
- `pnpm build:shell` builds `out/`; `pnpm package:desktop` packages it with the daemon.
- `pnpm --filter @zoltbot/shell test` runs the unit tests and `test:feel` runs the headless
  feel check against a real daemon.

How the app maps OpenBot's screens onto Zoltbot is in `docs/openbot-shell-plan.md`.
