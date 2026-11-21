import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentSummary } from "../../../../shared/ipc";
import { FilePreview } from "./FilePreview";

const file = (name: string, previewKind: AttachmentSummary["previewKind"]): AttachmentSummary => ({
  id: name,
  name,
  size: 10,
  kind: "file",
  mimeType: "text/plain",
  previewKind,
  previewUrl: `openbot-attachment://file/${name}`,
  actions: ["open", "reveal"],
});

const serve = (body: string, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(status === 404 ? "Not found" : body, { status })),
  );

afterEach(() => vi.unstubAllGlobals());

describe("FilePreview", () => {
  it("shows a CSV as a table with its header and says when rows are left out", async () => {
    serve(["region,units", ...Array.from({ length: 520 }, (_, i) => `r${i},${i}`)].join("\n"));
    render(() => <FilePreview attachment={file("sales.csv", "csv")} />);
    const table = await screen.findByRole("region", { name: "sales.csv" });
    expect(table.querySelectorAll("th")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "region" })).toBeInTheDocument();
    expect(table.querySelectorAll("tbody tr")).toHaveLength(500);
    expect(screen.getByText("First 500 of 520 rows")).toBeInTheDocument();
  });

  it("reads TSV with tabs and pads short rows", async () => {
    serve("a\tb\tc\n1\t2\n");
    render(() => <FilePreview attachment={file("x.tsv", "tsv")} />);
    const table = await screen.findByRole("region", { name: "x.tsv" });
    expect([...table.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "1",
      "2",
      "",
    ]);
    expect(screen.queryByText(/rows$/)).toBeNull();
  });

  it("shows Markdown in a frame that can't run scripts", () => {
    render(() => <FilePreview attachment={file("plan.md", "markdown")} />);
    const frame = screen.getByTitle("plan.md");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("src")).toBe("openbot-attachment://file/plan.md?view=markdown");
  });

  it("shows SVG only as a picture and video with controls", () => {
    render(() => (
      <>
        <FilePreview attachment={file("logo.svg", "svg")} />
        <FilePreview attachment={file("demo.mp4", "video")} />
      </>
    ));
    expect(screen.getByRole("img", { name: "logo.svg" }).tagName).toBe("IMG");
    expect(document.querySelector("svg, object, embed")).toBeNull();
    const video = document.querySelector("video");
    expect(video?.controls).toBe(true);
    expect(video?.getAttribute("aria-label")).toBe("demo.mp4");
  });

  it("says when the file was moved or deleted", async () => {
    serve("", 404);
    render(() => <FilePreview attachment={file("notes.txt", "text")} />);
    expect(await screen.findByText("This file was moved or deleted.")).toBeInTheDocument();
  });
});
