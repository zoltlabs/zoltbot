# Mobile project command

## Where initiatives come from

An initiative groups chats pursuing one outcome within a project. It owns a goal and task progress; a worktree remains a code location, and a chat remains a conversation. A chat belongs to at most one initiative in this prototype.

| Source | Benefit | Cost |
| --- | --- | --- |
| Existing project direction (subproject) | Explicit membership already exists on the phone; survives branches and manager turnover | Needs a goal and a clear task denominator; old directions may be too broad |
| Manager chat and delegated task tree | Shows ownership and delegation without manual grouping | Orphan chats and cross-manager work need assignment; task ancestry can change |
| Chat label or branch prefix | Cheap to adopt incrementally | Naming drift; shared worktrees mix unrelated work; no durable goal |

Recommend existing project directions as the initial membership source, with explicit assignment for root-level chats. Derive task completion from tasks, never from the number of finished chats. Confirm that directions represent outcomes before giving them the initiative label. A new entity is justified only if directions cannot represent this relationship.

The phone consumes a client snapshot and sequenced domain events through RelayTransport or FakeTransport. RelayTransport uses the link package for authenticated pairing and encrypted relay traffic. Commands use stable command IDs to retry safely. The desktop view API derives chats, requests, checks and usage from those same entities; it does not supply initiative goals, progress or PR lists directly.

Wiring this screen requires a mobile projection over project/subproject, thread/task ancestry, pending interactions, session activity, usage and shipping snapshots. Use existing command actions and request version checks, preserve stale/offline drafts, and await receipts before advancing. This prototype changes no protocol, daemon, relay, link or view API code.

## Fixture and development entry

Bracken Supply is a fictional equipment rental marketplace. Autumn reliability has six initiatives and 36 agents across Codex, Claude, Gemini and Cursor. Billing is stalled with every agent waiting; search is healthy, the widget is nearly done, and test cleanup is failing. Requests include command approvals, questions and plans, with different waiting times. Checkout and reminder requests refer to their own initiative.

Prototype options also offer a 40-agent sample, a tiny project with two agents, and an empty project. Three simulated events update an activity, introduce a request and finish another agent. Updates can be paused. Orders, messages, stops and answers change local fixture state only.

Open **Projects → Prototype: project command** in a development build. Both the entry and route are guarded by `__DEV__`; the route redirects in release builds. Open **Prototype** in the bottom navigation to change samples, pause updates or close the prototype.

## Selected layout: squad focus

The first implementation compared stacked sections with a two-column board. Visual review rejected both: repeating per-agent text made the overview tall and difficult to scan, and the units had no coherent visual identity.

Eight static directions followed: squad roster, mission tiles, tactical atlas, operations path, squad focus, field ledger, fabrication hangar and dispatch console. The owner selected **05, Squad focus**. That is now the implemented overview; the earlier layout switches have been removed.

One initiative expands into a squad panel with its goal, task progress, numbered agent portraits, state marks and oldest local request. The initial focus is the initiative with the most waiting agents. Tapping another initiative focuses it, and the explicit choice remains stable during live updates. Five compact rows keep the rest of the project visible, including task counts, waiting or check status and small agent state marks.

This direction trades six simultaneous goal sentences for a larger, usable squad panel. A collapsed initiative's goal is in its accessible name and appears visibly when focused; activity, PRs, checks and recent changes are in its detail view. The focused heading's arrow opens those details. Every unit opens an agent sheet.

Units have provider-colored equipment and face details, a unique number and a static state symbol. Provider color is decorative; the unit's accessible name gives its provider, state and activity. Geometry uses SVG paths rather than Unicode glyphs. A visible state key names the five shapes. Later shares idle's bar, as on desktop.

## Requests and orders

The persistent lower command area shows the global request count and oldest waiting time. **Unblock** opens that request from the overview, detail, chat or agent sheet. The expanded squad's request row can also open its own oldest request directly.

ApprovalCard, QuestionCard and PlanCard provide the existing request controls. The fixture adapter adds an explicit native confirmation before session-wide permission or auto-accept edits. Cancel keeps the request and draft; confirm records the answer and advances to the next oldest request. The queue stays open through the last answer and shows an all-clear screen. A live arrival cannot replace the request being drafted.

Initiative detail lists agent roles, provider, state, activity and waiting time. Checkboxes select agents, then a lower orders control opens editable presets and Stop. The Stop alert follows the app's cancel/confirm pattern. The agent sheet offers answer, message, Stop and chat actions. Sample chat displays readable answers and messages; it never opens a real chat ID.

## Accessibility and appearance

The screen uses the mobile theme and existing Geist type roles. No theme tokens were added. Controls are at least 44 points, text wraps without line clamps, agent units wrap at larger text sizes, and the screen adds no animation or haptics.

At accessibility text scales, the header, statistics and navigation join the scroll content. A single lower Unblock control stays reachable. This prevents large fixed chrome from consuming the entire screen. Forms use the existing keyboard-avoidance pattern. Shared request input boundaries use the existing control-border token, which passes 3:1 in both themes.

Measured minimum contrast across page and raised surfaces:

| Token | Dark | Light |
| --- | ---: | ---: |
| Text | 12.87 | 12.66 |
| Secondary text | 7.82 | 6.39 |
| Accent text | 9.85 | 6.69 |
| Needs you | 8.38 | 6.41 |
| Done | 6.57 | 4.92 |
| Warning | 5.42 | 6.01 |
| Control border | 6.58 | 6.26 |

Tests also measure the attention-button foreground against its background. State graphics use these same readable semantic colors. Provider accents are not relied on to convey a state.

## Verification

Run:

```sh
pnpm exec tsc --noEmit -p apps/mobile
pnpm exec biome check apps/mobile
pnpm exec vitest run apps/mobile
pnpm --filter @zoltbot/mobile prototype:screenshots
```

The screenshot command bundles the actual components with a browser host adapter, uses an isolated headless Chrome process and a localhost-only server, and saves images under ignored `output/playwright/squad-focus/`. It does not launch a simulator, a device or a visible browser. Chrome must be installed; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select another installed Chromium binary.

This adapter approximates native flex layout and text scaling. It is useful for visual comparison and exercising component interactions; it does not establish native line breaking, safe-area geometry, keyboard placement or VoiceOver behavior. The script produces overview images in both themes, initiative, orders, chat, agent sheet, request, all-clear, 40-agent, tiny, empty and large-text images.

Checks cover initiative sorting, stable focus, state-to-vector mapping, oldest-first queue advancement, fixture validity, simulation and rendering at a 3.2 text scale. The browser harness checks that all six initiatives fit at 402 × 874 and 390 × 844, sends messages and orders, cancels and confirms broader permissions, drains the request queue, preserves a draft when a request arrives, checks Stop confirmation and verifies that the large-text scroll area remains usable at 320 pixels wide. All screenshot artifacts remain uncommitted.

Before treating this as a product feature, check on a phone:

- One-handed reach to initiative selection, units, orders and Unblock.
- The entire unblock queue, including permission confirmation and a live arrival while drafting.
- Largest Dynamic Type, including text fields with the keyboard visible.
- VoiceOver names, states, selection, modal isolation, focus restoration and answer announcements.
- Six initiatives and 40 agents in both themes, including actual safe areas and ordinary-size fit.

For the squad-focus implementation, mobile typecheck and lint passed, all 129 mobile tests passed across 21 files, and the headless screenshot/flow command passed. Native phone checks above remain outstanding.
