import { access, chmod, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { artifactRecord, versionDetail } from "./model.js";
import { indexArtifactRepository } from "./repository-index.js";
import { writeRepositoryVersion } from "./repository-write.js";
import { saveArtifact } from "./save.js";
import { artifactFixture } from "./test-fixture.js";

it("leaves a no-save workspace untouched, writes reviewed source without database ids, imports into another project and retains unavailable history", async () => {
  const f = await artifactFixture(),
    clone = await artifactFixture();
  try {
    await expect(access(path.join(f.workspace, ".zoltbot"))).rejects.toThrow();
    const first = await f.save("<h1>One</h1>");
    await expect(access(path.join(f.workspace, ".zoltbot"))).rejects.toThrow();
    await writeRepositoryVersion(f.store, first.artifactId, first.versionId);
    const second = await f.save("<h1>Two</h1>");
    await writeRepositoryVersion(f.store, second.artifactId, second.versionId);
    const base = path.join(f.workspace, ".zoltbot/artifacts/sample");
    const descriptor = await readFile(path.join(base, "artifact.json"), "utf8");
    expect(descriptor).not.toContain(first.artifactId);
    expect(descriptor).not.toContain(first.versionId);
    expect(await readFile(path.join(base, "current/index.html"), "utf8")).toBe("<h1>Two</h1>");
    expect(await readdir(path.join(base, "versions"))).toHaveLength(2);
    const result = await indexArtifactRepository(clone.context, "another-project", f.workspace);
    expect(result).toEqual({ indexed: 1, issues: [] });
    const artifact = clone.store.snapshot(["artifact"]).artifact?.[0];
    expect(artifact?.id).not.toBe(first.artifactId);
    const versions = clone.store.snapshot(["artifactVersion"]).artifactVersion ?? [];
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => v.metadataOnly)).toHaveLength(1);
    expect(artifactRecord(clone.store, String(artifact?.id)).repositoryState).toBe(
      "from_repository",
    );
    expect(versionDetail(clone.store, String(artifact?.currentVersionId)).manifest.entry).toBe(
      "index.html",
    );
  } finally {
    f.close();
    clone.close();
  }
});
it("rejects committed symlinks, conflicts, corrupted files and supplied database ids without importing outside files", async () => {
  const f = await artifactFixture(),
    clone = await artifactFixture();
  try {
    const saved = await f.save("<h1>Safe</h1>");
    await writeRepositoryVersion(f.store, saved.artifactId, saved.versionId);
    const base = path.join(f.workspace, ".zoltbot/artifacts/sample");
    const original = await readFile(path.join(base, "artifact.json"));
    await writeFile(path.join(base, "artifact.json"), "<<<<<<< conflict\n");
    expect(
      (await indexArtifactRepository(clone.context, "isolated-project", f.workspace)).issues,
    ).toHaveLength(1);
    await writeFile(path.join(base, "artifact.json"), original);
    await writeFile(path.join(base, "current/index.html"), "<h1>Changed</h1>");
    expect(
      (await indexArtifactRepository(clone.context, "isolated-project", f.workspace)).issues,
    ).toHaveLength(1);
    await chmod(path.join(base, "current/index.html"), 0o644);
    const target = path.join(f.root, "outside.txt");
    await writeFile(target, "outside fixture data");
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(base, "current/index.html"));
    await symlink(target, path.join(base, "current/index.html"));
    expect(
      (await indexArtifactRepository(clone.context, "isolated-project", f.workspace)).issues,
    ).toHaveLength(1);
    expect(clone.store.snapshot(["artifact"]).artifact ?? []).toHaveLength(0);
    await expect(
      writeRepositoryVersion(f.store, saved.artifactId, saved.versionId),
    ).resolves.toMatchObject({ partial: false });
    // The generated writer replaces only its own current directory, never a symlink target.
    expect(await readFile(target, "utf8")).toBe("outside fixture data");
    const bad = { ...JSON.parse(original.toString()), id: "another-project-row" };
    await writeFile(path.join(base, "artifact.json"), JSON.stringify(bad));
    expect(
      (await indexArtifactRepository(clone.context, "isolated-project", f.workspace)).issues,
    ).toHaveLength(1);
  } finally {
    f.close();
    clone.close();
  }
});
it("keeps secret files on the Mac until explicit human override and does not follow repository directory links", async () => {
  const f = await artifactFixture();
  try {
    const saved = await f.save("Bearer synthetic-fixture-marker");
    await expect(
      writeRepositoryVersion(f.store, saved.artifactId, saved.versionId),
    ).rejects.toThrow("held");
    await expect(access(path.join(f.workspace, ".zoltbot"))).rejects.toThrow();
    await writeRepositoryVersion(f.store, saved.artifactId, saved.versionId, true);
    const second = await artifactFixture();
    try {
      const outside = path.join(f.root, "outside");
      await mkdir(outside);
      const version = await second.save("<h1>Safe</h1>");
      await symlink(outside, path.join(second.workspace, ".zoltbot"));
      await expect(
        writeRepositoryVersion(second.store, version.artifactId, version.versionId),
      ).rejects.toThrow();
      expect(await readdir(outside)).toHaveLength(0);
    } finally {
      second.close();
    }
  } finally {
    f.close();
  }
});

