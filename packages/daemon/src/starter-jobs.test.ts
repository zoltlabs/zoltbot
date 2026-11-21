import { handle } from "@zoltbot/core";
import type { Routine } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { taskRunner } from "./task-runner.js";

const now = "2026-11-21T10:00:00.000Z";

it("adds a starter job for a connected app as a paused, read-only routine (D5)", async () => {
  const f = await runtimeFixture();
  const runner = taskRunner({
    store: f.store,
    now: () => now,
    routinePollMs: 60_000,
    publish() {},
    checkPublic: async () => () => {},
  });
  try {
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
            hierarchyDepth: 1,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: now,
          },
        },
        { commandId: "project", at: now, actor: { kind: "human", id: "owner" } },
      ),
    );
    expect(await runner.api("routine.starters", {})).toEqual({ items: [] });
    new ConnectionRegistry(f.store.database).save(
      {
        id: "mail",
        version: 1,
        name: "gmail_mail",
        projectId: "p",
        transport: { kind: "https", url: "https://mail.example.test/mcp" },
        schemaTokens: { value: 100, source: "estimated" },
        source: "catalog:gmail:v1",
        enabled: true,
        profileIds: [],
        credentialStatus: "connected",
        health: "healthy",
      },
      0,
      true,
    );
    expect(await runner.api("routine.starters", {})).toEqual({
      items: [{ id: "weekly-inbox", name: "Weekly inbox summary", projectId: "p" }],
    });
    await expect(
      runner.api(
        "routine.createStarter",
        { jobId: "pull-request-review", profileId: "profile", timezone: "UTC" },
        "gh",
      ),
    ).rejects.toThrow("starter_unavailable");
    const params = { jobId: "weekly-inbox", profileId: "profile", timezone: "Europe/Berlin" };
    const routine = (await runner.api("routine.createStarter", params, "add")) as Routine;
    expect(routine).toMatchObject({
      name: "Weekly inbox summary",
      paused: true,
      permissionCeiling: "read_only",
      schedule: { cron: "0 9 * * 1", timezone: "Europe/Berlin" },
      template: {
        profileId: "profile",
        node: { type: "project", id: "p" },
        inputs: { connections: ["mail"] },
      },
    });
    // Adding it again, or offering it again, changes nothing.
    expect(await runner.api("routine.createStarter", params, "add-again")).toEqual(routine);
    expect(await runner.api("routine.starters", {})).toEqual({ items: [] });
    expect(f.store.snapshot(["routine"]).routine).toHaveLength(1);
    // The owner turns it on from Routines.
    const on = (await runner.api(
      "routine.update",
      { id: routine.id, expectedUpdatedAt: routine.updatedAt, paused: false },
      "on",
    )) as Routine;
    expect(on.paused).toBe(false);
    expect(on.nextRunAt > now).toBe(true);
  } finally {
    runner.close();
    f.close();
  }
});
