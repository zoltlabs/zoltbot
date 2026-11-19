import { HOST_WORKSPACE_REF, STAFF_ALLOWANCE_OPTION, STAFF_APPROVAL_ITEM } from "@zoltbot/protocol";
import { sampleChannelRows } from "./fake-channels.js";
import type { Row } from "./transport.js";

// Sample data for a manager's chat and backup models: Mira assigns two tasks to Sam and Theo,
// waits on one, asks to add Juno, and Sam's chat has moved to a backup account. Every row uses
// the real protocol entity shape (fake-manager.test.ts checks them).

/** What the sample Mac needs from FakeTransport to answer manager and model calls. */
export interface ManagerRows {
  rows(kind: string): Row[];
  put(kind: string, row: Row): Row;
  at(): string;
}

const MIRA = "thread-mira";
// Sam and Theo work in their task chats; the channel sample owns these ids.
const SAM = "thread-task-rounding";
const THEO = "thread-task-invoice";
const LEAD = "agent-mira";
const owner = (threadId: string) => (threadId === SAM ? "agent-sam" : "agent-theo");

const sonnet = {
  steer: "native",
  models: {
    selectable: true,
    list: [
      { id: "sonnet", name: "Sonnet" },
      { id: "opus", name: "Opus" },
    ],
  },
};

