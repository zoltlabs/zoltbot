# Changelog

User-facing changes in Zoltbot. This file is the source of truth for release notes.
The website publishes released entries only; Unreleased stays in this repository.

## Unreleased

- New: Write in your project's Markdown files on the Documents page, with formatting, preview, find and automatic saving. Each project has a Documents row in the sidebar.
- New: Select a passage to leave a comment, then send your comments to any agent in the project. The agent edits the file in place as a task.
- New: An agent's document changes wait in Tasks › Needs you, and the Documents row counts them. On iPhone, choose the task to see the changes word by word, then accept them or send them back.
- New: Review an agent's changes word by word and accept or reject each one, or review everything since the last commit.
- New: Document history keeps earlier versions as you and agents change a file, next to its git commits. Compare any version with the current text or restore it.
- New: Commit changed documents, optionally on a new branch, push them, and open a pull request on GitHub.
- New: Choose earlier versions of an artifact, compare a Markdown artifact with its previous version, and save it to the project as a document.
- Fix: The open artifact card's file badge has enough contrast in the light theme.

- Prepare native Cloud connections and settings for API keys, Mac execution and sandbox usage; packaged integration is still pending.

- Show cloud task audit records, including refused Mac commands, in their project.

- Fix: Cloud tasks can connect to their account service on the hosted Worker runtime.

- Improvement: Cloud tasks can create a review commit from a confirmed file preview.

- Improvement: Cloud task acceptance keeps the reviewed commit fixed through branch publication and PR creation.

- Improvement: Cloud task diffs stay scoped to their task and current revision.

- Improvement: Allow listed commands can reuse a signed approval within one active cloud task.
- Fix: Mac command rules require fresh approval when a prefix only selects options.

## v0.1.10: Mac app opens again

November 21, 2026

- Fix: Zoltbot 0.1.9 opened to a black window on Mac. To get the fix from 0.1.9, quit Zoltbot and open it again, or download it from zoltbot.ai.
- Improvement: On iPhone, SVG attachments show in the chat, and PDFs up to 25 MB and videos up to 50 MB open in the system viewer.

## v0.1.9: More ways to work with your agents

November 21, 2026

- New: Pin, hide or reply to a message, ask about a selected passage, and branch a chat from any message or edit it.
- New: Ask a side question without interrupting the agent, send a queued message now or reorder the queue, and stop an agent by sending a stop phrase such as "stop".
- New: Agents react to messages and show a one-line status and short progress notes while they work.
- New: When a reply ends with a promise such as "I'll check the tests", the agent continues by itself. Turn this off for each agent.
- New: Messages written while the Mac can't be reached wait in an outbox and send when it reconnects.
- New: Preview files in a chat, browse them in a gallery and attach files up to 100 MB. A long paste becomes an attachment.
- New: Links show previews, which you can turn off. Choose whether Enter or ⌘ Enter sends.
- New: Go back and forward between chats, jump to a day in a long chat, and open any page from the command palette.
- New: The sidebar can sort and filter chats and marks unread ones.
- New: Plans show as a checklist. A meter shows how full the context is, with a button to compact it.
- New: The Memory page lists what agents remember. Search finds more, facts carry dates, and saying "forget that" asks you to confirm.
- New: A nightly tidy-up merges duplicate memories, and you can import memories from a ChatGPT, Claude or Gemini export.
- New: Add skills from GitHub. Agents propose new skills and show updates as a diff. Teach a task by doing it in the agent's browser.
- New: Each project has a shared database on the Data page, with CSV export.
- New: The Usage page shows spend and tokens by day, chat and model, and sets a budget for each project.
- New: Publish an artifact as a link or save it to a repository, and open artifacts on iPhone.
- New: The Routines page shows scheduled runs on a calendar, with Run now and one-time runs. Add upcoming runs to Calendar. With a Zoltbot account, routines can also start from a web address.
- New: Workflows chain agent, condition, wait and approval steps on a canvas, with a total budget. Run them and answer their approvals from iPhone.
- New: The `zolt` command asks agents questions, starts tasks and follows their progress from a terminal. Install it from the account menu.
- Improvement: The Mac stays awake while agents work and before a routine runs.
- New: After setup, Zoltbot suggests starter jobs for the apps you connected, such as a weekly inbox summary.
- New: Each agent has its own browser profile. Watch its browser live, take over, or let it ask you for help. It dismisses cookie banners and waits for you before it pays.
- New: The vault keeps logins and two-step codes in the Keychain. Agents sign in with them after you allow it. Import from a password manager, and save a pasted key to the vault instead of the chat.
- New: Talk to agents from Slack, Telegram and Discord, and send from WhatsApp. New senders need your approval.
- New: Find tools in the MCP registry, sign in to more apps, and let a GitHub bot work on your repositories.
- New: Have replies read aloud, call an agent, or hold a key to dictate. Calls and read aloud also work on iPhone.
- New: Agent templates, a talking style for each agent, muting an agent, and a co-author line on the agent's commits.
- New: Fast mode, Gemini CLI and Mistral Vibe, free backup models, starred models, and cost caps for routines. Change the model after a reply.
- New: Appearance settings for theme, text size, font and chat background. Sounds, an agent dock with a mini chat, and a keyboard shortcuts page.
- New: Updates download in the app and restart with their notes. Start fresh or move Zoltbot to another computer from Settings.
- New: Zoltbot is available in Spanish, German, French, Japanese, Brazilian Portuguese and Simplified Chinese. Run the daemon on your own Linux server, with a Docker setup and a pairing link for your phone.
- New: The iPhone app connects to several Macs, locks with Face ID, shows running work as a Live Activity, and works with Siri and Shortcuts.
- New: On iPhone, swipe a message to reply, set the text size, pick an app icon, watch the agent's browser, and change an agent's role and model.
- New: Sign in to app connections from iPhone.
- New: An Android app.

