# Wake when

A chat can wait for one condition and then either return to the Inbox or queue a saved next
step in the same conversation. Open **Wake when…** above the composer. An agent can also
propose a wait with `chat_wake`; its visible card requires the person to review and save it.
Saving a wait does not interrupt an active turn or dismiss an unanswered approval.

Supported conditions:

- A specific provider background job finishes or succeeds, bound to its session and job IDs.
- A task finishes or completes successfully. A task awaiting review is not complete.
- A specific turn in another chat finishes or completes successfully. This does not imply
  that the whole chat's task is complete.
- A GitHub PR merges, bound to its repository identity, PR number and signed-in account.
- A GitHub Actions run attempt finishes or succeeds, bound to the exact run and attempt.
- A phrase resurfaces in a new human message in another chat in the same workspace.
  Phrase matching ignores case and Unicode compatibility differences. Agent and system
  messages do not qualify. Topic waits only return the chat to the Inbox.

## Fallback and execution

Every wait has a future fallback time, shown in the device's local timezone. At that time,
if no matching result has been recorded, the chat returns to the Inbox with a note explaining
that the condition has not been confirmed. It does not start the saved next step. The note
includes the last check and monitoring issue, if any.

Automatic continuation uses the durable input queue and the chat's existing permissions.
A running turn, pending approval or unresolved queued input defers delivery. Permission-boundary
changes while waiting return the chat for review. A trigger does not authorize a merge,
deployment, publication, or wider access. Delivery whose outcome is uncertain is never retried
automatically. Review the queued message and native session before taking further action.

Cancel wait removes the condition without starting work. Resume now (or Bring back now for
an Inbox-only wait) explicitly releases it. Edit changes the condition and records a new
revision. Archiving a target chat cancels its outstanding wait on the next reconciliation.
Self-dependencies and dependency cycles are rejected; a chat may wait on its own background job.

## Where monitoring runs

The local daemon checks about every 15 seconds, with no agent or model call while waiting.
It must be running on an awake Mac. There is no cloud monitoring or hardware wake guarantee.
After sleep or restart it reconciles persisted records and exact GitHub source state, rather
than scanning only a recent event window. Fallbacks are processed when the daemon returns.
GitHub uses the existing `gh` sign-in and read-only API transport. Account or repository identity
changes hold monitoring for review. Remote checks have a request timeout.

Waiting chats have a collapsible Waiting section in All chats and remain available through
search and the Later mailbox. Questions and approvals still take precedence. A wake adds a
transcript note and an unread Inbox marker, with an evidence link where available. Paired
phones display the same condition, fallback, monitoring state, and cancel/resume controls.
On the phone, **Wake when…** opens a full-screen editor for all six conditions. Proposed
waits can be reviewed and saved there; saved waits can be edited with revision checks.
Quick fallback buttons set a time one or 24 hours ahead, with a custom local time available.
GitHub checks still use the paired Mac’s sign-in.

## Verification

The core tests cover single queue admission, fallback, busy/approval deferral, success versus
terminal results, topic provenance and scope, cycles, stale revisions, permission changes,
and archive cancellation. Daemon tests cover restart reconciliation, projection rebuilds,
idempotent API retries and GitHub identity binding. The headless shipping test exercises the
editor and saved card through the daemon API, keyboard modal behavior, automated accessibility,
light/dark themes and narrow viewports. Native app tests require a separately authorized run.
