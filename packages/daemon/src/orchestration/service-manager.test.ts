import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "../private-input.js";
import { orchestrationService } from "./service.js";

it("sends a manager chat's build request to the manager instead of a phased run", async () => {
  const f = await runtimeFixture();
  const context = (commandId: string) => ({
    commandId,
    at,
    actor: { kind: "human" as const, id: "owner" },
  });
  f.store.dispatch("project", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "project",
        value: {
          id: "p",
          name: "Project",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 3,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      },
      context("project"),
    ),
  );
  f.store.dispatch("bind:thread", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "thread",
        id: "thread",
        changes: { projectId: "p", kind: "manager" },
        confirmed: true,
      },
      context("bind:thread"),
    ),
  );
  let routerCalls = 0;
  const service = orchestrationService({
    store: f.store,
    privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
    publish() {},
    async schedule() {},
    async prepare() {},
    async cancel() {},
    async forward() {},
    async router() {
      routerCalls++;
      return undefined;
    },
  });
  const params = {
    threadId: "thread",
    input: [{ type: "text", text: "Create agents for SEO, ads and product" }],
    mode: "queue",
  };
  expect(await service.api("turn.send", params, "manager-build")).toBeUndefined();
  expect(routerCalls).toBe(0);
  expect(f.store.snapshot(["orchestration"]).orchestration ?? []).toHaveLength(0);
});
