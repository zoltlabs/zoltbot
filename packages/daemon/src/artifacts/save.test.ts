import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Command, handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { startDaemon } from "../api.js";
import { PrivateInputGuard } from "../private-input.js";
import { createArtifactBinding } from "./binding.js";
import { artifactRecord, artifactVersion, versionDetail } from "./model.js";
import { saveArtifact } from "./save.js";
import { artifactTools } from "./tools.js";

it("saves immutable versions, reuses current content, advances reverts, clears staging, and rebuilds metadata without leaking manifests", async () => {
  const f = await runtimeFixture();
  const daemon = await startDaemon({ dataDir: f.root });
  daemon.store.dispatch("copy-fixture", () => ({ events: f.store.eventsSince(0), result: {} }));
  const store = daemon.store;
  const binding = createArtifactBinding(f.root, f.root);
  let n = 0;
  const change = (command: Command) => {
    const commandId = `artifact-seed-${++n}`;
    store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "fixture" } }),
    );
  };
  change({ type: "transition", kind: "session", id: "session", to: "ready" });
  change({ type: "transition", kind: "session", id: "session", to: "running" });
  change({
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  change({
    type: "create",
    kind: "settings",
    value: {
      key: "runtime.configuration.session",
      value: { launchManifest: { artifact: binding } },
    },
  });
  const context = {
    store,
    privacy: new PrivateInputGuard({ store, publish() {} }),
    publish() {},
    async wake() {},
  };
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  const save = (html: string, id: string) =>
    saveArtifact(context, {
      actor,
      idempotencyKey: id,
      arguments: {
        key: "sample",
        title: "Sample",
        kind: "page",
        source: { files: [{ path: "index.html", text: html }] },
      },
    });
  try {
    const first = (await save("<h1>First</h1>", "one")) as {
      artifactId: string;
      versionId: string;
      number: number;
    };
    expect(first.number).toBe(1);
    await expect(save("<h1>Conflicting replay</h1>", "one")).rejects.toThrow(
      "command_receipt_conflict",
    );
    expect(await save("<h1>First</h1>", "one")).toEqual(first);
    expect(await save("<h1>First</h1>", "duplicate")).toMatchObject({ number: 1, unchanged: true });
    expect(await save("<h1>Second</h1>", "two")).toMatchObject({
      artifactId: first.artifactId,
      number: 2,
    });
    const reverted = (await save("<h1>First</h1>", "three")) as { versionId: string };
    expect(artifactVersion(store, reverted.versionId).number).toBe(3);
    expect(artifactVersion(store, reverted.versionId).manifestHash).toBe(
      artifactVersion(store, first.versionId).manifestHash,
    );
    expect(artifactRecord(store, first.artifactId).currentVersionId).toBe(reverted.versionId);
    expect(JSON.stringify(store.snapshot())).not.toContain("<h1>");
    store.rebuild();
    expect(versionDetail(store, first.versionId).manifest.files).toHaveLength(1);
    expect(
      store.database
        .prepare("SELECT id FROM artifacts_fts WHERE artifacts_fts MATCH 'First'")
        .all(),
    ).toHaveLength(1);
    await mkdir(binding.stagingRoot, { recursive: true });
    await writeFile(path.join(binding.stagingRoot, "index.html"), "<h1>Staged</h1>");
    await saveArtifact(context, {
      actor,
      idempotencyKey: "staged",
      arguments: {
        key: "sample",
        title: "Sample",
        kind: "page",
        source: { dir: binding.stagingRoot },
      },
    });
    await expect(access(path.join(f.root, ".zoltbot"))).rejects.toThrow();
    expect(
      await artifactTools(context).call({
        actor,
        idempotencyKey: "list",
        arguments: { action: "list" },
      }),
    ).toMatchObject({ items: [{ key: "sample" }] });
    await expect(
      saveArtifact(context, {
        actor: { ...actor, threadId: "other" },
        idempotencyKey: "bad",
        arguments: {},
      }),
    ).rejects.toThrow("authority");
    const hash = versionDetail(store, first.versionId).manifest.files[0]?.hash;
    const url = `${daemon.url.replace("ws:", "http:")}/artifact-blob/${hash}`;
    expect((await fetch(url)).status).toBe(403);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<h1>First</h1>");
    expect(
      (
        await fetch(url, {
          headers: { Authorization: `Bearer ${daemon.token}`, Origin: "https://invalid.example" },
        })
      ).status,
    ).toBe(403);
  } finally {
    await daemon.close();
    f.close();
  }
});
