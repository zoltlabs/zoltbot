import { createTask, handle, startTask } from "@zoltbot/core";
import { migrateDriver, Store } from "@zoltbot/store/portable";
import { seedCell } from "../src/seed.js";
import { CellSqlDriver } from "../src/sql-driver.js";

export const epoch = Date.parse("2026-11-11T00:00:00Z");
export function sandboxFixture(storage: DurableObjectStorage, running = false, taskId = "task") {
  const driver = new CellSqlDriver(storage);
  migrateDriver(driver);
  const store = new Store(driver);
  seedCell(store);
  const context = {
    commandId: "project",
    at: new Date(epoch).toISOString(),
    actor: { kind: "human" as const, id: "member" },
  };
  store.dispatch(
    "project",
    (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "project",
          value: {
            id: "project",
            name: "Repository",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 0,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: context.at,
            cloud: { repository: "example/repository", defaultBranch: "main", setupScript: "" },
          },
        },
        context,
      ),
    { scope: { projectId: "project" } },
  );
  store.dispatch(
    taskId,
    (state) => {
      const outcome = createTask(
        { ...state, agent: [store.record("agent", "cloud-claude") as Record<string, unknown>] },
        {
          id: taskId,
          title: "Test",
          brief: "Test",
          profileId: "cloud-claude",
          node: { type: "project", id: "project" },
        },
        { ...context, commandId: taskId },
      );
      return {
        ...outcome,
        events: outcome.events.map((event) =>
          event.aggregateType === "task"
            ? {
                ...event,
                payload: {
                  ...(event.payload as object),
                  location: "sandbox",
                  executionLocation: "sandbox",
                },
              }
            : event,
        ),
      };
    },
    { scope: { projectId: "project" } },
  );
  if (running)
    store.dispatch(
      `start:${taskId}`,
      (state) =>
        startTask(state, taskId, 1, {
          ...context,
          commandId: `start:${taskId}`,
          actor: { kind: "system", id: "cell" },
        }),
      { scope: { taskId } },
    );
  return store;
}
