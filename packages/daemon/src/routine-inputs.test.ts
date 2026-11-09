import { type CommandContext, createTask, handle } from "@zoltbot/core";
import { upsertKnowledge } from "@zoltbot/knowledge";
import { AgentDefinitionSchema, ProfileSchema, parse, ThreadSchema } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { composeLaunchManifest } from "../../connections/src/launch-manifest.js";
import { parseSkill, SkillsLibrary } from "../../skills/src/index.js";
import { launchIntent } from "./connections-intent.js";
import { knowledgeLaunch } from "./knowledge-launch.js";
import { skillsRuntime } from "./skills-runtime.js";

it("resolves routine input selections at launch and freezes their exact revisions through the ordinary manifest transaction", async () => {
  const f = await runtimeFixture();
  let serial = 0;
  const ctx = (): CommandContext => ({
    commandId: `inputs:${++serial}`,
    at,
    actor: { kind: "human", id: "owner" },
  });
  const run = (work: Parameters<typeof f.store.dispatch>[1]) =>
    f.store.dispatch(`write:${++serial}`, work);
  try {
    run((state) =>
      handle(
        state,
        {
          type: "create",
          kind: "project",
          value: {
            id: "p",
            name: "P",
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
        ctx(),
      ),
    );
    const library = new SkillsLibrary(f.store.database);
    const first = library.add(
      parseSkill([
        {
          path: "SKILL.md",
          content: "---\nname: check\ndescription: Routine checks\n---\nOriginal instructions.\n",
        },
      ]),
    );
    library.assign({
      profileId: "profile",
      scopeId: "p",
      skillId: first.id,
      revision: 1,
      enabled: true,
      confirmed: true,
      reservedNames: [],
    });
    const service = skillsRuntime(f.store, f.root);
    const knowledge = (id: string, body: string, revision = 1) => ({
      id,
      scope: { type: "project", id: "p" },
      kind: "decision",
      title: "Check status",
      body,
      status: "active",
      tags: [],
      sources: [],
      revision,
      owner: { kind: "human", id: "owner" },
      createdAt: at,
      updatedAt: at,
      pinned: true,
    });
    run((state) => upsertKnowledge(state, knowledge("selected", "Original knowledge."), 0, ctx()));
    run((state) => upsertKnowledge(state, knowledge("unselected", "Other knowledge."), 0, ctx()));
    const create = (id: string) =>
      run((state) =>
        createTask(
          state,
          {
            id,
            title: "Check",
            brief: "Check status",
            profileId: "profile",
            node: { type: "project", id: "p" },
            routineOccurrenceId: `routine@${id}`,
            permissionCeiling: "read_only",
            routineInputs: { knowledge: ["selected"], skills: [first.id], connections: [] },
          },
          ctx(),
        ),
      );
    create("first");
    const input = (id: string) => ({
      thread: parse(ThreadSchema, f.store.record("thread", `${id}:thread`)),
      profile: parse(ProfileSchema, f.store.record("agent", "profile")),
      definition: parse(AgentDefinitionSchema, f.store.record("agentDefinition", "fake")),
    });
    const selected = service.select(input("first"));
    expect(selected.map((skill) => skill.id)).toEqual([first.id]);
    const pack = knowledgeLaunch(f.store, input("first"), 1400);
    expect(pack?.pack?.included.map((entry) => entry.id)).toEqual(["selected"]);
    expect(pack?.text).not.toContain("Other knowledge.");
    const manifest = composeLaunchManifest(
      {
        executionId: "first-execution",
        threadId: "first:thread",
        taskId: "first",
        taskRevision: 1,
        profileId: "profile",
        projectId: "p",
        cwd: f.root,
        configurationHash: "test",
      },
      { ...(pack ? { knowledge: pack } : {}), skills: selected },
      { limit: 1500, fixed: 10 },
    );
    const context = ctx();
    f.store.dispatch("launch", (state) =>
      launchIntent(
        state,
        context,
        handle(
          state,
          {
            type: "create",
            kind: "session",
            value: {
              id: "launched",
              threadId: "first:thread",
              provider: "reference",
              cwd: f.root,
              state: "starting",
              capabilities: {},
              startedAt: at,
            },
          },
          context,
        ),
        "launched",
        { launchManifest: manifest },
        f.store,
      ),
    );
    run((state) =>
      upsertKnowledge(state, knowledge("selected", "Updated knowledge.", 2), 1, ctx()),
    );
    const bundle = library.revision(first.id, 1).bundle;
    library.save(
      first.id,
      1,
      parseSkill([
        {
          path: "SKILL.md",
          content: bundle.files[0]?.content.replace("Original", "Updated") ?? "",
        },
      ]),
    );
    library.assign({
      profileId: "profile",
      scopeId: "p",
      skillId: first.id,
      revision: 2,
      enabled: true,
      confirmed: true,
      reservedNames: [],
    });
    expect(knowledgeLaunch(f.store, input("first"), 1400)?.text).toContain("Original knowledge.");
    expect(f.store.record("settings", "runtime.configuration.launched")?.value).toEqual({
      launchManifest: manifest,
    });
    create("second");
    expect(knowledgeLaunch(f.store, input("second"), 1400)?.text).toContain("Updated knowledge.");
    expect(service.select(input("second"))[0]?.revision).toBe(2);
    run((state) =>
      handle(
        state,
        {
          type: "update",
          kind: "task",
          id: "second",
          changes: { routineInputs: { knowledge: [], skills: [], connections: [] } },
        },
        ctx(),
      ),
    );
    expect(service.select(input("second"))).toEqual([]);
    expect(knowledgeLaunch(f.store, input("second"), 1400)?.pack?.included).toEqual([]);
  } finally {
    f.close();
  }
});
