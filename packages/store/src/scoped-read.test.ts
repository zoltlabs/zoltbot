import { createTask, handle } from "@zoltbot/core";
import type { EntityKind } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";

it("reads just one project or task, including transcript and referenced configuration", async () => {
  const f = await runtimeFixture();
  const at = "2026-11-11T00:00:00Z";
  const create = (kind: EntityKind, value: Record<string, unknown>) => {
    const commandId = `create:${kind}:${value.id}`;
    f.store.dispatch(commandId, (state) =>
      handle(
        state,
        { type: "create", kind, value },
        {
          commandId,
          at,
          actor: { kind: "human", id: "local-owner" },
        },
      ),
    );
  };
  try {
    for (const id of ["one", "other"]) {
      create("project", {
        id,
        name: id,
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth: 0,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: at,
      });
      for (const suffix of ["a", "b"]) {
        const taskId = `${id}-${suffix}`;
        f.store.dispatch(taskId, (state) =>
          createTask(
            state,
            {
              id: taskId,
              title: taskId,
              brief: "Synthetic task",
              profileId: "profile",
              node: { type: "project", id },
            },
            { commandId: taskId, at, actor: { kind: "human", id: "local-owner" } },
          ),
        );
        create("item", {
          id: `${taskId}:item`,
          threadId: `${taskId}:thread`,
          seq: 1,
          kind: "message",
          body: { text: taskId },
          createdAt: at,
          updatedAt: at,
        });
      }
    }
    vi.spyOn(f.store, "snapshot").mockImplementation(() => {
      throw new Error("unscoped_read");
    });
    const project = f.store.read({ projectId: "one" });
    expect(project.project?.map((r) => r.id)).toEqual(["one"]);
    expect(project.task?.map((r) => r.id)).toEqual(["one-a", "one-b"]);
    expect(project.item?.map((r) => r.id)).toEqual(["one-a:item", "one-b:item"]);
    expect(project.session).toBeUndefined();
    const metadata = f.store.read({ projectId: "one" }, ["task"]);
    expect(metadata.item).toBeUndefined();
    expect(metadata.task).toHaveLength(2);
    expect(f.store.read({ projectId: "one" }, [])).toEqual({});
    const task = f.store.read({ taskId: "one-a" });
    expect(task.task?.map((r) => r.id)).toEqual(["one-a"]);
    expect(task.item?.map((r) => r.id)).toEqual(["one-a:item"]);
    expect(task.project?.map((r) => r.id)).toEqual(["one"]);
    expect(task.agent?.map((r) => r.id)).toEqual(["profile"]);
    expect(task.agentDefinition?.map((r) => r.id)).toEqual(["fake"]);
    expect(f.store.read({ taskId: "missing" })).toEqual({});
    const receipt = f.store.dispatch(
      "scoped",
      (state) => ({ events: [], result: state.task?.map((r) => r.id) }),
      { scope: { taskId: "one-a" } },
    );
    expect(receipt.result).toEqual(["one-a"]);
  } finally {
    f.close();
  }
});
