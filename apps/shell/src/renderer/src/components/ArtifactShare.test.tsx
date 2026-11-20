import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactLink } from "../../../shared/artifact-share";
import { setUpAppTest } from "../app-test-harness";
import { ToastRegion } from "../kit";
import { ArtifactShare } from "./ArtifactShare";

const HASH = "a".repeat(64);
const LINK: ArtifactLink = {
  id: "ab111111-1111-4111-8111-111111111111",
  visibility: "private",
  url: "https://zoltbot.example/s/ab111111-1111-4111-8111-111111111111",
  current: true,
};
const share = () => window.openbot.share;

async function openShare() {
  render(() => (
    <>
      <ArtifactShare artifactId="art-1" manifestHash={HASH} title="Design" />
      <ToastRegion />
    </>
  ));
  fireEvent.click(await screen.findByRole("button", { name: "Share" }));
  return screen.getByRole("dialog", { name: "Share Design" });
}

describe("Share in the artifact panel", () => {
  beforeEach(() => setUpAppTest());

  it("stays hidden when this build or account can't publish", async () => {
    render(() => <ArtifactShare artifactId="art-1" manifestHash={HASH} title="Design" />);
    await waitFor(() => expect(share().status).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("asks to sign in, then shows the publish choices", async () => {
    vi.mocked(share().status)
      .mockResolvedValueOnce({ kind: "signed-out" })
      .mockResolvedValueOnce({ kind: "ready", link: null });
    await openShare();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to share" }));
    expect(await screen.findByRole("button", { name: "Publish link" })).toBeInTheDocument();
    expect(window.openbot.account.signIn).toHaveBeenCalled();
  });

  it("publishes privately without asking", async () => {
    vi.mocked(share().status).mockResolvedValue({ kind: "ready", link: null });
    vi.mocked(share().publish).mockResolvedValue(LINK);
    await openShare();
    fireEvent.click(screen.getByRole("button", { name: "Publish link" }));
    expect(await screen.findByRole("textbox", { name: "Link" })).toHaveValue(LINK.url);
    expect(share().publish).toHaveBeenCalledWith({
      artifactId: "art-1",
      manifestHash: HASH,
      title: "Design",
      visibility: "private",
    });
  });

  it("confirms before publishing publicly", async () => {
    vi.mocked(share().status).mockResolvedValue({ kind: "ready", link: null });
    vi.mocked(share().publish).mockResolvedValue({ ...LINK, visibility: "public" });
    await openShare();
    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish link" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Make “Design” public?" });
    expect(confirm).toHaveTextContent("Anyone with the link can open this version.");
    expect(share().publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make public" }));
    await waitFor(() =>
      expect(share().publish).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: "public" }),
      ),
    );
  });

  it("copies, replaces an older link after confirming, and unpublishes", async () => {
    vi.mocked(share().status).mockResolvedValue({
      kind: "ready",
      link: { ...LINK, current: false },
    });
    vi.mocked(share().replace).mockResolvedValue(LINK);
    await openShare();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
    expect(share().copy).toHaveBeenCalledWith({
      artifactId: "art-1",
      manifestHash: HASH,
      title: "Design",
    });
    expect(screen.queryByRole("button", { name: "Public" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    const replace = await screen.findByRole("alertdialog", { name: "Replace the link?" });
    expect(replace).toHaveTextContent("The current link stops working.");
    const confirmReplace = screen.getAllByRole("button", { name: "Replace link" });
    fireEvent.click(confirmReplace[confirmReplace.length - 1]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Replace link" })).toBeNull());
    expect(screen.getByRole("button", { name: "Public" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    await screen.findByRole("alertdialog", { name: "Unpublish “Design”?" });
    const buttons = screen.getAllByRole("button", { name: "Unpublish" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText("Link unpublished")).toBeInTheDocument();
    const publish = await screen.findByRole("button", { name: "Publish link" });
    await waitFor(() => expect(publish).toHaveFocus());
  });

  it("ignores an answer for a version that's no longer open", async () => {
    vi.mocked(share().status).mockResolvedValue({ kind: "ready", link: null });
    let finish: (link: ArtifactLink) => void = () => {};
    vi.mocked(share().publish).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const [hash, setHash] = createSignal(HASH);
    render(() => <ArtifactShare artifactId="art-1" manifestHash={hash()} title="Design" />);
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish link" }));
    expect(screen.getByRole("button", { name: "Publishing…" })).toBeInTheDocument();
    setHash("b".repeat(64));
    finish(LINK);
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    expect(screen.getByRole("button", { name: "Publish link" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Link" })).toBeNull();
  });

  it("shows why publishing failed", async () => {
    vi.mocked(share().status).mockResolvedValue({ kind: "ready", link: null });
    vi.mocked(share().publish).mockRejectedValue(
      new Error("Couldn’t publish. Check your connection and try again."),
    );
    await openShare();
    fireEvent.click(screen.getByRole("button", { name: "Publish link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t publish.");
  });
});
