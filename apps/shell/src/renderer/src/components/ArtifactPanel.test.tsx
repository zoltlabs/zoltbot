import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { vi } from "vitest";
import type { ArtifactSummary } from "../../../shared/ipc";
import { ArtifactCards, ArtifactPanel } from "./ArtifactPanel";

const REPORT: ArtifactSummary = {
  id: "artifact-1",
  versionId: "version-2",
  title: "Launch report",
  kind: "document",
  version: 2,
  manifestHash: "a".repeat(64),
};

function stubPrepare(prepare: (hash: string) => Promise<{ url: string }>) {
  Object.defineProperty(window, "openbot", {
    configurable: true,
    value: {
      artifacts: { prepare: vi.fn(prepare) },
      share: { status: vi.fn().mockResolvedValue({ kind: "unavailable" }) },
      repository: { state: vi.fn().mockResolvedValue(null) },
      agent: { onEvent: vi.fn(() => () => {}) },
    },
  });
}

describe("artifacts", () => {
  it("shows a card per artifact and opens available ones", async () => {
    const onOpen = vi.fn();
    render(() => (
      <ArtifactCards
        artifacts={[
          REPORT,
          { ...REPORT, id: "a2", versionId: "v9", title: "Old", manifestHash: null },
        ]}
        openVersionId={null}
        onOpen={onOpen}
      />
    ));
    expect(screen.getByText("Document · v2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Old" })).toBeDisabled();
    await fireEvent.click(screen.getByRole("button", { name: "Open Launch report" }));
    expect(onOpen).toHaveBeenCalledWith(REPORT);
  });

  it("frames the prepared artifact URL and closes", async () => {
    const url = `zoltbot-artifact://${"a".repeat(64)}/index.html`;
    stubPrepare(async () => ({ url }));
    const onClose = vi.fn();
    render(() => (
      <ArtifactPanel
        artifact={REPORT}
        width={440}
        maxWidth={() => 800}
        onResize={() => undefined}
        onResizeEnd={() => undefined}
        onClose={onClose}
      />
    ));
    const frame = await screen.findByTitle("Launch report");
    expect(frame).toHaveAttribute("src", url);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(window.openbot.artifacts.prepare).toHaveBeenCalledWith("a".repeat(64));
    await fireEvent.click(screen.getByRole("button", { name: "Close artifact" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers a retry when the files can't be prepared", async () => {
    let fail = true;
    stubPrepare(async () => {
      if (fail) throw new Error("artifact_unavailable");
      return { url: "zoltbot-artifact://x/index.html" };
    });
    render(() => (
      <ArtifactPanel
        artifact={REPORT}
        width={440}
        maxWidth={() => 800}
        onResize={() => undefined}
        onResizeEnd={() => undefined}
        onClose={() => undefined}
      />
    ));
    expect(await screen.findByText("Couldn’t open this artifact.")).toBeInTheDocument();
    fail = false;
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTitle("Launch report")).toBeInTheDocument());
  });
});
