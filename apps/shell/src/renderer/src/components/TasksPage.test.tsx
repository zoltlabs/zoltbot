import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, StaffCard } from "../../../shared/ipc";
import type { TaskSummary } from "../../../shared/tasks";
import { createTasksStore } from "../tasks-store";
import { TasksPage } from "./TasksPage";

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  projectId: "acme",
  projectName: "Acme app",
  state: "running",
  revision: 1,
  reason: "",
  atLimit: false,
  threadId: `${id}-thread`,
  owner: { profileId: "mira", name: "Mira" },
  teamId: "payments",
  teamName: "Payments",
  createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
});

const TASKS = [
  task("Add webhook retries", { state: "review" }),
  task("Migrate invoices", {
    state: "failed",
    reason: "usage limit",
    owner: { profileId: "kai", name: "Kai" },
    teamId: "data",
    teamName: "Data",
  }),
  task("Refund endpoint"),
  task("Idempotency keys", { state: "queued", reason: "at limit", atLimit: true }),
  task("Old work", { state: "completed" }),
];

const listeners = new Set<(event: AgentEvent) => void>();
let emit: ((event: AgentEvent) => void) | undefined;
const agent = {
  listTasks: vi.fn(),
  reviewTask: vi.fn(),
  readStaff: vi.fn(),
  staffAction: vi.fn(),
  onEvent: vi.fn((listener: (event: AgentEvent) => void) => {
    listeners.add(listener);
    emit = (event) => {
      for (const each of listeners) each(event);
    };
    return () => listeners.delete(listener);
  }),
};

function renderPage() {
  const onOpenChat = vi.fn();
  render(() => {
    const store = createTasksStore();
    return (
      <TasksPage
        store={store}
        bots={[]}
        projectId="acme"
        sidebarCollapsed={false}
        onShowSidebar={() => undefined}
        onOpenChat={onOpenChat}
      />
    );
  });
  return { onOpenChat };
}

const ADD: StaffCard = {
  kind: "staff",
  requestId: "staff-approval-1",
  action: "add",
  state: "pending",
  title: "Add Nova to Payments",
  name: "Nova",
  projectId: "acme",
  botId: "mira-thread",
  requestedBy: "Mira",
  fields: [
    { label: "Role", after: "Writes tests" },
    { label: "Model", before: "sonnet", after: "opus" },
  ],
  moves: [],
  running: 0,
  sharedWith: 0,
  allowance: 2,
};

const group = (name: RegExp) => screen.getByRole("region", { name }) as HTMLElement;

