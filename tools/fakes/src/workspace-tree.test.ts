import path from "node:path";
import { type Daemon, startDaemon } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { DaemonClient } from "../../../packages/ui/src/connection.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

it("persists Zolt directions, a confirmed manager and independent child chats through RPC, rebuild and restart", async () => {
  const f = await runtimeFixture();
  const dataDir = path.join(f.root, "daemon");
  let daemon: Daemon = await startDaemon({ dataDir });
  let client: DaemonClient | undefined;
  try {
    for (const kind of ["agentDefinition", "agent"] as const)
      for (const value of f.store.snapshot()[kind] ?? [])
        daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
    client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
    await client.start();
    const project = {
      id: "zolt",
      name: "Zolt",
      goal: "Build carefully",
      instructions: "Keep user data private",
      constraints: "Local first",
      roots: [],
      hierarchyDepth: 3,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    };
    await client.call("project.create", { value: project }, "project");
    const product = {
      id: "product",
      projectId: "zolt",
      name: "Zolt Product",
      label: "Direction",
      goal: "Product",
      instructions: "Verify changes",
      depth: 1,
      archived: false,
      createdAt: at,
    };
    await client.call("subproject.create", { value: product }, "product");
    for (const [id, name] of [
      ["food", "Food logging"],
      ["reliability", "Reliability"],
    ])
      await client.call(
        "subproject.create",
        { value: { ...product, id, parentId: "product", name, depth: 2 } },
        `direction:${id}`,
      );
    const manager = {
      id: "manager",
      agentId: "profile",
      projectId: "zolt",
      node: { type: "subproject", id: "food" },
      kind: "manager",
      title: "Food logging manager",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    };
    await expect(client.call("thread.create", { value: manager }, "unconfirmed")).rejects.toThrow(
      "confirmation_required",
    );
    expect(daemon.store.receipt("unconfirmed")).toBeUndefined();
    await client.call("thread.create", { value: manager, confirmed: true }, "manager");
    const before = daemon.store.lastSeq();
    await client.call("thread.create", { value: manager, confirmed: false }, "manager");
    expect(daemon.store.lastSeq()).toBe(before);
    await expect(
      client.call(
        "thread.create",
        { value: { ...manager, id: "duplicate" }, confirmed: true },
        "duplicate-manager",
      ),
    ).rejects.toThrow("manager_already_assigned");
    for (const [id, title] of [
      ["nutrients", "Nutrient totals"],
      ["search", "Meal search"],
    ])
      await client.call(
        "thread.create",
        { value: { ...manager, id, title, kind: "side" } },
        `chat:${id}`,
      );
    const state = daemon.store.snapshot();
    expect(state.subproject?.map((row) => row.name).sort()).toEqual([
      "Food logging",
      "Reliability",
      "Zolt Product",
    ]);
    expect(state.thread?.filter((row) => row.kind === "manager")).toHaveLength(1);
    expect(state.thread?.filter((row) => row.kind === "side")).toHaveLength(2);
    expect(state.session ?? []).toHaveLength(0);
    expect(state.turn ?? []).toHaveLength(0);
    daemon.store.rebuild();
    expect(daemon.store.snapshot()).toEqual(state);
    client.stop();
    await daemon.close();
    daemon = await startDaemon({ dataDir });
    client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
    await client.start();
    expect(client.state.snapshot.entities.thread).toEqual(state.thread);
    expect(client.state.snapshot.entities.subproject).toEqual(state.subproject);
  } finally {
    client?.stop();
    await daemon.close();
    f.close();
  }
});
