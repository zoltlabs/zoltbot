import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry, MemoryView } from "../../../shared/memory";
import { setUpAppTest } from "../app-test-harness";
import { createMemoryStore } from "../memory-store";
import { MemoryPage } from "./MemoryPage";

const VIEW: MemoryView = {
  entries: [
    {
      id: "units",
      title: "Units",
      body: "Use grams.",
      kind: "decision",
      projectId: null,
      projectName: "",
      writer: { kind: "agent", id: "a1", name: "Researcher" },
      agent: { id: "a1", name: "Researcher" },
      verification: "unverified",
      status: "active",
      revision: 2,
      updatedAt: "2026-01-02T00:00:00Z",
    },
  ],
  proposals: [
    {
      id: "pr1",
      op: "create",
      itemId: null,
      title: "Uses pnpm",
      body: "The repo uses pnpm.",
      kind: "lesson",
      projectId: null,
      projectName: "",
      writer: { kind: "agent", id: "a1", name: "Researcher" },
      agent: { id: "a1", name: "Researcher" },
      reason: "Saw the lockfile",
      createdAt: "2026-01-03T00:00:00Z",
    },
  ],
};

function page() {
  render(() => {
    // Made once: a JSX prop is a getter, so a call there would run on every read.
    const store = createMemoryStore();
    return <MemoryPage store={store} sidebarCollapsed={false} onShowSidebar={() => {}} />;
  });
  return screen.getByRole("main", { name: "Memory" });
}

describe("Memory page", () => {
  beforeEach(() => setUpAppTest());

  it("says nothing is saved yet when agents haven't remembered anything", async () => {
    page();
    expect(
      await screen.findByText("Nothing saved yet. Agents add what they learn as they work."),
    ).toBeInTheDocument();
  });

  it("saves an edit at the revision it started from and reverts to an older one", async () => {
    vi.mocked(window.openbot.memory.list).mockResolvedValue(VIEW);
    vi.mocked(window.openbot.memory.revisions).mockResolvedValue([
      VIEW.entries[0] as MemoryEntry,
      { ...(VIEW.entries[0] as MemoryEntry), revision: 1, body: "Use ounces." },
    ]);
    const main = page();
    fireEvent.click(await within(main).findByRole("button", { name: /^Units/ }));
    fireEvent.click(within(main).getByRole("button", { name: "Edit" }));
    fireEvent.input(within(main).getByRole("textbox", { name: "Text" }), {
      target: { value: "Use kilograms." },
    });
    fireEvent.click(within(main).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(window.openbot.memory.save).toHaveBeenCalledWith({
        id: "units",
        title: "Units",
        body: "Use kilograms.",
        revision: 2,
      }),
    );
    // Revert waits until the edit is saved and closed.
    const revert = await within(main).findByRole("button", { name: "Revert to this" });
    await waitFor(() => expect(revert).toBeEnabled());
    fireEvent.click(revert);
    await waitFor(() =>
      expect(window.openbot.memory.save).toHaveBeenLastCalledWith({
        id: "units",
        title: "Units",
        body: "Use ounces.",
        revision: 2,
      }),
    );
  });

  it("keeps the edit open with the daemon's reason when a save fails", async () => {
    vi.mocked(window.openbot.memory.list).mockResolvedValue(VIEW);
    vi.mocked(window.openbot.memory.save).mockRejectedValue(
      new Error(
        "Error invoking remote method 'memory:save': Error: This entry changed while you were editing. Your changes weren't saved.",
      ),
    );
    const main = page();
    fireEvent.click(await within(main).findByRole("button", { name: /^Units/ }));
    fireEvent.click(within(main).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(main).getByRole("button", { name: "Save" }));
    expect(await within(main).findByRole("alert")).toHaveTextContent(
      "This entry changed while you were editing. Your changes weren't saved.",
    );
    expect(within(main).getByRole("textbox", { name: "Text" })).toHaveValue("Use grams.");
  });

  it("keeps a proposal from Needs review", async () => {
    vi.mocked(window.openbot.memory.list).mockResolvedValue(VIEW);
    const main = page();
    fireEvent.click(await within(main).findByRole("button", { name: /^Needs review/ }));
    expect(await within(main).findByText("Saw the lockfile")).toBeInTheDocument();
    fireEvent.click(within(main).getByRole("button", { name: "Keep" }));
    await waitFor(() =>
      expect(window.openbot.memory.decide).toHaveBeenCalledWith({ id: "pr1", decision: "accept" }),
    );
  });
});
