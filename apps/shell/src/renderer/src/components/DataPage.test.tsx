import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUpAppTest } from "../app-test-harness";
import { DataPage } from "./DataPage";

function page(projectId: string | null = null) {
  render(() => (
    <DataPage projectId={projectId} sidebarCollapsed={false} onShowSidebar={() => {}} />
  ));
  return screen.getByRole("main", { name: "Data" });
}

describe("Data page", () => {
  beforeEach(() => setUpAppTest());

  it("says agents make the tables when a project has none", async () => {
    vi.mocked(window.openbot.data.projects).mockResolvedValue([{ id: "p1", name: "Website" }]);
    const main = page();
    expect(
      await within(main).findByText("No tables yet. Agents create them as they work."),
    ).toBeInTheDocument();
    expect(window.openbot.data.tables).toHaveBeenCalledWith("p1");
    expect(within(main).queryByRole("button", { name: "Export CSV" })).toBeNull();
  });

  it("shows the empty state with no projects at all", async () => {
    const main = page();
    expect(
      await within(main).findByText("No tables yet. Agents create them as they work."),
    ).toBeInTheDocument();
    expect(window.openbot.data.tables).not.toHaveBeenCalled();
  });

  it("opens the chat's project, lists tables, shows a page of rows, and pages on", async () => {
    vi.mocked(window.openbot.data.projects).mockResolvedValue([
      { id: "p1", name: "Website" },
      { id: "p2", name: "Sales" },
    ]);
    vi.mocked(window.openbot.data.tables).mockResolvedValue({
      tables: [
        { name: "leads", columns: ["name", "score", "card"], rows: 150 },
        { name: "notes", columns: ["body"], rows: 1 },
      ],
      bytes: 190 * 1024 * 1024,
      limitBytes: 200 * 1024 * 1024,
    });
    vi.mocked(window.openbot.data.rows).mockResolvedValue({
      columns: ["name", "score", "card"],
      rows: [
        ["Acme", 3, { bytes: 2048 }],
        ["Globex", null, null],
      ],
      total: 150,
    });
    const main = page("p2");
    const grid = await within(main).findByRole("region", { name: "leads" });
    expect(window.openbot.data.tables).toHaveBeenCalledWith("p2");
    expect(within(grid).getByRole("columnheader", { name: "score" })).toBeInTheDocument();
    expect(within(grid).getByRole("cell", { name: "Acme" })).toBeInTheDocument();
    expect(within(grid).getByRole("cell", { name: "Binary data, 2 KB" })).toBeInTheDocument();
    expect(within(main).getByText("1–2 of 150")).toBeInTheDocument();
    expect(
      within(main).getByText("190 MB of 200 MB used. Agents can’t add more once it’s full."),
    ).toBeInTheDocument();
    const tables = within(main).getByRole("navigation", { name: "Tables" });
    expect(within(tables).getByRole("button", { name: /leads/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(tables).getByText("150 rows")).toBeInTheDocument();

    expect(within(main).getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(within(main).getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(window.openbot.data.rows).toHaveBeenLastCalledWith({
        projectId: "p2",
        table: "leads",
        offset: 100,
        limit: 100,
      }),
    );

    fireEvent.click(within(tables).getByRole("button", { name: /notes/ }));
    await waitFor(() =>
      expect(window.openbot.data.rows).toHaveBeenLastCalledWith({
        projectId: "p2",
        table: "notes",
        offset: 0,
        limit: 100,
      }),
    );
  });

  it("exports the open table as CSV", async () => {
    vi.mocked(window.openbot.data.projects).mockResolvedValue([{ id: "p1", name: "Website" }]);
    vi.mocked(window.openbot.data.tables).mockResolvedValue({
      tables: [{ name: "leads", columns: ["name"], rows: 1 }],
      bytes: 4096,
      limitBytes: 200 * 1024 * 1024,
    });
    vi.mocked(window.openbot.data.rows).mockResolvedValue({
      columns: ["name"],
      rows: [["Acme"]],
      total: 1,
    });
    vi.mocked(window.openbot.data.csv).mockResolvedValue({
      name: "leads.csv",
      csv: "name\r\nAcme\r\n",
      truncated: true,
    });
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => "blob:csv");
    URL.revokeObjectURL = vi.fn();
    const main = page();
    fireEvent.click(await within(main).findByRole("button", { name: "Export CSV" }));
    expect(
      await within(main).findByText("Exported the first 20 MB of this table."),
    ).toBeInTheDocument();
    expect(window.openbot.data.csv).toHaveBeenCalledWith({ projectId: "p1", table: "leads" });
    expect(clicks).toEqual(["leads.csv"]);
    expect(within(main).queryByText(/MB used/)).toBeNull();
    click.mockRestore();
  });
});