## v0.1.8: Clearer setup

November 19, 2026

- Fix: Remove the redundant, all-capital setup label above the heading on Mac.

## v0.1.7: Team channels, task management and a new desktop

November 19, 2026

- New: The Mac app has a new desktop interface, light and dark themes, voice dictation, and Markdown and chart previews.
- New: Use team channels to post requests and follow work across employees on Mac and iPhone.
- New: The Tasks page groups work that needs you, running tasks and queued tasks. Review results and set how many tasks each employee can run at once.
- New: Managers can request staff changes. Review and approve those requests from the organization or a chat.
- New: Configure backup models in Settings. Chats can switch to a backup when a provider reaches its usage limit.
- Improvement: Manager chats show delegation and result cards, and team channels can load earlier posts.
- Improvement: The iPhone app adds a Tasks page, side menu, Models settings, team channels and staff approval cards.
- Fix: Account actions stay tied to the sign-in that started them. Signing out after a restart clears saved credentials.
- Existing accounts need one fresh Google sign-in after this update.

## v0.1.6: Custom views and clearer chat activity

November 12, 2026

- New: Open the Command Map to see your workspace chats, review requests and send orders from an interactive map.
- New: Install and customize desktop views. Review their permissions in Settings, preview views with sample data and reload your edits.
- Improvement: Desktop chats show completion receipts with supporting results and direct links to review changes.
- Improvement: On iPhone, assistant replies group related activity, tool results open in full and secondary chat controls live in Chat options.
- Improvement: Starting a task on iPhone uses project-first choices and remembers useful defaults.
- Improvement: Request drafts survive navigation, and approvals and browser handoffs explain the next action more clearly.
- Improvement: Organization plans dispatch approved tasks more reliably and preserve limits during handoffs and recovery.
- Improvement: Chat history uses less disk space by sharing message text across its search index and projections.
- Fix: Cloud workers preserve task history and setup state across restarts, and resume interrupted turns when no question or Mac command is pending.
- Fix: Mac command results remain available after reconnecting when the approval has expired.
- Fix: Cloud task observations survive a runner exit between saving task state and sending events. Tasks report unconfirmed answer delivery and require a ready runner before delivering private answers after reconnecting.
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
