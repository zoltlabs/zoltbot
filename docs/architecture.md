# Architecture

Zoltbot has three layers. The daemon (`zoltd`, in `packages/daemon`) supervises agent processes, stores the project index and runs the host MCP server. Adapters (`packages/adapters`) translate each provider's protocol into one normalized event model (`packages/protocol`). The desktop shell (`apps/desktop`) and renderer (`packages/ui`) are clients of the daemon, as is the iPhone companion (`apps/mobile`), which pairs over an end-to-end encrypted link (`packages/link`).

## Non negotiable invariants

Every design choice follows from these. Tests enforce them where possible. Never weaken an invariant to make a test or feature easier.

* I1. The daemon (`zoltd`) is a separate process from every UI. A UI crash or restart never stops an agent.
* I2. The provider's own session is the source of truth for conversation content. Zoltbot stores an index and a display cache, never the only copy.
* I3. Zoltbot never rebuilds, summarizes, or resends conversation history, and never resends instructions each turn. It relies on each provider's native context compaction and prompt caching.
* I4. All provider differences live inside adapters. Everything outside an adapter works on the normalized event model and the capability table. No provider name checks outside `packages/adapters/*`.
* I5. Every request that blocks an agent (question, approval, plan review, form) is a durable Interaction record with a lifecycle, never a transient UI callback.
* I6. There is one agent to agent messaging model. It has hop limits, rate limits, permission grants, and an audit log.
* I7. No secret is ever written to the database, the event log, the frame logs, or an agent's context. Secrets live in the OS keychain.
* I8. Every external CLI version is recorded. Adapters declare a tested version range, detect features from handshakes, ignore unknown events, and write a raw frame log.
* I9. The text Zoltbot injects into an agent's context has a hard token budget per turn and per session, and an overhead meter shows it.
* I10. The default permission profile is never full access.
* I11. Zoltbot never writes into a provider's session store directly. It only uses that provider's CLI or protocol to create, resume, fork, rename, or compact sessions.
* I12. Every adapter passes the shared conformance suite against its fake provider before it ships, and a nightly canary runs the suite against the real CLIs.
* I13. Any action that deletes data, discards work, or widens a permission needs an explicit human confirmation recorded in the audit log.
* I14. No module in the repository exceeds about 800 lines. Split before it grows.

## Glossary

| Term | Meaning |
|---|---|
| Agent | The database record behind a Profile or a chief of staff. In the product and the UI it is called a Profile. |
| Profile | A saved preset: tool, model, effort, permission profile, instructions. Every chat and task run uses one. |
| Chief of staff | The main agent, Zolt: routes requests, starts pipelines, and briefs the user. Code says "chief". |
| Pipeline | A workflow with ordered stages, a profile per stage, and gates between them. |
| Routine | Something that runs on a schedule or an event: a workflow, a pipeline, or a prompt. |
| Provider | The external tool an agent runs on (Claude Code, Codex, and so on). |
| Agent definition | A data file describing how to detect, launch, and talk to a provider. |
| Thread | One conversation. Types: main, task, side. A thread maps to one native session at a time. |
| Session | The provider's native session or thread, identified by the provider's own id. |
| Turn | One run from an input to completion. |
| Item | One element of a turn: message, thought, tool call, plan, interaction, note. |
| Interaction | A question, approval, plan review, or form that blocks an agent until answered. |
| Task | A unit of delegated work with a brief, acceptance criteria, a workspace, a budget, and a bounded result. |
| Project, Area, Initiative | The planning hierarchy above tasks, top to bottom. Areas and initiatives are optional levels. |
| Sub-project | An optional level under a project (Area and Initiative are default labels). Chats and tasks live here. |
| Knowledge item | A small owned, versioned record (goal, decision, constraint, requirement, lesson) kept outside chats. |
| Context pack | The bounded set of knowledge items placed in a task brief. |
| Workflow | A reusable, versioned task definition with inputs, checks, and triggers. |
| Deliverable | A versioned finished output of a task with validation evidence and review state. |
| Workspace | The folder an agent session runs in. A task may get its own git worktree. |
| Host MCP server | The MCP server hosted by `zoltd` that gives every agent the `team_*` tools. |
| Grant | A permission one agent holds over another (message, assign, read, control, spawn). |
| Adapter | The code that translates one provider's protocol into normalized events. |
| Flavor | A small file of version tagged quirks for one ACP agent. |
| Native compaction | A provider's own context summarization (auto or manual). |
| Overhead meter | The UI and metric that shows tokens Zoltbot injected and the prompt cache hit ratio. |
