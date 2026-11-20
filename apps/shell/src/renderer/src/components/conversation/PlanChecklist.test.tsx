import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, PlanStep } from "../../../../shared/ipc";
import { PlanChecklist } from "./PlanChecklist";
import { planExpanded, planProgress } from "./plan";

const working: PlanStep[] = [
  { step: "Read the notes", status: "completed" },
  { step: "Draft the summary", status: "in_progress" },
  { step: "Check the links", status: "pending" },
];
const finished = working.map((step) => ({ ...step, status: "completed" as const }));

describe("plan rules", () => {
  it("counts done steps and finds the current one", () => {
    expect(planProgress(working)).toEqual({ done: 1, total: 3, current: working[1] });
    expect(planProgress([])).toEqual({ done: 0, total: 0, current: undefined });
  });

  it("opens while work is left, folds when done, and keeps a choice made by hand", () => {
    expect(planExpanded(working, undefined)).toBe(true);
    expect(planExpanded(finished, undefined)).toBe(false);
    expect(planExpanded(finished, true)).toBe(true);
    expect(planExpanded(working, false)).toBe(false);
  });
});

describe("PlanChecklist", () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  let plans: Record<string, PlanStep[]>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    listener = undefined;
    unsubscribe = vi.fn();
    plans = { chief: working, other: [] };
    Object.assign(window, {
      openbot: {
        agent: {
          readConversation: vi.fn(async (botId: string) => ({
            botId,
            threadId: botId,
            activeTurnId: null,
            revision: 1,
            messages: [],
            plan: plans[botId],
          })),
          onEvent: vi.fn((next: (event: AgentEvent) => void) => {
            listener = next;
            return unsubscribe;
          }),
        },
      },
    });
  });

  function update(botId: string, plan: PlanStep[]) {
    listener?.({
      type: "conversation",
      snapshot: { botId, threadId: botId, activeTurnId: null, revision: 2, messages: [], plan },
    });
  }

  it("shows the steps and progress, then folds to one line when every step is done", async () => {
    render(() => <PlanChecklist botId="chief" />);
    const toggle = await screen.findByRole("button", { name: /Plan/ });
    expect(toggle).toHaveTextContent("1 of 3 done");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list");
    expect(list).toBeVisible();
    expect(screen.getByText("Draft the summary").closest("li")).toHaveTextContent("In progress");

    update("chief", finished);
    await waitFor(() => expect(toggle).toHaveTextContent("3 of 3 done"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(list).not.toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(list).toBeVisible();
  });

  it("shows the current step on the folded line", async () => {
    render(() => <PlanChecklist botId="chief" />);
    const toggle = await screen.findByRole("button", { name: /Plan/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Draft the summary");
  });

  it("ignores other chats and hides when the chat has no plan", async () => {
    const [botId, setBotId] = createSignal("chief");
    render(() => <PlanChecklist botId={botId()} />);
    await screen.findByRole("button", { name: /Plan/ });
    update("other", finished);
    expect(screen.getByRole("button", { name: /Plan/ })).toHaveTextContent("1 of 3 done");

    setBotId("other");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Plan/ })).toBeNull());
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("forgets a choice made by hand when the chat changes", async () => {
    plans.other = working;
    const [botId, setBotId] = createSignal("chief");
    render(() => <PlanChecklist botId={botId()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Plan/ }));
    expect(screen.getByRole("button", { name: /Plan/ })).toHaveAttribute("aria-expanded", "false");
    setBotId("other");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Plan/ })).toHaveAttribute("aria-expanded", "true"),
    );
  });

  it("drops a read that lands after the chat changed", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const read = window.openbot.agent.readConversation as ReturnType<typeof vi.fn>;
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const [botId, setBotId] = createSignal("chief");
    render(() => <PlanChecklist botId={botId()} />);
    setBotId("other");
    finish({
      botId: "chief",
      threadId: "chief",
      activeTurnId: null,
      revision: 1,
      messages: [],
      plan: working,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /Plan/ })).toBeNull();
  });

  it("stops listening when it unmounts", async () => {
    const { unmount } = render(() => <PlanChecklist botId="chief" />);
    await screen.findByRole("button", { name: /Plan/ });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
