# Mobile project command

## Where initiatives come from

An initiative groups chats pursuing one outcome within a project. It owns a goal and task progress; a worktree remains a code location, and a chat remains a conversation. A chat belongs to at most one initiative in this prototype.

| Source | Benefit | Cost |
| --- | --- | --- |
| Existing project direction (subproject) | Explicit membership already exists on the phone; survives branches and manager turnover | Needs a goal and a clear task denominator; old directions may be too broad |
| Manager chat and delegated task tree | Shows ownership and delegation without manual grouping | Orphan chats and cross-manager work need assignment; task ancestry can change |
| Chat label or branch prefix | Cheap to adopt incrementally | Naming drift; shared worktrees mix unrelated work; no durable goal |

Recommend existing project directions as the initial membership source, with explicit assignment for root-level chats. Derive task completion from tasks, never from the number of finished chats. Confirm that directions represent outcomes before giving them the initiative label. A new entity is justified only if directions cannot represent this relationship.

The phone currently consumes a client snapshot and sequenced domain events through RelayTransport or FakeTransport. RelayTransport uses the link package for authenticated pairing and encrypted relay traffic. Commands use stable command IDs to retry safely. The desktop view API derives chats, requests, checks and usage from those same entities; it does not supply initiative goals, progress or PR lists directly. Wiring this screen requires a mobile projection over project/subproject, thread/task ancestry, pending interactions, session activity, usage and shipping snapshots. Use existing command actions and request version checks, preserve stale/offline drafts, and await receipts before advancing. No transport or protocol changes belong in this prototype.

## Fixture

Bracken Supply is a fictional equipment rental marketplace. Its Autumn reliability project has six initiatives and 36 agents across Codex, Claude, Gemini and Cursor. Billing is stalled with every agent waiting; search is healthy, the widget is nearly done, and test cleanup is failing. Small and empty project variants exercise sparse states. All commands and answers change local sample state only.

## Layout experiment

Build both stacked sections and a two-column board, selectable in the development prototype. Start with the compact board: six initiatives occupy three rows, leaving room for the bottom unblock control. Stacked sections give long goals more width but require six vertical sections; their agent strips make the overview too tall at ordinary phone sizes. The board keeps the project structure visible sooner. At larger font scales it becomes one column and scrolls: readable text takes precedence over a no-scroll claim. Phone validation remains necessary before claiming that all six fit on a normal phone.

Both layouts show goals, task progress, state marks and waiting counts. A persistent bottom button opens the oldest project request from overview, detail, chat or agent sheet. Detail has selection and editable orders. The sheet has explicit close and chat controls; no action requires a gesture. Prototype chat content is local, never a route to a real chat.

## Interaction and accessibility

Reuse ApprovalCard, QuestionCard and PlanCard with a local submit adapter. Session-wide approval and auto-accept edits require an explicit confirmation before sample state changes. No haptics or animation are added. Live simulation has a visible pause control and advances local state only; answering pins the current request so an arriving older request cannot replace a draft.

Marks carry hexagon, diamond, flag, bar and warning triangle shapes plus words. Later shares idle's bar, as on desktop. Provider color is decorative; the provider name and unique unit number carry identity. Text uses existing theme tokens and grows without line clamps or fixed-height text boxes. Larger type uses a single column. All interactive targets are at least 44 points. Native sheet presentation supplies modal isolation; VoiceOver focus and restoration need device verification.

## Verification

Results and measured contrast pairs are recorded below after implementation. Native layout, VoiceOver, one-handed reach and the complete unblock flow require a phone. The repository has no React Native headless screen snapshot harness; desktop browser screenshots cannot establish native layout correctness.

The full sample contains 36 agents; the 40-agent sample adds four checkout workers for the density check. The developer entry is **Projects → Prototype: project command**, available only under `__DEV__`. The route redirects in release builds. Use “Close prototype” to leave. No real chat IDs or commands reach the transport.

The render test bundles actual components with native host shims and renders them through React's server renderer. It checks content and adaptive props at a 3.2 font scale, and both overview layouts. It does not measure native glyph wrapping, clipping, modal focus or touch geometry. No screenshot images were produced.

Measured minimum contrast across the page and raised surfaces:

| Token | Dark | Light |
| --- | ---: | ---: |
| Text | 12.87 | 12.66 |
| Secondary text | 7.82 | 6.39 |
| Accent text | 9.85 | 6.69 |
| Needs you | 8.38 | 6.41 |
| Done | 6.57 | 4.92 |
| Warning | 5.42 | 6.01 |
| Control border | 6.58 | 6.26 |

Provider strips remain decorative; accessible provider names and unique unit numbers identify agents. No color tokens were added. The test asserts 4.5:1 for semantic text and 3:1 for control boundaries in both themes.

Before treating this as a product design, check on a phone:

- One-handed reach to initiative selection, agent actions and the persistent unblock button.
- Answer the full queue, cancel and confirm a session-wide approval, send plan feedback, and receive a simulated request while drafting.
- Dynamic Type at the largest setting, including keyboard-visible message and order fields. The overview intentionally scrolls when text grows.
- VoiceOver section names, unit identities and states, selection, modal focus isolation and restoration, and announcement of answers.
- Six initiatives with 40 agents in both themes. Verify ordinary-size fit and readability; the no-scroll goal has not been established by the host-shim test.

Progress fill against the composited sunken track measures 10.44:1 dark and 6.81:1 light. Primary button text measures 12.68:1 dark and 6.08:1 light. Stop uses the app's native cancel/confirm alert pattern. Session-wide choices use a separate confirmation with the permission scope stated plainly.

Checks: `pnpm exec tsc --noEmit -p apps/mobile`, `pnpm exec biome check apps/mobile`, and `pnpm exec vitest run apps/mobile`. The mobile package defines no separate check scripts; these target the mobile portions of the root checks. The final suite has 126 passing tests across 21 files, including eight prototype tests. No desktop or native UI tests were launched.