/** Adds the manager sample to the snapshot's rows, keeping what is already there. */
export function seedManagerSample(entities: Record<string, Row[]>, now: number) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const add = (kind: string, rows: Row[]) => {
    const id = (row: Row) => row.id ?? row.key;
    const have = new Set((entities[kind] ?? []).map(id));
    const fresh = rows.filter((row) => id(row) === undefined || !have.has(id(row)));
    entities[kind] = [...(entities[kind] ?? []), ...fresh];
  };
  const item = (
    id: string,
    threadId: string,
    seq: number,
    kind: string,
    body: Row,
    minutes: number,
    turnId?: string,
  ) => ({
    id,
    threadId,
    ...(turnId ? { turnId } : {}),
    seq,
    kind,
    body,
    createdAt: ago(minutes),
    updatedAt: ago(minutes),
  });
  const message = (id: string, to: string, kind: string, text: string, minutes: number) => ({
    id,
    thread: to,
    fromThread: MIRA,
    from: { kind: "agent", id: LEAD },
    to: [{ kind: "agent", id: owner(to) }],
    kind,
    expectsReply: false,
    priority: "normal",
    delivery: "next_turn",
    root: id,
    hops: 0,
    ttlHops: 4,
    origin: "agent",
    body: [{ type: "text", text: `[Mira → ${to === SAM ? "Sam" : "Theo"}]\n${text}` }],
    createdAt: ago(minutes),
  });
  const session = (id: string, threadId: string, provider: string, extra: Row = {}) => ({
    id,
    threadId,
    provider,
    cwd: "/Users/you/Projects/acme-web",
    state: "running",
    capabilities: {},
    startedAt: ago(40),
    ...extra,
  });
  const setting = (key: string, value: unknown) => ({ key, value });

  // Mira, Sam, Theo and their two tasks come from the channel sample, so both samples share them.
  // Here the tasks also link back to Mira's briefs, and Theo's is ready for review.
  const shared = sampleChannelRows(now);
  const assigned: Record<string, Row> = {
    "task-rounding": { sourceMessageId: "brief-sam", createdAt: ago(29), updatedAt: ago(4) },
    "task-invoice": {
      sourceMessageId: "brief-theo",
      state: "review",
      createdAt: ago(29),
      updatedAt: ago(9),
    },
  };
  for (const kind of ["project", "agent", "thread"]) add(kind, shared[kind] ?? []);
  add(
    "task",
    (shared.task ?? []).map((task) => ({
      ...task,
      ...assigned[String(task.id)],
      accountableThreadId: MIRA,
      budgetUsd: 2,
    })),
  );
  add("session", [
    session("session-mira", MIRA, "claude", { state: "ready" }),
    session("session-sam", SAM, "claude", { capabilities: sonnet, model: "sonnet" }),
    session("session-theo", THEO, "codex", { state: "ready" }),
  ]);
  add("turn", [
    {
      id: "turn-mira-1",
      threadId: MIRA,
      sessionId: "session-mira",
      status: "completed",
      origin: "human",
      startedAt: ago(31),
      endedAt: ago(28),
    },
    {
      id: "turn-sam-1",
      threadId: SAM,
      sessionId: "session-sam",
      status: "running",
      origin: "agent",
      startedAt: ago(4),
    },
    {
      id: "turn-theo-1",
      threadId: THEO,
      sessionId: "session-theo",
      status: "completed",
      origin: "agent",
      startedAt: ago(18),
      endedAt: ago(9),
    },
  ]);
  add("message", [
    message("brief-sam", SAM, "task", "Fix checkout tax rounding for EU orders.", 29.5),
    message("brief-theo", THEO, "task", "Add a test that covers invoice rounding.", 29.4),
    message("tip-theo", THEO, "message", "use the EU fixtures", 20),
  ]);
  add("usage", [
    {
      id: "usage-sam",
      sessionId: "session-sam",
      taskId: "task-rounding",
      costUsd: 0.41,
      costKnown: true,
      injectedTokens: 0,
      recordedAt: ago(4),
    },
    {
      id: "usage-theo",
      sessionId: "session-theo",
      taskId: "task-invoice",
      costUsd: 0.32,
      costKnown: true,
      injectedTokens: 0,
      recordedAt: ago(9),
    },
  ]);
  add("taskResult", [
    {
      taskId: "task-invoice",
      revision: 1,
      status: "done",
      summary: "Added invoice rounding tests with EU fixtures.",
      files: ["invoice.test.ts", "fixtures/eu.json"],
      digest: "",
      auto: false,
      createdAt: ago(9),
    },
  ]);
  add("deliverable", [
    {
      id: "deliverable-invoice",
      taskId: "task-invoice",
      projectId: "acme-web",
      kind: "code_change",
      title: "Test invoice rounding",
      version: 1,
      ref: "invoice.test.ts",
      evidence: [{ kind: "test", label: "14 tests", ref: "pnpm test invoice", status: "passed" }],
      validationState: "passed",
      reviewState: "pending",
      createdAt: ago(9),
    },
  ]);
  add("item", [
    item(
      "mira-ask",
      MIRA,
      1,
      "user",
      { input: [{ type: "text", text: "Ship the EU tax fix this week." }], queueState: "sent" },
      31,
      "turn-mira-1",
    ),
    item(
      "mira-plan",
      MIRA,
      2,
      "message",
      { text: "I'll split it in two: Sam fixes checkout, Theo adds a test that covers invoices." },
      29,
      "turn-mira-1",
    ),
    item(
      "mira-note",
      MIRA,
      3,
      "message",
      { text: "Covers both rounding paths. Ready to merge after Sam's fix." },
      8,
    ),
    item(
      "sam-1",
      SAM,
      1,
      "message",
      {
        text: "Checkout now rounds each line before summing, the same as invoices. Updating the receipt template next.",
      },
      6,
      "turn-sam-1",
    ),
    item(
      "sam-switch",
      SAM,
      2,
      "note",
      {
        code: "model_switch",
        change: "switched",
        from: "Personal",
        to: "Work",
        until: ago(-60),
        text: "Personal hit its limit. Continuing on Work.",
      },
      5,
    ),
    item(
      "sam-2",
      SAM,
      3,
      "message",
      { text: "Receipt template updated. Running the email snapshot tests." },
      3,
      "turn-sam-1",
    ),
  ]);
  add("interaction", [
    {
      id: "staff-approval-juno",
      agentId: LEAD,
      threadId: MIRA,
      type: "approval",
      title: "Add Juno to Acme web",
      context: {
        toolName: "company_work",
        markdown: "Add Juno to Acme web",
        toolInput: {
          staffChange: {
            actor: { agentId: LEAD, threadId: MIRA },
            request: {
              kind: "add",
              name: "Juno",
              role: "QA engineer",
              folders: ["apps/web/tests"],
            },
            id: "juno",
            preview: {
              kind: "add",
              projectId: "acme-web",
              name: "Juno",
              teamName: "Acme web",
              requestedBy: { threadId: MIRA, name: "Mira" },
              fields: [
                { label: "Name", after: "Juno" },
                { label: "Role", after: "QA engineer" },
                { label: "Model", after: "Sonnet" },
                { label: "Can edit", after: "apps/web/tests" },
                { label: "Reports to", after: "Mira" },
                { label: "First task", after: "Write EU checkout tests" },
              ],
              allowanceOffer: { max: 2, models: ["Sonnet"], folders: ["apps/web/tests"] },
            },
          },
        },
      },
      items: [
        {
          id: STAFF_APPROVAL_ITEM,
          header: "Team",
          prompt: "Add Juno to Acme web",
          choices: [{ id: "allow_once" }, { id: "reject_once" }],
          options: [
            { id: STAFF_ALLOWANCE_OPTION, label: "Add up to 2 more like this without asking" },
          ],
          multi: true,
        },
      ],
      chain: [{ kind: "agent", id: LEAD }],
      urgency: "background",
      nativeRef: HOST_WORKSPACE_REF,
      version: 1,
      state: "pending",
      createdAt: ago(7),
    },
    {
      id: "backup-sam",
      agentId: "agent-sam",
      threadId: SAM,
      type: "question",
      title: "Continue on Codex?",
      context: {
        toolInput: {
          backupSwitch: {
            from: "Claude · Work",
            to: "Codex",
            provider: "Codex",
            until: ago(-60),
            project: "Acme web",
          },
        },
      },
      items: [
        {
          id: "choice",
          header: "Provider",
          prompt: "Claude · Work is at its limit. Codex can continue now.",
          options: [
            { id: "continue", label: "Continue on Codex", recommended: true },
            { id: "wait", label: "Wait for the limit to reset" },
          ],
        },
        {
          id: "remember",
          header: "Next time",
          prompt: "Don't ask again for Acme web",
          options: [
            { id: "remember", label: "Don't ask again" },
            { id: "ask", label: "Ask next time" },
          ],
        },
      ],
      chain: [{ kind: "system", id: "backup-models" }],
      urgency: "background",
      nativeRef: HOST_WORKSPACE_REF,
      version: 1,
      state: "pending",
      createdAt: ago(2),
    },
  ]);
  add("settings", [
    setting(`team.wait.${MIRA}`, {
      id: "wait-mira",
      threadId: MIRA,
      taskIds: ["task-rounding"],
      chatIds: [],
      status: "waiting",
      revision: 1,
      fallbackAt: ago(-120),
      createdAt: ago(8),
      updatedAt: ago(8),
    }),
    setting("models.account.acct-personal", {
      id: "acct-personal",
      label: "Personal",
      definitionId: "claude",
      configDirectory: "~/.zoltbot/accounts/personal",
      createdAt: ago(60 * 24 * 9),
    }),
    setting("models.account.acct-work", {
      id: "acct-work",
      label: "Work",
      definitionId: "claude",
      configDirectory: "~/.zoltbot/accounts/work",
      createdAt: ago(60 * 24 * 9),
    }),
    setting("models.limit.acct-personal", {
      resetsAt: ago(-60),
      observedAt: ago(5),
      sessionId: "session-sam",
    }),
    setting("models.limit.acct-work", {
      resetsAt: ago(-210),
      observedAt: ago(2),
      sessionId: "session-sam",
    }),
    setting(`models.active.${SAM}`, {
      accountId: "acct-work",
      model: "sonnet",
      home: false,
      copied: false,
      at: ago(5),
    }),
    setting("models.orders", {
      employee: [
        { accountId: "acct-personal", model: "Sonnet" },
        { accountId: "acct-work", model: "Sonnet" },
        { accountId: "default:codex", model: "GPT-5.5" },
      ],
      manager: null,
      ceo: null,
      agents: {},
    }),
  ]);
}