describe("TasksPage", () => {
  beforeEach(() => {
    emit = undefined;
    listeners.clear();
    agent.listTasks.mockReset().mockResolvedValue(TASKS);
    agent.reviewTask.mockReset().mockResolvedValue(undefined);
    agent.readStaff.mockReset().mockResolvedValue({ approvals: [], people: [] });
    agent.staffAction.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "openbot", { configurable: true, value: { agent } });
  });

  it("groups tasks, shows why they wait and opens a task's chat", async () => {
    const { onOpenChat } = renderPage();
    expect(await screen.findByRole("heading", { name: "Tasks · Acme app" })).toBeVisible();
    expect(within(group(/Needs you/)).getAllByRole("listitem")).toHaveLength(2);
    expect(within(group(/Running/)).getByText("Refund endpoint")).toBeVisible();
    expect(within(group(/Queued/)).getByText("Queued · at limit")).toBeVisible();
    expect(within(group(/Needs you/)).getByText("Failed · usage limit")).toBeVisible();
    expect(within(group(/Needs you/)).getByText("Kai · Data")).toBeVisible();
    const done = group(/Done/);
    expect(within(done).queryByText("Old work")).toBeNull();
    await fireEvent.click(within(done).getByRole("button", { name: "Show" }));
    expect(within(done).getByText("Old work")).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: /Refund endpoint/ }));
    expect(onOpenChat).toHaveBeenCalledWith("Refund endpoint-thread");
  });

  it("filters by team and owner", async () => {
    renderPage();
    await screen.findByText("Refund endpoint");
    await fireEvent.click(screen.getByRole("button", { name: "Owner: Anyone" }));
    await fireEvent.click(screen.getByRole("option", { name: "Kai" }));
    expect(screen.queryByText("Refund endpoint")).toBeNull();
    expect(screen.getByText("Migrate invoices")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Team: All teams" }));
    await fireEvent.click(screen.getByRole("option", { name: "Payments" }));
    expect(screen.getByText("No tasks match these filters.")).toBeVisible();
  });

  it("moves an accepted task to Done before the daemon answers", async () => {
    let finish: () => void = () => undefined;
    agent.reviewTask.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    renderPage();
    await fireEvent.click(
      await screen.findByRole("button", { name: "Accept Add webhook retries" }),
    );
    expect(within(group(/Needs you/)).queryByText("Add webhook retries")).toBeNull();
    expect(group(/Done/)).toHaveTextContent("Done · 2");
    expect(agent.reviewTask).toHaveBeenCalledWith({
      taskId: "Add webhook retries",
      revision: 1,
      decision: "accept",
    });
    finish();
  });

  it("sends a task back with feedback and restores it when the daemon refuses", async () => {
    agent.reviewTask.mockRejectedValue(new Error("stale"));
    renderPage();
    await fireEvent.click(
      await screen.findByRole("button", { name: "Send back Add webhook retries" }),
    );
    const send = screen.getByRole("button", { name: "Send back" });
    expect(send).toBeDisabled();
    await fireEvent.input(screen.getByRole("textbox", { name: "What should change?" }), {
      target: { value: "Retry on 429 too" },
    });
    await fireEvent.click(send);
    expect(agent.reviewTask).toHaveBeenCalledWith({
      taskId: "Add webhook retries",
      revision: 1,
      decision: "changes",
      feedback: "Retry on 429 too",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't send back Add webhook retries. Try again.",
    );
    expect(within(group(/Needs you/)).getByText("Add webhook retries")).toBeVisible();
  });

  it("reads the list again when the company changes", async () => {
    renderPage();
    await screen.findByText("Refund endpoint");
    agent.listTasks.mockResolvedValue([...TASKS, task("Write the brief")]);
    emit?.({ type: "company-changed", projectId: "acme" });
    await waitFor(() => expect(screen.getByText("Write the brief")).toBeVisible());
  });

  it("shows a staff approval in Needs you and approves it with the allowance", async () => {
    agent.readStaff.mockResolvedValue({ approvals: [ADD], people: [] });
    const { onOpenChat } = renderPage();
    const card = await screen.findByRole("region", { name: "Add Nova to Payments" });
    expect(group(/Needs you/)).toHaveTextContent("Needs you · 3");
    expect(within(card).getByText("Asked by Mira")).toBeVisible();
    expect(within(card).getByText("sonnet").tagName).toBe("DEL");
    expect(within(card).getByText("opus").tagName).toBe("INS");
    await fireEvent.click(within(card).getByRole("button", { name: "Open Mira" }));
    expect(onOpenChat).toHaveBeenCalledWith("mira-thread");
    await fireEvent.click(
      within(card).getByRole("checkbox", {
        name: "Let Mira add up to 2 more like this without asking",
      }),
    );
    await fireEvent.click(within(card).getByRole("button", { name: "Add Nova" }));
    expect(within(card).getByText("Approved")).toBeVisible();
    expect(agent.staffAction).toHaveBeenCalledWith({
      action: "approve",
      requestId: "staff-approval-1",
      grantAllowance: true,
    });
  });

  it("brings a staff approval back when the daemon refuses the answer", async () => {
    agent.readStaff.mockResolvedValue({ approvals: [ADD], people: [] });
    agent.staffAction.mockRejectedValue(new Error("This request was already answered."));
    renderPage();
    const card = await screen.findByRole("region", { name: "Add Nova to Payments" });
    await fireEvent.click(
      within(card).getByRole("button", { name: "Decline: Add Nova to Payments" }),
    );
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "This request was already answered.",
    );
    expect(within(card).getByRole("button", { name: "Add Nova" })).toBeVisible();
  });
});
