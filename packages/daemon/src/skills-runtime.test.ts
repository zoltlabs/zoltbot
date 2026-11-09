import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, AgentSession, OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, Profile, Thread } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { composeLaunchManifest } from "../../connections/src/launch-manifest.js";
import { parseSkill, SkillsLibrary } from "../../skills/src/index.js";
import { Redactor } from "./logging.js";
import { NativeRuntimeHost } from "./native-runtime.js";
import { skillsRuntime } from "./skills-runtime.js";

it("restores the same app-owned skill bytes after crash, edit and removal without history injection", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "zolt-skills-runtime-"))),
    store = await openStore(path.join(root, "db.sqlite"));
  try {
    if (!store.database.prepare("SELECT name FROM sqlite_master WHERE name='skill_library'").get())
      store.database.exec(
        readFileSync(new URL("../../skills/008-skills.sql", import.meta.url), "utf8"),
      );
    const library = new SkillsLibrary(store.database),
      bundle = parseSkill([
        {
          path: "SKILL.md",
          content: "---\nname: release-notes\ndescription: Test notes\n---\nOriginal skill bytes\n",
        },
      ]),
      entry = library.add(bundle);
    const service = skillsRuntime(store, path.join(root, "runtime"));
    const definition: AgentDefinition = {
      id: "fake",
      adapter: "fake",
      displayName: "Fake",
      binaryNames: [],
      versionCommand: [],
      launch: { command: "fake", args: [], env: {} },
      testedVersions: "fixture",
      defaults: { permissionProfile: "read_only" },
      staticCapabilities: {},
      nativeSessionRoots: [],
      experimental: false,
    };
    const profile: Profile = {
      id: "profile",
      name: "P",
      avatar: "P",
      kind: "profile",
      definitionId: "fake",
      permissionProfile: "read_only",
      instructions: "",
      roleText: "",
      hidden: false,
      archived: false,
    };
    const thread: Thread = {
      id: "thread",
      agentId: "profile",
      kind: "main",
      title: "Test",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: "2026-11-04T00:00:00Z",
      lastActivityAt: "2026-11-04T00:00:00Z",
    };
    let opened: OpenOptions | undefined,
      supported = true,
      preparedCount = 0;
    const adapter = {
      id: "fake",
      manifest: () => ({ supportsNativeSkills: supported, supportsConnections: false }),
      open: async (_def: AgentDefinition, options: OpenOptions) => {
        opened = options;
        return { nativeId: "same-native", close: async () => {} } as AgentSession;
      },
    } as AgentAdapter;
    const makeHost = () =>
      new NativeRuntimeHost({
        adapters: new Map([["fake", () => adapter]]),
        workspace: async () => ({ cwd: root }),
        bind: async () => ({
          url: "http://127.0.0.1:1/mcp",
          token: "test",
          setTurn() {},
          close: async () => {},
        }),
        estimate: (t) => t.length,
        toolTokens: 10,
        materializeSkills: (m) => service.materialize(m),
        extensions: {
          validate() {},
          select: () => [],
          resolve: async () => [],
          compose: (input, contributions) =>
            composeLaunchManifest(
              {
                executionId: "execution",
                threadId: input.threadId,
                profileId: input.profileId,
                cwd: input.cwd,
                configurationHash: "fixture",
              },
              contributions,
              { limit: 1500, fixed: input.fixed },
            ),
        },
        contributions: async () => {
          preparedCount++;
          return {
            skills: [
              {
                id: entry.id,
                revision: 1,
                hash: bundle.hash,
                path: `skills/${entry.id}/1/${bundle.hash}`,
                wrapperTokens: 100,
              },
            ],
          };
        },
      });
    const first = await makeHost().prepare({ thread, profile, definition }, new Redactor());
    const saved = JSON.parse(JSON.stringify(first.configuration));
    const native = await first.open({ sessionId: "one", mode: "new" });
    const descriptor = opened?.managedSkills?.[0];
    expect(descriptor).toBeDefined();
    expect(readFileSync(path.join(descriptor?.path ?? "", "SKILL.md"), "utf8")).toContain(
      "Original skill bytes",
    );
    await native.close();
    library.save(
      entry.id,
      1,
      parseSkill([
        { path: "SKILL.md", content: bundle.files[0]?.content.replace("Original", "New") ?? "" },
      ]),
    );
    library.remove(entry.id, true);
    rmSync(path.join(root, "runtime"), { recursive: true, force: true });
    const resumed = await makeHost().prepare(
      {
        thread,
        profile,
        definition,
        previous: { nativeId: "same-native", cwd: root, provider: "fake", configuration: saved },
      },
      new Redactor(),
    );
    const resumedNative = await resumed.open({
      sessionId: "two",
      mode: "resume",
      nativeId: "same-native",
    });
    expect(preparedCount).toBe(1);
    expect(opened?.nativeId).toBe("same-native");
    expect(opened?.appendInstructions).toBeUndefined();
    expect(opened?.managedSkills?.[0]).toEqual(descriptor);
    expect(readFileSync(path.join(descriptor?.path ?? "", "SKILL.md"), "utf8")).toContain(
      "Original skill bytes",
    );
    await resumedNative.close();
    supported = false;
    await expect(
      makeHost().prepare({ thread, profile, definition }, new Redactor()),
    ).rejects.toThrow("native_skills_loading_unavailable");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
