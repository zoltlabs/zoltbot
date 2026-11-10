# Agent company implementation plan

## Product contract

Give Zolt an outcome. It proposes ownership and a work plan, coordinates within approved authority, and returns evidence and decisions. Users can inspect and edit the organization at any time. Direct chats and small fixes remain first-class: neither a manager nor an initiative is required. A profile controls execution; an assignment describes responsibility. Teams persist while initiatives have independent lifecycles.

## Delivery sequence

1. **Organization contracts and rules.** Independent initiative records; manager remits; planned task graphs, ownership history and dependencies. Validate same-workspace references, cycles, parent completion and accepted versus executed progress. Preserve existing records and direct task/chat behavior.
2. **Unified delegation.** Agent assignments create or reference tasks and their worker chats, with optional initiative/manager/parent. Reuse task execution and result review. Keep questions and informational messages separate from assignments. Expose organizational tools to Zolt without exposing unrelated runtime tools.
3. **Approved coordination.** Versioned plans contain concrete organizational changes, tasks and bounded execution authority. Human approval binds the exact version and affected state. Ordinary dispatch within the approved plan needs no repeated approval. Changes in scope, permissions or budget need another review. Persist supervision checkpoints and deduplicate event handling across restarts.
4. **Inspectable organization and work.** Connected organization and initiative views expose ownership, remits, task graph, blockers, history and accepted progress. Provide human editing and approval controls; retain task triage and direct chat entry points. Reuse shared controls and tokens, keyboard paths and responsive layouts.
5. **Management reports.** Durable dated project briefs, linked evidence, open decisions and next commitments; cross-project priority reporting. Reuse existing proactive/brief infrastructure, distinguish turn completion from accepted work and avoid repetitive empty reports.
6. **Reviewed reorganization.** Concrete before/after changes for teams, initiatives, remits and assignments. Validate affected versions, ownership, access and running work; apply as one store transaction. Running execution retains its context; defer its handoff until a safe boundary. Preserve history, compensate rather than erase, exclude cross-workspace moves.

Each step goes through protocol, core, daemon/tools and UI as applicable and is committed separately. Implementation findings may adjust boundaries without weakening the contract.

## Verification

Domain tests cover authorization, independent initiative lifecycle, direct assignments without managers, task graph cycles and rollups, incomplete children, immutable approvals, stale state, duplicate dispatch, recovery and safe reorg handoffs. Daemon tests exercise real RPC/tool wiring with synthetic providers. Headless browser journeys cover setup, prescribed organizations, direct bug fixes, idea routing, reporting, reprioritization and reorganization. Native verification uses separate synthetic app data and Cua Driver; the owner authorized visible Electron testing for this implementation run. Do not use production workspaces or paid model runs implicitly.

Run repository typecheck, lint, unit tests, UI/desktop builds, shipping and comparison checks before completion. Record live model coverage separately from deterministic orchestration coverage. CEO provider/model remains configurable; orchestration correctness must not depend on one named model.

## First complete milestone

Outcome → approved organization/work plan → linked delegated execution → manager/Zolt updates → project brief → accepted result. The same records then support priority changes and reviewed reorganization.

## Implemented surfaces

- Independent `initiativeRecord`, `managerRemit`, immutable `companyPlan` and append-only `projectBrief` records, with migration 003 preserving legacy team/initiative aliases.
- `company.read`, `company.propose`, `company.decide`, `company.assign`, `company.review` and `company.brief` RPCs. The `company_work` agent facade describes its contracts and exposes scoped reads, proposals, delegation, explicitly authorized task review and reporting. It also routes existing workspace creation/editing approvals.
- Manager and IC delegation creates linked tasks with source-message provenance, optional parent/initiative, permission ceilings and inherited approved authority. The existing task runner owns dispatch; dependency acceptance gates execution. Parent acceptance requires children to be accepted or explicitly cancelled.
- Approved authority reserves a bounded task count and task budgets, optionally delegates task-result review, and permits the initiative owner and proposing chief to coordinate without repeated handoff approvals. Initiative completion remains human reviewed. Budget reservations are not a guarantee of exact provider billing: provider cost reporting can lag or be unavailable.
- Reconciliation persists task/checkpoint notices, retries queued wakes and deduplicates across restarts. Dated project snapshots revise when tracked state changes; agents can add synthesized briefs. Priority reads span workspaces. Changes notify affected owners through durable queued context updates.
- Workspace Organization and work panel: organization/remits, independent initiative editing, task ownership/dependencies/results/history, before/after approval, project reports and change history. Task triage retains its status groups and gains initiative/owner filters.
- Reorg plans support team creation/rename/move/archive, manager assignment/replacement, conversation moves, task initiative/accountability changes and dispatch of planned work. A stale material baseline rejects approval; the same core dry run validates preview and apply. Running task accountability transfers after execution. Structural moves of busy teams/chats wait for a safe boundary. History remains attached; reversal uses another reviewed plan. Cross-workspace moves remain excluded.

## Verification record

Domain and daemon tests cover direct work without managers, IC delegation, task graphs and accepted progress, independent initiative completion, bounded authority and independent task review, stale approvals, rejected cyclic/cross-workspace changes, report revisions, duplicate commands, reconciliation after restart and deferred accountability handoff.

The headless company journey uses a real daemon and synthetic data. It covers organization approval by keyboard, responsibility and initiative edits, direct planned bug work, reviewed reorganization, stale approval rejection, persistent reports, both themes, accessibility scans and 320px reflow. Existing shipping and comparison journeys also run headlessly. Native Cua verification used separate synthetic app data and confirmed initiative edit → proposal → approval → changed outcome and a saved report revision. The temporary Electron window was closed afterward.

Provider transport tests use deterministic CLI fakes through production adapters, host MCP and daemon RPC, including restart/resume. They establish coordination and transport behavior, not the quality of a particular CEO model. CEO provider/model selection remains configurable; comparative live-model evaluation is separate work.