it("persists every-save work and holds newly private content before repository writes", async () => {
  const { artifactRepositorySync } = await import("./repository-sync.js");
  const f = await artifactFixture();
  const worker = artifactRepositorySync(f.store, {
    publish() {},
    pollMs: 60000,
    privateCheck: async (text) => {
      try {
        await f.context.privacy.prepareData(text);
        return false;
      } catch {
        return true;
      }
    },
  });
  try {
    f.change({
      type: "update",
      kind: "project",
      id: "artifact-project",
      changes: { artifactRepositoryMode: "every_save" },
    });
    const first = await f.save("<h1>Public fixture</h1>");
    await expect(access(path.join(f.workspace, ".zoltbot"))).rejects.toThrow();
    await worker.work();
    expect(artifactRecord(f.store, first.artifactId).repositoryState).toBe("written");
    await f.save("<h1>fixture-private-value</h1>");
    f.context.privacy.remember("fixture-private-value");
    await worker.work();
    expect(artifactRecord(f.store, first.artifactId).repositoryState).toBe("held_secret");
    expect(
      await readFile(
        path.join(f.workspace, ".zoltbot/artifacts/sample/current/index.html"),
        "utf8",
      ),
    ).toBe("<h1>Public fixture</h1>");
    const { artifactTools } = await import("./tools.js");
    expect(
      await artifactTools(f.context).call({
        actor: f.actor,
        idempotencyKey: "read-held",
        arguments: { action: "read", key: "sample" },
      }),
    ).toMatchObject({ held: true });
    expect(
      f.store.database
        .prepare("SELECT id FROM artifacts_fts WHERE artifacts_fts MATCH 'private'")
        .all(),
    ).toHaveLength(0);
  } finally {
    await worker.close();
    f.close();
  }
});

it("keeps files above the repository limit local and imports their bounded metadata", async () => {
  const f = await artifactFixture(),
    clone = await artifactFixture();
  try {
    await mkdir(f.binding.stagingRoot, { recursive: true });
    await writeFile(
      path.join(f.binding.stagingRoot, "index.html"),
      `<p>${"x".repeat(1024 * 1024)}</p>`,
    );
    const saved = (await saveArtifact(f.context, {
      actor: f.actor,
      idempotencyKey: "large-staged",
      arguments: {
        key: "sample",
        title: "Sample",
        kind: "page",
        source: { dir: f.binding.stagingRoot },
      },
    })) as { artifactId: string; versionId: string };
    const written = await writeRepositoryVersion(f.store, saved.artifactId, saved.versionId);
    expect(written).toMatchObject({ partial: true, missingFiles: ["index.html"] });
    await expect(
      access(path.join(f.workspace, ".zoltbot/artifacts/sample/current/index.html")),
    ).rejects.toThrow();
    expect(await indexArtifactRepository(clone.context, "clone-project", f.workspace)).toEqual({
      indexed: 1,
      issues: [],
    });
    expect(clone.store.snapshot(["artifactVersion"]).artifactVersion?.[0]?.metadataOnly).toBe(true);
  } finally {
    f.close();
    clone.close();
  }
});

