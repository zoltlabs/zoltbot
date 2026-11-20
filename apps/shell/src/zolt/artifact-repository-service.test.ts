import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_REPOSITORY_CHANNELS as C } from "../shared/artifact-repository";
import { artifactRepositoryHandlers } from "./artifact-repository-service";

type Row = Record<string, unknown>;
function client(entities: Record<string, Row[]>, answer: unknown = { root: "/r", partial: false }) {
  return {
    rows: (kind: string) => entities[kind] ?? [],
    call: vi.fn(async () => answer),
  };
}
const artifact = (changes: Row = {}) => ({
  id: "a1",
  threadId: "t1",
  currentVersionId: "v2",
  state: "active",
  repositoryRoot: "/repo",
  repositoryState: "local",
  ...changes,
});

describe("artifact repository handlers", () => {
  it("reports the state only for an artifact with a repository", () => {
    const handlers = artifactRepositoryHandlers(
      client({ artifact: [artifact(), artifact({ id: "a2", repositoryRoot: undefined })] }),
    );
    expect(handlers[C.artifactRepositoryState]("a1")).toEqual({ state: "local", versionId: "v2" });
    expect(handlers[C.artifactRepositoryState]("a2")).toBeNull();
    expect(handlers[C.artifactRepositoryState]("missing")).toBeNull();
    const asked = artifactRepositoryHandlers(
      client({
        artifact: [artifact({ projectId: "p1", repositoryState: "pending" })],
        project: [{ id: "p1", artifactRepositoryMode: "off" }],
      }),
    );
    expect(asked[C.artifactRepositoryState]("a1")).toMatchObject({ state: "local" });
  });

  it("adds a version, and reads a held answer as held", async () => {
    const fake = client({ artifact: [artifact()] });
    const handlers = artifactRepositoryHandlers(fake);
    expect(
      await handlers[C.artifactRepositoryAdd]({
        artifactId: "a1",
        versionId: "v2",
        allowHeld: false,
      }),
    ).toEqual({ state: "written", versionId: "v2" });
    expect(fake.call).toHaveBeenCalledWith(
      "artifact.add_to_repository",
      { id: "a1", versionId: "v2", allowHeld: false },
      expect.any(String),
    );
    fake.call.mockResolvedValue({ held: true });
    expect(
      await handlers[C.artifactRepositoryAdd]({
        artifactId: "a1",
        versionId: "v2",
        allowHeld: false,
      }),
    ).toMatchObject({ state: "held_secret" });
    fake.call.mockRejectedValue(new Error("artifact_files_unavailable"));
    await expect(
      handlers[C.artifactRepositoryAdd]({ artifactId: "a1", versionId: "v2", allowHeld: false }),
    ).rejects.toThrow("aren’t on this Mac");
    fake.call.mockRejectedValue(new Error("daemon_down"));
    await expect(
      handlers[C.artifactRepositoryAdd]({ artifactId: "a1", versionId: "v2", allowHeld: true }),
    ).rejects.toThrow("Couldn’t save to the repository. Try again.");
  });

  it("reads and sets a chat's project mode", async () => {
    const fake = client({
      thread: [
        { id: "t1", projectId: "p1" },
        { id: "t2", projectId: "p2" },
      ],
      project: [
        { id: "p1", roots: [{ path: "/repo", repoRoot: "/repo" }] },
        { id: "p2", roots: [{ path: "/notes" }], artifactRepositoryMode: "every_save" },
      ],
    });
    const handlers = artifactRepositoryHandlers(fake);
    expect(handlers[C.artifactRepositoryMode]("t1")).toEqual({
      projectId: "p1",
      mode: "on_accept",
    });
    expect(handlers[C.artifactRepositoryMode]("t2")).toBeNull();
    await handlers[C.artifactRepositorySetMode]({ projectId: "p1", mode: "off" });
    expect(fake.call).toHaveBeenCalledWith(
      "project.update",
      { id: "p1", changes: { artifactRepositoryMode: "off" } },
      expect.any(String),
    );
    await expect(
      handlers[C.artifactRepositorySetMode]({ projectId: "p1", mode: "sometimes" }),
    ).rejects.toThrow("Couldn’t change when artifacts are saved.");
  });
});
