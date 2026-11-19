# Desktop shell from OpenBot v0.1.11

## Why

The current desktop UI (`apps/desktop` + `packages/ui`, about 42k lines of React) feels slow and rough. Clicking, chatting and moving between screens all have small delays and jumps. OpenBot v0.1.11 feels right on the same machine. We will start a new desktop shell from its code and connect it to the Zoltbot daemon, instead of trying to match it by hand.

Measured differences in the current UI:

- The renderer waits for the daemon's reply before it changes the screen. Only 2 places update the screen first and confirm later.
- 10k lines of CSS contain 8 transitions and 6 keyframe animations. OpenBot v0.1.11 has 77 and 19 in 4.7k lines.
- React re-renders whole lists on each update. OpenBot's SolidJS renderer only updates the nodes that changed.

## Licence

OpenBot v0.1.11 (tag `v0.1.11`, commit `e9cae2ac7c83936a6e7d22c820e9d7ec0726d880`, 16 Aug 2026) is Apache-2.0. Later versions are PolyForm Noncommercial and must not be copied into this repository, because this repository is public and Apache-2.0.

- Copy only from `v0.1.11`. Do not open or copy code from later OpenBot versions. Watching how the current app behaves is fine.
- Keep OpenBot's copyright notice. Add it to `NOTICE` and `docs/third-party/`, and keep the original headers on copied files.

## Architecture

Invariant I1 stays: the daemon (`zoltd`) is a separate process, and a UI crash never stops an agent. OpenBot runs agents inside the Electron main process. We keep its renderer and IPC design and replace its backend with the daemon.

```
renderer (SolidJS, from OpenBot)
   │ typed IPC bridge (OpenBot's preload + shared/ipc.ts pattern)
Electron main: daemon client + in-memory mirror of the state the renderer shows
   │ existing WebSocket protocol (packages/protocol)
zoltd (unchanged): agents, store, host MCP, phone relay
```

- Electron main keeps one daemon connection, holds the current state and pushes changes to the renderer over IPC. The renderer never talks to the daemon directly.
- The renderer changes the screen as soon as the user acts and reconciles when main confirms. This applies to: send, switch chat or agent, reply to an interaction, queue pause/cancel/reorder, rename, archive, create agent, create project.
- The phone, the cloud and the views keep using the daemon as they do today.

## What we take from v0.1.11

| Keep | Replace with Zoltbot | Drop for now |
| --- | --- | --- |
| `src/renderer` (App, Sidebar, Conversation, ComposerEditor, pickers, PanelResizer, avatars, InitialSetup, `styles.css`) | `src/backend/agent-service`, `claude-client`, `app-server-client`, `bot-store`, `mailbox-store` → daemon RPCs | `update-service` (Zoltbot has its own update path) |
| `src/preload`, `src/shared/ipc.ts` pattern, `main/trusted-ipc`, `main/trusted-renderer` | OpenBot's provider IDs in the renderer → the daemon's capability table (I4) | `backend/browser-host` until we decide on the embedded browser |
| electron-vite build setup (moved to pnpm and Node 24) | OpenBot's full-access agent mode → Zoltbot permission profiles (I10) | Bun scripts |

Concept mapping:

| OpenBot | Zoltbot |
| --- | --- |
| Bot | Profile with its main thread |
| Conversation | Thread and its items |
| Queue | Input queue |
| Prompt | Interaction (I5) |
| Agent-to-agent mailbox | Agent messaging with grants (I6) |

`Conversation.tsx` (2,469 lines) and `styles.css` (4,750 lines) break the 800-line rule (I14). Split them by feature while porting, without changing behaviour or styling.

## Steps

Each step is one or more commits on `main`. The new shell lives in `apps/shell` until it replaces `apps/desktop`.

1. **Baseline import.** Copy `v0.1.11` into `apps/shell` unchanged, with its notice. Build it with pnpm. This commit is the reference that every later diff is measured against.
2. **Daemon backend.** Remove OpenBot's backend. Electron main connects to `zoltd` and implements the same IPC contract with daemon RPCs and events: list profiles, read a thread, send, stream events, queue, interrupt, interactions. Synthetic data only.
   **Feel gate:** compare against v0.1.11 on switching agents, sending, streaming and the composer. Do not start step 3 until these four match.
3. **Zoltbot essentials.** Projects and workspaces in the sidebar, approvals, settings and accounts, notifications, dictation, cloud account, artifacts. Port the logic from `apps/desktop/src`, not its UI.
4. **Agent company.** Sidebar becomes project → CEO → managers → employees. Organization panel, plans and approvals, project briefs, using the existing `company.*` RPCs.
5. **Map view.** The town map from the prototype as a second view over the same state. `packages/views/command-map` is being worked on in parallel; reuse it where it fits.
6. **Switch over.** Point the shipping and comparison Playwright suites at `apps/shell`, then remove `apps/desktop` and the desktop-only parts of `packages/ui`. `apps/mobile` imports `@zoltbot/ui`, so keep the parts it uses.

## Keeping the feel

- Every new screen uses OpenBot's spacing, motion and type tokens. Do not bring over values from `packages/ui`.
- Add a headless check that measures click-to-paint time and layout shift for the step 2 flows, and run it with the other checks.
- When a ported feature feels worse than v0.1.11, fix that before adding the next feature.

## Open questions

- Embedded browser: keep OpenBot's `browser-host` (agents control a browser in the app) or leave it out?
- Window chrome and app name during the transition: run `apps/shell` as a separate dev app until step 6?
