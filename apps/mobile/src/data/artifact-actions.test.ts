import { describe, expect, it } from "vitest";
import { artifactActions, repositoryError } from "./artifact-actions";
import { answerManager } from "./fake-manager";
import type { Snapshot } from "./transport";

const snapshot = (artifact: Record<string, unknown>, settings: Record<string, unknown>[] = []) =>
  ({
    seq: 1,
    entities: {
      artifact: [
        {
          id: "a1",
          threadId: "t1",
          title: "Design",
          state: "active",
          currentVersionId: "v2",
          repositoryRoot: "/repo",
          repositoryState: "local",
          updatedAt: "2026-11-20T00:00:00Z",
          ...artifact,
        },
      ],
      artifactVersion: [{ id: "v2", artifactId: "a1", manifestHash: "h2" }],
      settings,
    },
  }) as unknown as Snapshot;

const share = (manifestHash: string) => ({
  key: "artifact.share.a1",
  value: { id: "c1", manifestHash, visibility: "public", url: "https://zoltbot.example/s/c1" },
});

describe("artifact actions on the phone", () => {
  it("offers Add to repository for a local artifact, with no link yet", () => {
    expect(artifactActions(snapshot({}), "t1")).toEqual([
      {
        artifactId: "a1",
        versionId: "v2",
        title: "Design",
        link: null,
        repository: { line: "", canAdd: true, held: false },
      },
    ]);
  });

  it("reads the Mac's published link and whether it shows the current version", () => {
    const [current] = artifactActions(snapshot({}, [share("h2")]), "t1");
    expect(current?.link).toEqual({
      url: "https://zoltbot.example/s/c1",
      visibility: "public",
      current: true,
    });
    expect(artifactActions(snapshot({}, [share("h1")]), "t1")[0]?.link?.current).toBe(false);
    expect(
      artifactActions(snapshot({}, [{ key: "artifact.share.a1", value: null }]), "t1")[0]?.link,
    ).toBeNull();
  });

  it("shows held and saved states, and nothing without a repository", () => {
    expect(
      artifactActions(snapshot({ repositoryState: "held_secret" }), "t1")[0]?.repository,
    ).toEqual({ line: "Not saved: may contain a secret", canAdd: false, held: true });
    expect(
      artifactActions(snapshot({ repositoryState: "written" }), "t1")[0]?.repository?.line,
    ).toBe("Saved to the repository");
    expect(
      artifactActions(snapshot({ repositoryRoot: undefined }), "t1")[0]?.repository,
    ).toBeNull();
    expect(artifactActions(snapshot({ state: "archived" }), "t1")).toEqual([]);
    const asked = snapshot({ repositoryState: "pending", projectId: "p1" });
    asked.entities.project = [{ id: "p1", artifactRepositoryMode: "off" }];
    expect(artifactActions(asked, "t1")[0]?.repository).toMatchObject({ line: "", canAdd: true });
  });
});

describe("sample mode's Add to repository", () => {
  function store(repositoryState: string) {
    const rows: Record<string, Record<string, unknown>[]> = {
      artifact: [{ id: "a1", repositoryRoot: "/repo", repositoryState }],
    };
    return {
      rows: (kind: string) => rows[kind] ?? [],
      put: (kind: string, row: Record<string, unknown>) => {
        rows[kind] = [...(rows[kind] ?? []).filter((item) => item.id !== row.id), row];
        return row;
      },
      at: () => "2026-11-20T00:00:00.000Z",
    };
  }

  it("writes a local artifact, and keeps a held one held until Save anyway", () => {
    const local = store("local");
    expect(
      answerManager(
        "artifact.add_to_repository",
        { id: "a1", versionId: "v1", allowHeld: false },
        local,
      ),
    ).toEqual({ root: "/repo", partial: false });
    expect(local.rows("artifact")[0]?.repositoryState).toBe("written");
    const held = store("held_secret");
    const add = (allowHeld: boolean) =>
      answerManager("artifact.add_to_repository", { id: "a1", versionId: "v1", allowHeld }, held);
    expect(add(false)).toEqual({ held: true });
    expect(held.rows("artifact")[0]?.repositoryState).toBe("held_secret");
    add(true);
    expect(held.rows("artifact")[0]?.repositoryState).toBe("written");
  });
});

describe("repository errors on the phone", () => {
  it("names a failure that trying again can't fix", () => {
    expect(repositoryError(new Error("artifact_files_unavailable"))).toContain("aren’t on the Mac");
    expect(repositoryError(new Error("timeout"))).toBe(
      "Couldn’t save to the repository. Try again.",
    );
  });
});
