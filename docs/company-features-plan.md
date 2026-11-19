# Company features plan

Five features for the desktop shell (`apps/shell`). They are rebuilt from a behaviour survey of OpenBot releases after v0.1.11. Copy no OpenBot code from after v0.1.11, because it is licensed PolyForm Noncommercial. Most of the backend exists already (see `docs/agent-company-plan.md`). The work is mainly shell UI, plus a few daemon gaps.

## Decisions

- Each team gets a channel automatically, led by its manager. Each project gets a channel led by its CEO.
- Moving work to a different provider asks once per project. After that, the switch is automatic.
- A manager's standing allowance to add employees without asking starts off. The owner turns it on per manager, with a limit.
- An employee runs at most 2 tasks at once by default. This is a setting.

## 1. Tasks page and parallel work

Already in place:
- Each task runs in its own task thread.
- `task.list` and `company.read` return tasks with status, owner, accountable thread, initiative, dependencies and budget.
- The old UI page is in `packages/ui/src/tasks`.

To build:
- **Tasks page.** Opened from a sidebar "Tasks" row, from the organization panel and with ⌘T.
  - Groups: Needs you (review and failed), Running (running and blocked), Queued, Done (collapsed).
  - Filters: team and owner.
  - Each row shows the title, the owner's avatar, name and team, a status pill with its reason (for example "Waits on X" or "Queued: at limit") and the age. Clicking a row opens the task thread.
  - Review rows offer Accept and Send back, using `task.review`.
  - The "Tasks" row in the sidebar shows a count of Needs you items.
- **Sidebar.** An employee row with more than one task in progress shows "N running · M queued" and expands to one sub-row per task.
- **Daemon.** Add a per-employee limit on running tasks (default 2, configurable in settings). The task runner holds extra tasks in the queue with the reason `at_limit`.

## 2. Manager controls

Already in place:
- `team_delegate`, `team_message`, `team_read_thread`.
- `company_work` `assign`, `read`, `cancel` and `recover`.
- Supervisor notices that wake the accountable thread when a task finishes.

To build:
- **Delegation card** in the manager's chat, built from tasks whose source message is in this thread. One row per task, showing the owner, title, live status, time and cost against budget, with Open and Stop. Stop uses `task.cancel` with confirmation.
- **Notice rows.** Messages between agents and supervision notices render as one compact centered line, for example "Mira → Theo: … · no reply needed". They don't render as raw text.
- **Result card** when a task reaches review. It shows the changed files, tests, cost and the manager's note, with Accept, Send back and Open chat.
- **Wait notice** while a manager waits on its tasks, with a "Wake now" action.
- **New agent tool `team_requests`.** Lists the messages and assignments this thread sent and whether each is still open, answered or done.
- **New agent tool `team_wait`.** The thread waits until named tasks it delegated (or its reports' turns) finish, then wakes. Waits on its own delegated work need no wake card. Any other condition still goes through `chat_wake` and the owner.

## 3. Agents that manage agents

Already in place:
- Creating agents through `workspace_create` and `team_delegate` with a new chat, behind approvals.
- Changing profile fields behind a `profile_change` approval.
- Archiving only through a reviewed reorg plan.

To build:
- **One approval card** for adding, changing and archiving an employee, with a before-and-after view. It renders inline in the manager's chat and is answered with `interaction.answer`.
  - Add: name, role, model and backup order, folders it can edit, who it reports to, first task.
  - Change: a diff of model and instructions.
  - Archive: where its queued tasks go. Running work finishes first.
- **Archive one employee** without a full reorg plan, through a new agent action and RPC. Queued tasks move to a named teammate, or back to the manager. History stays readable.
- **Standing allowance.** Per manager: add up to N employees within listed models and folders without asking. It is stored with the existing approved-authority records. The approval card offers a checkbox to grant it.
- **Organization panel.** Edit and Archive for each person, so the owner can make the same changes directly.

## 4. Team channels

Already in place:
- Messages between threads with a sender, recipients and reply links (`messageTeam`, `message.send`, `message.list`).
- Teams with managers.

To build:
- **Channel record.** Fields: id, project, team (optional), lead thread, member threads, name, created and archived dates. It is created automatically for every team and project, and members are kept in sync with the team.
- **Transcript.** The owner's posts, plus every agent message whose `channelId` is set, plus that channel's task events. Agents keep working in their own threads, and a channel is where they post and read.
- **Routing.**
  - An owner post goes to the lead unless it @mentions members.
  - An agent posts with `team_message` and a `channelId`. Recipients are its @mentions, or the lead if there are none.
  - Delivery stays on the single messaging path (architecture I6), and the message is also written to the channel transcript.
- **Requests.**
  - Each owner post starts a request owned by the lead. Tasks the lead assigns while handling it carry the request id.
  - States: open, running, done, stopped, archived.
  - Actions: Stop (cancels its tasks), Resume, Reassign (to another member as lead), Archive and Restore.
- **Waiting for replies.** Questions posted in the channel that have no reply yet, showing who owes the answer.
- **Shell.**
  - Channel rows (`#name`) under the project in the sidebar.
  - The channel view has a request bar, speaker names on bubbles, a Lead badge, the waiting block, and @mention autocomplete in the composer.
  - The right panel lists members and requests.

## 5. Backup models and accounts

Already in place:
- Claude `rateLimitStatus` reports `rate_limited` with `resetsAt`, stored as the session's runtime status.
- Quick-chat fallback with a one-time acknowledgement.
- Each agent definition has its own launch env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- Copied forks.

To build:
- **Accounts.** An account record per provider sign-in: label, provider, config folder. Settings → Models lists accounts with their limit state and has Add account, which runs the provider's sign-in in a new config folder.
- **Backup order.** An ordered list of model and account pairs for each role (CEO, managers, employees). An agent can override it.
- **Switching.**
  - On a usage limit, the next turn continues on the next entry.
  - On the same provider, the agent keeps the native session when the provider supports it; otherwise it continues from a copied fork.
  - When the first entry's reset time passes, the agent switches back.
  - A notice line in the chat records each switch.
- **Codex.** Detect usage-limit errors, not only "overloaded".
- **Another provider.** Before moving to a different provider for the first time in a project, ask once: "Continue on Codex?", with "Don't ask again for this project".

## Checks

Each feature lands as its own commits. Each needs:
- daemon and core tests for the new behaviour
- shell unit tests
- headless flows in `apps/shell/e2e`
- axe in both themes
- the feel check
- the repository checks in `AGENTS.md`
