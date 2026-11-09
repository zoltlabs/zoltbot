import { expect, it } from "vitest";
import { prepareRevisionTarget, revisionBase, revisionTarget } from "./revision-target.js";
import { artifactFixture } from "./test-fixture.js";

it("pins revisions to an available exact version and rejects unsupported sessions and unavailable targets", async () => {
  const f = await artifactFixture();
  try {
    const old = await f.save("<h1>Original</h1>");
    await f.save("<h1>Current</h1>");
    const target = { artifactId: old.artifactId, versionId: old.versionId };
    expect(revisionTarget(f.store, "thread", target).version.id).toBe(old.versionId);
    const fragment = await prepareRevisionTarget(f.store, "thread", target, "session");
    expect(fragment.reference).toContain(old.versionId);
    expect(fragment.text).toContain("untrusted reference");
    expect(revisionBase(f.store, "turn", old.artifactId)).toBeUndefined();
    f.change({
      type: "create",
      kind: "item",
      value: {
        id: "targeted-input",
        threadId: "thread",
        turnId: "turn",
        seq: 100,
        kind: "user",
        body: { mode: "queue", queueState: "sent", artifactTarget: target },
        createdAt: "2026-11-06T12:00:00Z",
        updatedAt: "2026-11-06T12:00:00Z",
      },
    });
    const revised = await f.save("<h1>Revision from original</h1>");
    expect(f.store.record("artifactVersion", revised.versionId)?.baseVersionId).toBe(old.versionId);
    f.store.rebuild();
    expect(f.store.record("artifactVersion", revised.versionId)?.baseVersionId).toBe(old.versionId);
    f.change({
      type: "create",
      kind: "item",
      value: {
        id: "other-input",
        threadId: "thread",
        turnId: "turn",
        seq: 101,
        kind: "user",
        body: { text: "Ambiguous additional input" },
        createdAt: "2026-11-06T12:00:00Z",
        updatedAt: "2026-11-06T12:00:00Z",
      },
    });
    expect(revisionBase(f.store, "turn", old.artifactId)).toBeUndefined();

    expect(() => revisionTarget(f.store, "other-thread", target)).toThrow(
      "artifact_target_chat_required",
    );
    f.change({
      type: "update",
      kind: "artifactVersion",
      id: old.versionId,
      changes: { metadataOnly: true },
    });
    await expect(prepareRevisionTarget(f.store, "thread", target)).rejects.toThrow(
      "artifact_target_unavailable",
    );
  } finally {
    await f.close();
  }
});
