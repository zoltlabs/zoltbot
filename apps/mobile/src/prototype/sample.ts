import type { Interaction } from "@zoltbot/protocol";
import { type Agent, type Project, providers, type State, updateAgent } from "./model";

/** Relative times and normalized interactions follow data/sample.ts. No live client is used. */
export function requestFor(id: string, index: number, now: number, topic = "billing"): Interaction {
  const type = (["approval", "question", "plan"] as const)[index % 3] ?? "approval";
  const request: Interaction = {
    id: `request-${id}`,
    agentId: id,
    threadId: id,
    type,
    version: 1,
    state: "pending",
    chain: [],
    urgency: "blocking",
    createdAt: new Date(now - (index + 1) * 17 * 60000).toISOString(),
    title:
      type === "approval"
        ? "Run the migration rehearsal?"
        : type === "question"
          ? "Which invoice history should we keep?"
          : "Review the invoice cutover plan",
    context:
      type === "approval"
        ? {
            command: "pnpm billing:rehearse --sandbox",
            markdown: "Rehearse against synthetic invoices before changing the importer.",
          }
        : type === "plan"
          ? {
              markdown:
                "1. Import synthetic invoices.\n2. Compare totals and tax rounding.\n3. Switch the reader only after totals match.\n4. Keep the old reader available for rollback.",
            }
          : {
              markdown:
                "The old export contains seven years of invoices. The new reader supports both options.",
            },
    items:
      type === "question"
        ? [
            {
              id: "history",
              prompt: "How much history should the importer retain?",
              options: [
                { id: "all", label: "All seven years" },
                { id: "recent", label: "Last two years" },
              ],
              allowOther: true,
            },
          ]
        : [
            {
              id: "approve",
              prompt:
                type === "plan"
                  ? "Approve the cutover plan?"
                  : "Run the sandbox rehearsal command?",
              choices: [
                { id: "allow_once" },
                { id: type === "plan" ? "allow_accept_edits" : "allow_session" },
                { id: "reject_once" },
              ],
            },
          ],
  };
  if (topic !== "billing") {
    if (type === "question") {
      const reminders = topic === "reminders";
      request.title = reminders
        ? "When should we remind renters?"
        : "Which payment methods ship first?";
      request.context = {
        markdown: reminders
          ? "The delivery worker is ready. Choose the first reminder window."
          : "Card payments are ready. Choose whether this release also includes Apple Pay.",
      };
      request.items = [
        {
          id: "scope",
          prompt: reminders
            ? "Send return reminders 24 or 48 hours ahead?"
            : "Which payment methods should checkout offer?",
          options: reminders
            ? [
                { id: "24", label: "24 hours" },
                { id: "48", label: "48 hours" },
              ]
            : [
                { id: "cards", label: "Cards only" },
                { id: "both", label: "Cards and Apple Pay" },
              ],
          allowOther: true,
        },
      ];
    } else {
      request.title = "Run the checkout regression suite?";
      request.context = {
        command: "pnpm checkout:test --sandbox",
        markdown: "Run the regression suite with synthetic rental orders.",
      };
      request.items = [
        {
          id: "approve",
          prompt: "Run the checkout regression suite?",
          choices: [{ id: "allow_once" }, { id: "allow_session" }, { id: "reject_once" }],
        },
      ];
    }
  }
  return request;
}
const specs = [
  [
    "Checkout redesign",
    "Reduce checkout to two steps.",
    8,
    18,
    "Address validation landed; two payment paths remain.",
    ["#142 Two-step checkout", "#148 Address validation"],
    [],
  ],
  [
    "Search relevance",
    "Rank available gear ahead of sold-out stock.",
    12,
    20,
    "Boosted available inventory; evaluation gained 8 points.",
    ["#151 Availability ranking"],
    [],
  ],
  [
    "iOS widget",
    "Show the next equipment return at a glance.",
    11,
    12,
    "Timeline refresh and empty state passed review.",
    ["#154 Return widget"],
    [],
  ],
  [
    "Billing migration",
    "Move invoice reads without losing history.",
    3,
    16,
    "Importer is ready; all six agents await decisions.",
    ["#139 Invoice importer"],
    [],
  ],
  [
    "Flaky test cleanup",
    "Make rental reservation checks reliable.",
    4,
    24,
    "Found a shared clock race; reservation checks still fail.",
    ["#146 Freeze test clock", "#149 Isolate inventory"],
    ["Reservation race", "Invoice rounding", "Return timezone"],
  ],
  [
    "Return reminders",
    "Send a reminder before each rental is due.",
    6,
    10,
    "Email templates merged; delivery retry is running.",
    ["#153 Reminder retry"],
    [],
  ],
] as const;
const jobs = [
  "Implementation",
  "Test coverage",
  "Review",
  "Data migration",
  "Accessibility",
  "Release checks",
];
export function sampleProject(size: "full" | "tiny" | "empty" = "full", now = Date.now()): Project {
  return {
    name:
      size === "full"
        ? "Bracken Supply · Autumn reliability"
        : size === "tiny"
          ? "Bracken Supply · Depot pilot"
          : "Bracken Supply · Winter planning",
    spend: size === "full" ? 38.72 : size === "tiny" ? 1.84 : 0,
    initiatives: (size === "empty" ? [] : specs.slice(0, size === "tiny" ? 1 : 6)).map((s, i) => ({
      id: `initiative-${i}`,
      name: s[0],
      goal: s[1],
      done: s[2],
      total: s[3],
      changes: s[4],
      prs: [...s[5]],
      checks: [...s[6]],
      agents: jobs.slice(0, size === "tiny" ? 2 : 6).map((job, n): Agent => {
        const id = `unit-${i * 6 + n + 1}`;
        const state: State =
          i === 3
            ? "needs_you"
            : i === 1
              ? n < 4
                ? "working"
                : "idle"
              : i === 2
                ? n < 5
                  ? "review"
                  : "working"
                : i === 4
                  ? n < 3
                    ? "problem"
                    : "working"
                  : ((["working", "needs_you", "review", "idle", "later", "working"] as const)[n] ??
                    "idle");
        return {
          id,
          title: `${job} · ${s[0]}`,
          provider: providers[(i + n) % providers.length] ?? "codex",
          state,
          activity:
            state === "working"
              ? `${["Implementing", "Testing", "Reviewing", "Comparing records for", "Checking accessibility for", "Running release checks for"][n]} ${s[0].toLowerCase()}`
              : state === "problem"
                ? "Session stopped: required check failed"
                : state === "needs_you"
                  ? "Waiting for your decision"
                  : state === "review"
                    ? "Finished; result unread"
                    : state === "later"
                      ? "Scheduled after the next release"
                      : "Ready for another task",
          result:
            n % 2
              ? "Added regression coverage for the previous change."
              : "Reviewed the current behavior and recorded remaining risks.",
          messages: ["Keep the change scoped to the rental workflow."],
          ...(state === "needs_you"
            ? {
                request: requestFor(
                  id,
                  i * 6 + n,
                  now,
                  i === 5 ? "reminders" : i === 0 ? "checkout" : "billing",
                ),
              }
            : {}),
        };
      }),
    })),
  };
}
/** Three finite events, then no churn. Never mutates a request the owner is answering. */
export function simulate(project: Project, tick: number, now: number): Project {
  const agent = project.initiatives
    .flatMap((i) => i.agents)
    .find((a) => a.state === "working" && !a.request);
  if (!agent || tick > 2) return project;
  return updateAgent(project, agent.id, (a) =>
    tick === 1
      ? {
          ...a,
          state: "needs_you",
          activity: "Waiting for a rehearsal approval",
          request: requestFor(a.id, 0, now, "checkout"),
        }
      : tick === 2
        ? {
            ...a,
            state: "review",
            activity: "Finished; result unread",
            result: "Regression suite passes; ready for review.",
          }
        : { ...a, activity: "Running the final regression suite" },
  );
}

/** Adds four independent workers to test the upper density limit. */
export function stressProject(now = Date.now()): Project {
  const project = sampleProject("full", now);
  const first = project.initiatives[0];
  const source = first?.agents[0];
  if (!first || !source) return project;
  for (let n = 0; n < 4; n++)
    first.agents.push({
      ...source,
      id: `unit-${37 + n}`,
      title: `${["Inventory", "Receipts", "Tax rounding", "Payment retry"][n]} · Checkout redesign`,
      provider: providers[n] ?? "codex",
      messages: [...source.messages],
    });
  return project;
}
