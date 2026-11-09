import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { createTask, enforceInjectionBudget } from "@zoltbot/core";
import {
  AgentDefinitionSchema,
  ProfileSchema,
  parse,
  type QueuedInputBody,
  ThreadSchema,
} from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at } from "../../../../tools/fakes/src/runtime-fixture.js";
import { knowledgeLaunch } from "../knowledge-launch.js";
import { artifactDesigner } from "./designer.js";
import { outputFragments } from "./output.js";
import { artifactFixture } from "./test-fixture.js";

it("counts explicit Output metadata and adds the bounded design pointer once without changing frozen instructions", async () => {
  const f = await artifactFixture();
  try {
    f.change({
      type: "create",
      kind: "knowledge",
      value: {
        id: "design-context",
        scope: { type: "project", id: "artifact-project" },
        kind: "preference",
        title: "Visual language",
        body: "Use generous spacing and the local tokens file.",
        tags: [],
        owner: { kind: "human", id: "owner" },
        verification: "human",
        writer: { kind: "human", id: "owner" },
        status: "active",
        sources: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
      },
    });
    f.change({
      type: "update",
      kind: "project",
      id: "artifact-project",
      changes: { artifactDesignContextId: "design-context" },
    });
    const body: QueuedInputBody = {
      input: [{ type: "text", text: "Make a page" }],
      queueState: "queued",
      outputMode: "page",
    };
    const item = { id: "first-output", threadId: "thread", seq: 1 };
    const before = f.store.record("settings", "runtime.configuration.session");
    const fragments = outputFragments(f.store, "session", item, body);
    expect(fragments[0]?.kind).toBe("brief");
    expect(fragments[0]?.text).toContain("id:design-context");
    const planned = enforceInjectionBudget({
      human: body.input,
      fragments,
      estimate: referenceTokenEstimate,
    });
    expect(planned.estimatedTokens).toBeGreaterThan(0);
    expect(planned.estimatedTokens).toBeLessThan(1500);
    expect(f.store.record("settings", "runtime.configuration.session")).toEqual(before);
    f.change({
      type: "create",
      kind: "item",
      value: {
        ...item,
        kind: "user",
        body: { ...body, queueState: "sent" },
        createdAt: at,
        updatedAt: at,
      },
    });
    expect(
      outputFragments(f.store, "session", { ...item, id: "next", seq: 2 }, body)[0]?.text,
    ).not.toContain("design-context");
    expect(outputFragments(f.store, "legacy", item, body)).toEqual([]);
    expect(outputFragments(f.store, "session", item, { ...body, outputMode: "auto" })).toEqual([]);
  } finally {
    f.close();
  }
});
it("freezes explicitly selected design knowledge into a new task pack even when it does not match the brief", async () => {
  const f = await artifactFixture();
  try {
    f.change({
      type: "create",
      kind: "knowledge",
      value: {
        id: "design-context",
        scope: { type: "project", id: "artifact-project" },
        kind: "preference",
        title: "Visual language",
        body: "Use generous spacing.",
        tags: [],
        owner: { kind: "human", id: "owner" },
        verification: "human",
        writer: { kind: "human", id: "owner" },
        status: "active",
        sources: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
      },
    });
    f.change({
      type: "update",
      kind: "project",
      id: "artifact-project",
      changes: { artifactDesignContextId: "design-context" },
    });
    const result = f.store.dispatch("output-task", (state) =>
      createTask(
        state,
        {
          id: "output-task",
          title: "Analyze",
          brief: "Compare meal totals",
          profileId: "profile",
          node: { type: "project", id: "artifact-project" },
          outputMode: "design",
        },
        { commandId: "output-task", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    const task = result.result as { threadId: string };
    const input = {
      thread: parse(ThreadSchema, f.store.record("thread", task.threadId)),
      profile: parse(ProfileSchema, f.store.record("agent", "profile")),
      definition: parse(
        AgentDefinitionSchema,
        f.store.snapshot(["agentDefinition"]).agentDefinition?.[0],
      ),
    };
    const pack = knowledgeLaunch(f.store, input, 1000);
    expect(pack?.pack.included.some((k) => k.id === "design-context")).toBe(true);
    expect(() => knowledgeLaunch(f.store, input, 1)).toThrow("context_budget_hold");
  } finally {
    f.close();
  }
});
it("creates one designer from the existing Claude profile without changing an active chat or its permissions", async () => {
  const f = await artifactFixture();
  try {
    const base = f.store.record("agent", "profile");
    f.change({
      type: "update",
      kind: "agentDefinition",
      id: String(base?.definitionId),
      changes: { adapter: "claude" },
    });
    const first = await artifactDesigner(f.context, "artifact-project", "designer-one");
    expect(await artifactDesigner(f.context, "artifact-project", "designer-two")).toEqual(first);
    expect(f.store.record("agent", String(first.id))).toMatchObject({
      name: "Claude Designer",
      template: "artifact_designer",
      permissionProfile: base?.permissionProfile,
    });
    expect(f.store.record("thread", "thread")?.agentId).toBe("profile");
    expect(f.store.record("agent", "profile")).toEqual(base);
    await expect(artifactDesigner(f.context, undefined, "designer-one")).rejects.toThrow(
      "command_receipt_conflict",
    );
  } finally {
    f.close();
  }
});
