# Changelog

User-facing changes in Zoltbot. This file is the source of truth for release notes.
The website publishes released entries only; Unreleased stays in this repository.

## Unreleased

- Fix: Cloud workers resume interrupted turns after restarting when no question or Mac command is pending.

- Fix: Mac command results remain available after reconnecting when the approval has expired.

- Improvement: Cloud sandbox workers preserve task history and setup state across restarts.

- Fix: Cloud task observations survive a runner exit between saving task state and sending events.

- Fix: Cloud tasks report unconfirmed answer delivery.
- Fix: Private cloud answers require a ready task runner after reconnecting.

- Improvement: Chat history uses less disk space by sharing message text across its search index and projections.
- Fix: A full database reports a clear error and rolls back the command.

## v0.1.5: Organization plans, chat wakes and results

November 10, 2026

- New: Propose organization plans, assign initiative owners and delegate tasks within approved limits. Review responsibilities, blockers and project reports from the workspace.
- New: Wake a chat when another chat turn finishes, a GitHub Actions run completes or a pull request merges. Manage waits on Mac and iPhone while your Mac is awake.
- New: Find recent chat results and compare saved artifact versions side by side.
- New: On iPhone, review chat results and artifact versions, preview files and manage chat wake-ups through your paired Mac.
- Improvement: Import a repository without importing sessions, and select multiple sessions for bulk actions.
- Improvement: Chats show when a provider is waiting, and onboarding recognizes newer installed provider versions.
- Improvement: Narrow windows use a modal sidebar drawer, and review controls accommodate enlarged text.
- Fix: Composer handoffs are consumed once, and recovered wake sources clear their old errors.
- Fix: Delegated tasks retain approved limits and launch budgets, with verified handoffs between agents.

## v0.1.4: Zoltbot is open source

November 8, 2026

- New: Zoltbot is open source under the Apache-2.0 license. The Mac app, daemon, iPhone app, protocol and phone relay are developed at github.com/zoltlabs/zoltbot, and Mac builds are published as GitHub releases.
- New: Zolt can schedule its own wake-ups, at a set time or after a chat's next turn, to check back on your work.
- New: Zolt's notices reach you in the Inbox, the chat, desktop notifications and the iPhone's Home. Choose whether Zolt can notify your phone in Settings.
- Improvement: The iPhone app uses the desktop's Graphite and Parchment themes and the Geist typeface, with neutral primary buttons.


## v0.1.3: Zolt, better chats and durable drafts

November 7, 2026

- New: Zolt is your main agent above every workspace, with a live overview of chats and notes. Starting, messaging or stopping other chats requires your approval.
- New: Edit an earlier message into a new chat, optionally restoring files to that point. The original conversation stays intact.
- New: Review changes in wide unified or side-by-side diffs, including all files changed in a turn and scoped task changes.
- New: Composer drafts survive navigation and reload, with attachment recovery, retry controls, Markdown formatting and preview.
- Improvement: Claude Code supports steering a running turn, changing model and effort, thinking summaries and rate-limit status.
- Improvement: The chat terminal is owned by the server, so it can reconnect across view changes.
- Improvement: Workspaces open on their chats, with repository instructions and discovered design files. Choose a default profile for new chats.
- Improvement: Finished activity folds into readable summaries, failed steps can show Fixed on retry, and approvals explain how easily actions can be undone.
- Improvement: Sidebar chat status, keyboard shortcuts and clearer settings make it easier to move between work and find what needs attention.
- Improvement: Guided connections and stable, read-only Google APIs simplify service setup; Quick Chat discovers signed-in tools consistently.
- Fix: Upgrading from 0.1.2 preserves event routines and applies the search-index upgrade correctly.
- Fix: Packaged chat terminals can start reliably with the required helper permissions.
- Fix: Provider processes and their MCP helpers stop when the daemon exits.
- Fix: Workspace design-file edits and clearing saved instructions now save correctly.

## v0.1.2: Connected chats and a clearer workspace

November 6, 2026

- New: On iPhone, use Quick Chat, answer approvals, questions and forms, and manage sessions through your paired Mac, with richer chat transcripts and artifact access.
- New: Quick Chat uses your signed-in Claude Code, Codex or Antigravity, with connected services, workspace context, tool approvals and shared sidebar history.
- New: Fork conversations into independent side chats, or continue them in another coding tool with copied context.
- New: Chats in the same workspace can message each other, with sender links and workspace boundaries.
- New: Prepare event routines, preview them and save paused. GitHub CI and review-request polling can start read-only investigations with retry controls and event history. Live Sentry delivery requires setup.
- New: Agents can inspect and control native macOS app windows through an installed Cua Driver, with human approval and automatic session cleanup.
- New: Open an interactive terminal beside a chat, starting in the chat’s working folder.
- New: Run sequential project phases with separate models, progress, review repair and optional model defaults.
- New: Publish artifact snapshots, copy their links or switch them back to private from the desktop artifact panel.
- New: Google sign-in on zoltbot.ai provides a personal account with session controls, data export and account deletion. Local desktop work stays local.
- Improvement: Graphite dark mode and Parchment light mode bring bundled Geist fonts, consistent spacing and quieter controls. Agents show their coding tool’s logo in their own color.
- Improvement: Chat activity is grouped into expandable steps, message details appear on demand and to-do lists start collapsed.
- Improvement: Mac window buttons sit in the app header, and the centered app icon fits the Dock more naturally.
- Improvement: After handing Quick Chat off to a workspace, Open workspace chat jumps directly to the new conversation.
- New: The website’s Blog gathers guides, comparisons and answers, with tool logos and improved navigation menus.
- Fix: Longer workspace paths no longer exhaust the startup context budget with redundant artifact paths and tool hints.
- Fix: Model and voice settings dropdowns align consistently, and production account deletion reaches the account service correctly.

## v0.1.1: A faster start and Quick Chat

November 6, 2026

- New: **Quick Chat** for conversations outside a workspace, with streaming replies, your own model connections, optional project context and handoff to a task.
- New: **New onboarding** finds installed agents and signed-in plans, lets you choose which recent sessions to import, and gets you to your first chat.
- New: **Personal knowledge** follows you across projects. Review what agents learned and revert knowledge changes from the inspector.
- Fix: Session discovery stays read only and imports sessions only when you choose to find them.

## v0.1.0: The first Mac preview

November 3, 2026

- New: **A universal Mac app** for Apple silicon and Intel.
- New: Run coding agents together in projects, with shared context and task review.
