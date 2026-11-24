import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentsOverview, OpenDocument } from "../../../shared/documents";
import { DocumentsPage } from "./DocumentsPage";

vi.mock("./DocumentPane", () => ({
  DocumentPane: () => <div data-testid="document-pane" />,
}));

const overview: DocumentsOverview = {
  projectId: "project",
  projectName: "Notes",
  root: "/Users/you/notes",
  files: [
    {
      path: "plan.md",
      name: "plan.md",
      folder: "",
      size: 10,
      modifiedAt: "2026-11-01T00:00:00.000Z",
      git: null,
      openComments: 0,
      reviewing: false,
    },
  ],
  truncated: false,
  git: null,
};

const opened = {
  projectId: "project",
  path: "plan.md",
  text: "# Plan",
  hash: "hash",
  comments: [],
  review: null,
  baseline: null,
  git: null,
  committed: false,
} as unknown as OpenDocument;

let panelWidth = 600;
const observers: Array<() => void> = [];

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    const fire = () =>
      this.callback(
        [{ contentRect: { width: panelWidth } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    observers.push(fire);
    fire();
  }
  disconnect() {}
  unobserve() {}
}

function renderPage() {
  return render(() => (
    <DocumentsPage
      projectId="project"
      openPath={null}
      bots={[]}
      sidebarCollapsed={false}
      onShowSidebar={() => {}}
      onOpenTasks={() => {}}
    />
  ));
}

describe("Documents file list", () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    Object.assign(window, {
      openbot: {
        documents: {
          list: vi.fn(async () => overview),
          open: vi.fn(async () => opened),
          stat: vi.fn(async () => opened),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("folds away in a narrow window once a document opens", async () => {
    panelWidth = 600;
    renderPage();
    await fireEvent.click(await screen.findByRole("button", { name: "plan.md" }));
    const fileList = document.getElementById("docs-file-list");

    await screen.findByTestId("document-pane");
    await waitFor(() => expect(fileList).toHaveAttribute("hidden"));
    const toggle = screen.getByRole("button", { name: "Show files" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(toggle);
    expect(fileList).not.toHaveAttribute("hidden");
  });

  it("stays visible in a wide window, and when the window narrows with a document open", async () => {
    panelWidth = 1100;
    renderPage();
    await fireEvent.click(await screen.findByRole("button", { name: "plan.md" }));
    const fileList = document.getElementById("docs-file-list");
    await screen.findByTestId("document-pane");
    expect(fileList).not.toHaveAttribute("hidden");

    panelWidth = 600;
    for (const fire of observers) fire();
    expect(fileList).not.toHaveAttribute("hidden");
  });

  it("shows the list again after widening once it folded away", async () => {
    panelWidth = 600;
    renderPage();
    await fireEvent.click(await screen.findByRole("button", { name: "plan.md" }));
    const fileList = document.getElementById("docs-file-list");
    await waitFor(() => expect(fileList).toHaveAttribute("hidden"));

    panelWidth = 1100;
    for (const fire of observers) fire();
    expect(fileList).not.toHaveAttribute("hidden");
  });
});
