import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpendRow, SpendView } from "../../../shared/spend";
import { setUpAppTest } from "../app-test-harness";
import { createSpendStore } from "../spend-store";
import { UsagePage } from "./UsagePage";

const NOW = new Date(2026, 0, 10, 15);
const row = (botId: string, botName: string, date: number, costUsd: number, tokens: number) =>
  ({
    at: new Date(2026, 0, date, 9).toISOString(),
    botId,
    botName,
    projectId: botId === "t1" ? "p1" : null,
    projectName: botId === "t1" ? "Website" : "",
    model: "sonnet",
    costUsd,
    costKnown: true,
    tokens,
  }) satisfies SpendRow;

const VIEW: SpendView = {
  rows: [row("t1", "Release notes", 9, 1.5, 100), row("t2", "Researcher", 10, 0.25, 9000)],
  budgets: [{ projectId: "p1", usd: 25 }],
  projects: [{ id: "p1", name: "Website" }],
};

function page() {
  render(() => {
    const store = createSpendStore(() => NOW);
    return <UsagePage store={store} sidebarCollapsed={false} onShowSidebar={() => {}} />;
  });
  return screen.getByRole("main", { name: "Usage" });
}

describe("Usage page", () => {
  beforeEach(() => setUpAppTest());

  it("says so when nothing ran in the range", async () => {
    const main = page();
    expect(
      await within(main).findByText("No usage in this range.", { selector: "p" }),
    ).toBeInTheDocument();
    expect(window.openbot.spend.list).toHaveBeenCalledWith({
      from: new Date(2026, 0, 4).toISOString(),
    });
  });

  it("lists agents by cost, sorts by tokens, and reloads for another range", async () => {
    vi.mocked(window.openbot.spend.list).mockResolvedValue(VIEW);
    const main = page();
    const table = await within(main).findByRole("table", { name: "Usage by agent" });
    const names = () =>
      within(table)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent);
    expect(names()).toEqual(["Release notes", "Researcher"]);
    expect(within(main).getByText("$1.75")).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: "Tokens" }));
    expect(names()).toEqual(["Researcher", "Release notes"]);
    fireEvent.click(within(main).getByRole("button", { name: "30 days" }));
    await waitFor(() =>
      expect(window.openbot.spend.list).toHaveBeenLastCalledWith({
        from: new Date(2025, 11, 12).toISOString(),
      }),
    );
  });

  it("filters to a project and saves its budget", async () => {
    vi.mocked(window.openbot.spend.list).mockResolvedValue(VIEW);
    const main = page();
    await within(main).findByRole("table", { name: "Usage by agent" });
    fireEvent.click(within(main).getByRole("button", { name: /Project/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Website" }));
    const budget = await within(main).findByRole("region", { name: "Website budget" });
    expect(within(budget).getByText("$25.00 in total")).toBeInTheDocument();
    expect(
      within(within(main).getByRole("table", { name: "Usage by agent" }))
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Release notes"]);
    fireEvent.click(within(budget).getByRole("button", { name: "Edit" }));
    const amount = within(budget).getByRole("textbox", { name: "Budget in US dollars" });
    fireEvent.input(amount, { target: { value: "abc" } });
    fireEvent.click(within(budget).getByRole("button", { name: "Save" }));
    expect(await within(budget).findByRole("alert")).toHaveTextContent(
      "Enter an amount from $0 to $1,000,000.",
    );
    fireEvent.input(amount, { target: { value: "40" } });
    fireEvent.click(within(budget).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(window.openbot.spend.setBudget).toHaveBeenCalledWith({ projectId: "p1", usd: 40 }),
    );
  });
});
