import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRepositoryState } from "../../../shared/artifact-repository";
import { setUpAppTest } from "../app-test-harness";
import { ArtifactRepository } from "./ArtifactRepository";
import { RepositoryMode } from "./conversation/RepositoryMode";

const repo = () => window.openbot.repository;
const at = (state: ArtifactRepositoryState) => ({ state, versionId: "v2" });

describe("the artifact's repository line", () => {
  beforeEach(() => {
    setUpAppTest();
    // Dialogs share one overlay layer that outlives a test's render; start without it.
    document.getElementById("zb-kit-layer")?.remove();
  });

  it("shows nothing when the artifact has no repository", async () => {
    const { container } = render(() => <ArtifactRepository artifactId="a1" />);
    await waitFor(() => expect(repo().state).toHaveBeenCalledWith("a1"));
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["written", "Saved to the repository"],
    ["pending", "Waiting to save"],
    ["partial", "Saved without files over 1 MB"],
    ["held_secret", "Not saved: may contain a secret"],
    ["from_repository", "From the repository"],
  ] as const)("says %s", async (state, text) => {
    vi.mocked(repo().state).mockResolvedValue(at(state));
    render(() => <ArtifactRepository artifactId="a1" />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    const offersAdd = state === "pending";
    expect(screen.queryByRole("button", { name: "Add to the repository" }) !== null).toBe(
      offersAdd,
    );
  });

  it("adds a local artifact to the repository", async () => {
    vi.mocked(repo().state).mockResolvedValue(at("local"));
    vi.mocked(repo().add).mockResolvedValue(at("written"));
    render(() => <ArtifactRepository artifactId="a1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to the repository" }));
    expect(await screen.findByText("Saved to the repository")).toBeInTheDocument();
    expect(repo().add).toHaveBeenCalledWith({
      artifactId: "a1",
      versionId: "v2",
      allowHeld: false,
    });
  });

  it("saves a held version only after confirming", async () => {
    vi.mocked(repo().state).mockResolvedValue(at("held_secret"));
    vi.mocked(repo().add).mockResolvedValue(at("written"));
    render(() => <ArtifactRepository artifactId="a1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Save anyway" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save anyway?" });
    expect(dialog).toHaveTextContent("Its files will be written into your project’s repository.");
    expect(repo().add).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Save anyway" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText("Saved to the repository")).toBeInTheDocument();
    expect(repo().add).toHaveBeenCalledWith({ artifactId: "a1", versionId: "v2", allowHeld: true });
  });

  it("keeps the dialog open when the version is still held", async () => {
    vi.mocked(repo().state).mockResolvedValue(at("held_secret"));
    vi.mocked(repo().add).mockResolvedValue(at("held_secret"));
    render(() => <ArtifactRepository artifactId="a1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Save anyway" }));
    await screen.findByRole("alertdialog", { name: "Save anyway?" });
    const buttons = screen.getAllByRole("button", { name: "Save anyway" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText(/another saved version/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Save anyway?" })).toBeInTheDocument();
  });

  it("shows why saving failed", async () => {
    vi.mocked(repo().state).mockResolvedValue(at("local"));
    vi.mocked(repo().add).mockRejectedValue(
      new Error("Couldn’t save to the repository. Try again."),
    );
    render(() => <ArtifactRepository artifactId="a1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to the repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save to the repository.");
  });
});

describe("the project's repository setting", () => {
  beforeEach(() => setUpAppTest());

  it("is hidden for a chat without a repository", async () => {
    const { container } = render(() => <RepositoryMode botId="t1" />);
    await waitFor(() => expect(repo().mode).toHaveBeenCalledWith("t1"));
    expect(container).toBeEmptyDOMElement();
  });

  it("changes when the project's artifacts are saved", async () => {
    vi.mocked(repo().mode).mockResolvedValue({ projectId: "p1", mode: "on_accept" });
    render(() => <RepositoryMode botId="t1" />);
    const select = await screen.findByRole("button", { name: /Save artifacts to the repository/ });
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Every save" }));
    await waitFor(() =>
      expect(repo().setMode).toHaveBeenCalledWith({ projectId: "p1", mode: "every_save" }),
    );
  });
});
