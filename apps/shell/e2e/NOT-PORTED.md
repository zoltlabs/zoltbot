# Tests not ported to the shell

These tests from `tests/shipping` and `tests/compare` still run against `packages/ui` with `pnpm test:shipping:ui` and `pnpm test:compare:ui`. Each line names the shell feature the test needs. On 2026-11-19, 5 of those 16 tests already failed against `packages/ui`: shipping "publish → durable approval…" and chat-actions, and compare "independent native columns…", "votes, follow-up…" and "differences…".

## Shipping (`tests/shipping`)

- `shipping.spec.ts` "publish → durable approval → PR → selected feedback → original task revision": no Tasks view, Shipping panel, Needs you approvals or Settings theme switch.
- `shipping.spec.ts` "link, stale refresh, accepted-task feedback and guarded merge UI": no Shipping panel for linking, refreshing or merging a pull request.
- `wakes.spec.ts` "Wake when: save, edit, cancel, fallback, and accessible responsive review": no Wake when dialog or waiting-wakes region in the chat.
- `event-routines.spec.ts` "event draft → dry run → saved paused → enabled → paused": the Routines page (`shipping/routines.spec.ts`) lists, pauses and resumes event routines, but has no event draft or dry run.
- `chat-actions.spec.ts` (partly ported to `shipping/chat-actions.spec.ts` and `shipping/sidebar-organize.spec.ts`): no hover Pin button on rows, no Quick Chat history.
- `company.spec.ts` (partly ported to `shipping/company.spec.ts`): no forms to edit responsibilities, create initiatives, propose organization changes or save project reports; no light theme.

## Compare (`tests/compare`)

The shell has no compare mode: no "+ Compare" option, compare columns, tabs or stacked layout, votes, follow-up to all, continue, merge, critique or differences. `compare/compare.spec.ts` covers the single-chat parts (answering a native question, stopping a run).

- "independent native columns, responsive layouts and both-theme accessibility": no compare columns; the shell is dark only.
- "four columns require 1440 pixels and stop all reaches every session": no compare columns or Stop all.
- "a native question appears in its column and Inbox and can be answered" (ported without the column and Inbox): no Needs you inbox.
- "votes, follow-up, continue and the resolved marker preserve the read-only ceiling": no votes, follow-up, continue or permission ceiling dialog.
- "merge opens a bounded editable draft and sends nothing automatically": no merge draft.
- "critique drafts require one explicit send and keep the compare open": no critique.
- "critique retry after a partial failure does not duplicate a confirmed send": no critique.
- "a lost resolution acknowledgement preserves the unsent merge draft": no merge draft.
- "differences sends the reviewed prompt once and remembers hidden strips": no differences view.
- "cancelled mode widening retains the effective selection and can be reviewed again": no compare mode selection.