it("hydrates unavailable imported history and marks invalid repository metadata until repaired", async () => {
  const f = await artifactFixture(),
    clone = await artifactFixture();
  try {
    const first = await f.save("<h1>First fixture</h1>");
    await writeRepositoryVersion(f.store, first.artifactId, first.versionId);
    const second = await f.save("<h1>Second fixture</h1>");
    await writeRepositoryVersion(f.store, second.artifactId, second.versionId);
    await indexArtifactRepository(clone.context, "clone-project", f.workspace);
    const versions = clone.store.snapshot(["artifactVersion"]).artifactVersion ?? [];
    const unavailable = versions.find((v) => v.metadataOnly);
    expect(unavailable).toBeDefined();
    await writeRepositoryVersion(f.store, first.artifactId, first.versionId);
    expect(
      (await indexArtifactRepository(clone.context, "clone-project", f.workspace)).issues,
    ).toEqual([]);
    expect(clone.store.record("artifactVersion", String(unavailable?.id))?.metadataOnly).toBe(
      false,
    );
    const descriptor = path.join(f.workspace, ".zoltbot/artifacts/sample/artifact.json");
    const good = await readFile(descriptor);
    await writeFile(descriptor, "<<<<<<< fixture conflict\n");
    expect(
      (await indexArtifactRepository(clone.context, "clone-project", f.workspace)).issues,
    ).toHaveLength(1);
    expect(clone.store.snapshot(["artifact"]).artifact?.[0]?.state).toBe("invalid_repository");
    await writeFile(descriptor, good);
    await indexArtifactRepository(clone.context, "clone-project", f.workspace);
    expect(clone.store.snapshot(["artifact"]).artifact?.[0]?.state).toBe("active");
  } finally {
    f.close();
    clone.close();
  }
});

it("holds sensitive metadata without leaking it or leaving staged files behind", async () => {
  const f = await artifactFixture();
  try {
    f.context.privacy.remember("fixture-private-title");
    await mkdir(f.binding.stagingRoot, { recursive: true });
    await writeFile(path.join(f.binding.stagingRoot, "index.html"), "<h1>Safe body</h1>");
    const saved = (await saveArtifact(f.context, {
      actor: f.actor,
      idempotencyKey: "private-metadata",
      arguments: {
        key: "safe-key",
        title: "fixture-private-title",
        kind: "page",
        source: { dir: f.binding.stagingRoot },
      },
    })) as { artifactId: string; versionId: string; held: boolean };
    expect(saved.held).toBe(true);
    expect(f.store.record("artifact", saved.artifactId)?.title).toBe("Held artifact");
    expect(JSON.stringify(f.store.snapshot())).not.toContain("fixture-private-title");
    await expect(access(f.binding.stagingRoot)).rejects.toThrow();
    await expect(
      writeRepositoryVersion(f.store, saved.artifactId, saved.versionId),
    ).rejects.toThrow("held");
    const rawKey = `sk-${"syntheticfixture".repeat(2)}`;
    const keyed = await f.save("<h1>Safe body</h1>", rawKey);
    const artifact = artifactRecord(f.store, keyed.artifactId);
    expect(artifact.key).toMatch(/^held-[a-f0-9]{32}$/);
    expect(JSON.stringify(f.store.snapshot())).not.toContain(rawKey);
    expect((await f.save("<h1>Safe body</h1>", rawKey)).artifactId).toBe(keyed.artifactId);
  } finally {
    f.close();
  }
});

it("rescans portable metadata and starred content against fresh private context before writing", async () => {
  for (const subject of ["metadata", "starred"] as const) {
    const f = await artifactFixture();
    try {
      const first = await f.save("<h1>fixture-star-private-value</h1>");
      const current = await f.save("<h1>Public current</h1>");
      f.change({
        type: "update",
        kind: "artifact",
        id: current.artifactId,
        changes: { starredVersionIds: [first.versionId] },
      });
      f.context.privacy.remember(subject === "metadata" ? "Sample" : "fixture-star-private-value");
      const privateCheck = async (text: string) => {
        try {
          await f.context.privacy.prepareData(text);
          return false;
        } catch {
          return true;
        }
      };
      await expect(
        writeRepositoryVersion(
          f.store,
          current.artifactId,
          current.versionId,
          false,
          undefined,
          privateCheck,
        ),
      ).rejects.toThrow("held");
      await expect(access(path.join(f.workspace, ".zoltbot"))).rejects.toThrow();
      if (subject === "starred") {
        // Approving the current version cannot implicitly approve a different starred version.
        await expect(
          writeRepositoryVersion(
            f.store,
            current.artifactId,
            current.versionId,
            true,
            undefined,
            privateCheck,
          ),
        ).rejects.toThrow("held");
        await expect(access(path.join(f.workspace, ".zoltbot"))).rejects.toThrow();
      }
    } finally {
      f.close();
    }
  }
});