const value = (store: ManagerRows, key: string) =>
  store.rows("settings").find((row) => row.key === key)?.value as Row | undefined;

/** Accounts as `modelAccount.list` returns them: the stored sign-ins and each tool's own. */
function accounts(store: ManagerRows): Row[] {
  const definitions = store.rows("agentDefinition");
  const limit = (id: string) => {
    const found = value(store, `models.limit.${id}`);
    return found ? { limit: { resetsAt: found.resetsAt, observedAt: found.observedAt } } : {};
  };
  const added = store
    .rows("settings")
    .filter((row) => String(row.key).startsWith("models.account."))
    .map((row) => row.value as Row)
    .map(
      (account): Row => ({
        ...account,
        provider: account.definitionId,
        isDefault: false,
        login: "signed_in",
        inUse: 0,
        ...limit(String(account.id)),
      }),
    );
  const own = definitions
    .filter((definition) => !added.some((account) => account.definitionId === definition.id))
    .map((definition) => ({
      id: `default:${String(definition.id)}`,
      label: definition.displayName,
      definitionId: definition.id,
      provider: definition.id,
      configDirectory: `~/.${String(definition.id)}`,
      isDefault: true,
      login: "signed_in",
      inUse: 0,
      ...limit(`default:${String(definition.id)}`),
    }));
  return [...added, ...own];
}

/** Answers the manager and backup model calls, or undefined for any other method. */
export function answerManager(method: string, p: Row, store: ManagerRows): unknown {
  const now = store.at();
  switch (method) {
    case "modelAccount.list":
      return { items: accounts(store), orders: value(store, "models.orders") };
    case "backupOrder.set": {
      const orders = { ...(value(store, "models.orders") ?? {}) } as Row;
      if (typeof p.role === "string") orders[p.role] = p.entries;
      else orders.agents = { ...((orders.agents as Row) ?? {}), [String(p.threadId)]: p.entries };
      store.put("settings", { key: "models.orders", value: orders });
      return orders;
    }
    case "company.wakeNow": {
      const key = `team.wait.${String(p.threadId)}`;
      const wait = value(store, key);
      if (!wait || wait.id !== p.waitId) throw new Error("wait_not_found");
      store.put("settings", {
        key,
        value: { ...wait, status: "woken", reason: "owner", updatedAt: now },
      });
      return { ok: true };
    }
    case "staff.allowance": {
      const key = `staff.allowance.${String(p.threadId)}`;
      const prior = value(store, key);
      store.put("settings", {
        key,
        value: {
          threadId: p.threadId,
          projectId: prior?.projectId ?? "acme-web",
          max: p.max,
          used: prior?.used ?? 0,
          models: p.models ?? prior?.models ?? [],
          folders: p.folders ?? prior?.folders ?? [],
          revision: Number(prior?.revision ?? 0) + 1,
          grantedAt: prior?.grantedAt ?? now,
          updatedAt: now,
        },
      });
      return { ok: true };
    }
    default:
      return undefined;
  }
}
