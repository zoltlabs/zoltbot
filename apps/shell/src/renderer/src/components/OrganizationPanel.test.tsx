import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, CompanyOverview } from "../../../shared/ipc";
import { OrganizationPanel } from "./OrganizationPanel";

const BEFORE: CompanyOverview = {
  projectId: "launch",
  projectName: "Launch",
  ceo: { botId: "ceo", name: "Avery" },
  ceoEmployees: 2,
  teams: [
    { id: "design", name: "Design", manager: { botId: "lead", name: "Robin" }, employees: 1 },
    { id: "ops", name: "Ops", manager: null, employees: 0 },
  ],
  pendingPlans: [
    {
      id: "plan",
      title: "Add a research team",
      explanation: "Research needs its own lead.",
      version: 1,
      changes: [
        { summary: "Create the Research team under Launch", why: "Research is growing" },
        { summary: "Hire Research lead as manager in Research", why: "" },
      ],
    },
  ],
  initiatives: [
    {
      id: "beta",
      title: "Ship the beta",
      outcome: "Beta in testers' hands",
      priority: "high",
      state: "active",
      owner: { botId: "lead", name: "Robin" },
      finished: 1,
      total: 3,
    },
  ],
  brief: null,
};

const AFTER: CompanyOverview = {
  ...BEFORE,
  teams: [
    ...BEFORE.teams,
    { id: "research", name: "Research", manager: { botId: "r", name: "Sam" }, employees: 0 },
  ],
  pendingPlans: [],
};

let emit: ((event: AgentEvent) => void) | undefined;
const agent = {
  readCompany: vi.fn(),
  decidePlan: vi.fn(),
  refreshBrief: vi.fn(),
  onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
    emit = listener;
    return () => undefined;
  }),
};

function renderPanel() {
  const onOpenChat = vi.fn();
  const onClose = vi.fn();
  render(() => (
    <OrganizationPanel projectId="launch" bots={[]} onOpenChat={onOpenChat} onClose={onClose} />
  ));
  return { onOpenChat, onClose };
}

describe("OrganizationPanel", () => {
  beforeEach(() => {
    emit = undefined;
    agent.readCompany.mockReset().mockResolvedValue(BEFORE);
    agent.decidePlan.mockReset().mockResolvedValue(AFTER);
    agent.refreshBrief.mockReset();
    Object.defineProperty(window, "openbot", { configurable: true, value: { agent } });
  });

  it("shows the CEO, teams with their managers and opens a person's chat", async () => {
    const { onOpenChat } = renderPanel();
    const ceo = await screen.findByRole("button", { name: /Avery\s*CEO\s*2 employees/ });
    expect(
      screen.getByRole("button", { name: /Robin\s*Design manager\s*1 employee/ }),
    ).toBeVisible();
    expect(screen.getByText("Ops, no manager")).toBeVisible();
    await fireEvent.click(ceo);
    expect(onOpenChat).toHaveBeenCalledWith("ceo");
    expect(screen.getByText("Ship the beta")).toBeVisible();
    expect(screen.getByText("Active · high priority · 1 of 3 done")).toBeVisible();
  });

  it("approves a pending plan and shows the applied organization", async () => {
    renderPanel();
    const plan = await screen.findByRole("article", { name: "Add a research team" });
    expect(within(plan).getByText("Create the Research team under Launch")).toBeVisible();
    expect(within(plan).getByText("Research is growing")).toBeVisible();
    await fireEvent.click(
      within(plan).getByRole("button", { name: "Approve Add a research team" }),
    );
    expect(screen.queryByRole("article", { name: "Add a research team" })).toBeNull();
    expect(agent.decidePlan).toHaveBeenCalledWith({
      projectId: "launch",
      planId: "plan",
      version: 1,
      approve: true,
    });
    await screen.findByRole("button", { name: /Sam\s*Research manager/ });
    expect(screen.getByText("Approved Add a research team.")).toBeVisible();
  });

  it("brings a plan back with the reason when the decision fails", async () => {
    agent.decidePlan.mockRejectedValue(
      new Error("The company changed since this plan was made. Ask for a new plan."),
    );
    renderPanel();
    await fireEvent.click(
      await screen.findByRole("button", { name: "Decline Add a research team" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The company changed since this plan was made. Ask for a new plan.",
    );
    expect(screen.getByRole("article", { name: "Add a research team" })).toBeVisible();
  });

  it("refreshes the project brief and re-reads when the company changes", async () => {
    agent.refreshBrief.mockResolvedValue({
      ...BEFORE,
      brief: {
        day: "2026-11-19",
        revision: 1,
        summary: "Launch: 1 accepted, 0 awaiting review.",
        createdAt: "2026-11-19T10:00:00.000Z",
      },
    });
    renderPanel();
    expect(await screen.findByText("No brief yet.")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Refresh brief" }));
    expect(await screen.findByText("Launch: 1 accepted, 0 awaiting review.")).toBeVisible();

    agent.readCompany.mockResolvedValue(AFTER);
    emit?.({ type: "company-changed", projectId: "other" });
    emit?.({ type: "company-changed", projectId: "launch" });
    await waitFor(() => expect(agent.readCompany).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /Sam\s*Research manager/ })).toBeVisible();
  });
});
