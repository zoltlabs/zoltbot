import { handle } from "@zoltbot/core";
import { AT_LIMIT_HOLD, TASK_RUNNING_LIMIT_SETTING } from "@zoltbot/protocol";
import { expect, test } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import type { Redactor } from "./logging.js";
import type { PrivateInputGuard } from "./private-input.js";
import { settingsApi } from "./settings-api.js";
import { taskRunner } from "./task-runner.js";

const owner = { kind: "human", id: "owner" } as const;

/** A project without a code folder, so tasks never wait on each other's folder. */
async function fixture() {
  const f = await runtimeFixture();
  for (const id of ["app", "site"])
    f.store.dispatch(`project:${id}`, (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "project",
          value: {
            id,
            name: id,
            goal: "",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 1,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        { commandId: `project:${id}`, at, actor: owner },
      ),
    );
  f.store.dispatch("profile:other", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "agent",
        value: { ...(state.agent?.find((row) => row.id === "profile") ?? {}), id: "other" },
      },
      { commandId: "profile:other", at, actor: owner },
    ),
  );
  const wakes: string[] = [];
  const runner = taskRunner({
    store: f.store,
    publish() {},
    checkPublic: async () => () => {},
    wake: async (id) => {
      wakes.push(id);
    },
  });
  const create = async (title: string, profileId = "profile", projectId = "app") => {
    await runner.api(
      "task.create",
      { title, brief: "Do it", profileId, node: { type: "project", id: projectId } },
      `create:${title}`,
    );
    await runner.schedule();
  };
  const task = (title: string) =>
    (f.store.snapshot(["task"]).task ?? []).find((row) => row.title === title);
  return { f, runner, wakes, create, task };
}

test("an employee runs two tasks at once and the third waits at its limit", async () => {
  const { f, runner, wakes, create, task } = await fixture();
  try {
    await create("First");
    await create("Second");
    await create("Third");
    await create("Other employee", "other");
    await create("Same profile, other project", "profile", "site");
    expect(task("First")?.state).toBe("running");
    expect(task("Second")?.state).toBe("running");
    expect(task("Third")?.state).toBe("queued");
    expect(task("Third")?.holdReason).toBe(AT_LIMIT_HOLD);
    expect(task("Other employee")?.state).toBe("running");
    expect(task("Same profile, other project")?.state).toBe("running");
    expect(wakes).toHaveLength(4);

    // Stopping a running task frees the slot, and the waiting task starts without its reason.
    await runner.api("task.cancel", { id: task("First")?.id, confirmed: true }, "stop-first");
    await runner.schedule();
    expect(task("First")?.state).toBe("cancelled");
    expect(task("Third")?.state).toBe("running");
    expect(task("Third")?.holdReason).toBeUndefined();
    runner.close();
  } finally {
    f.close();
  }
});

test("the running limit is a setting", async () => {
  const { f, runner, create, task } = await fixture();
  try {
    f.store.dispatch("limit", () => ({
      events: [
        {
          eventId: "limit:0",
          aggregateType: "settings",
          aggregateId: TASK_RUNNING_LIMIT_SETTING,
          type: "settings.created",
          occurredAt: at,
          payload: { key: TASK_RUNNING_LIMIT_SETTING, value: 1 },
        },
      ],
      result: { ok: true },
    }));
    await create("First");
    await create("Second");
    expect(task("First")?.state).toBe("running");
    expect(task("Second")?.state).toBe("queued");
    expect(task("Second")?.holdReason).toBe(AT_LIMIT_HOLD);
    runner.close();
  } finally {
    f.close();
  }
});

test("settings.set accepts a whole number of tasks from 1 to 20 for the running limit", async () => {
  const { f, runner } = await fixture();
  try {
    const api = settingsApi({
      store: f.store,
      privacy: { prepareData: async () => undefined } as unknown as PrivateInputGuard,
      redactor: { text: (value: string) => value, value: <T>(value: T) => value } as Redactor,
      publish() {},
    });
    const set = (value: unknown, id: string) =>
      api("settings.set", { key: TASK_RUNNING_LIMIT_SETTING, value }, id);
    for (const [index, value] of [0, 21, 2.5, "3"].entries())
      await expect(set(value, `bad-${index}`)).rejects.toThrow("invalid_setting");
    await expect(set(4, "good")).resolves.toEqual({ ok: true });
    expect(f.store.snapshot(["settings"]).settings).toContainEqual({
      key: TASK_RUNNING_LIMIT_SETTING,
      value: 4,
    });
    runner.close();
  } finally {
    f.close();
  }
});
