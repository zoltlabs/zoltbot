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
