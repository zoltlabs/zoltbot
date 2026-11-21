import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition, DomainEvent } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  bundleApi,
  bundleData,
  bundleSkills,
  unzipBundle,
  withoutSecrets,
  zipBundle,
} from "./bundle.js";
import { creationApi } from "./creation-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { secretReferences } from "./start-fresh.js";

const definition: AgentDefinition = {
  id: "sample",
  displayName: "Sample",
  adapter: "acp",
  binaryNames: [],
  versionCommand: [],
  launch: { command: "fake", args: [], env: {} },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "full_access" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};

function folder() {
  mkdirSync(".cache/tests", { recursive: true });
  return mkdtempSync(path.resolve(".cache/tests/bundle-"));
}

async function daemonStore(root: string) {
  const store = await openStore(path.join(root, "zoltbot.db"));
  const publish = (_rows: DomainEvent[]) => undefined;
  const api = bundleApi({
    snapshot: () => store.snapshot() as Record<string, unknown[] | undefined>,
    skills: bundleSkills(store.database),
    connections: () => ["GitHub", "Gmail"],
    write: (commandId, events, inside) =>
      store.dispatch(commandId, () => {
        inside();
        return { events: events as DomainEvent[], result: {} };
      }),
  });
  return { store, api, publish };
}

function setting(store: Store, key: string, value: unknown) {
  store.dispatch(`set-${key}`, () => ({
    events: [
      {
        eventId: `set-${key}:0`,
        aggregateType: "settings",
        aggregateId: key,
        type: "settings.created",
        occurredAt: "2026-11-21T06:00:00Z",
        payload: { key, value },
      } as DomainEvent,
    ],
    result: {},
  }));
}

/** The coding tool, set up on this Mac the way onboarding does it. */
function setUpTool(store: Store) {
  store.dispatch("set-up-sample", () => ({
    events: [
      {
        eventId: "set-up-sample:0",
        aggregateType: "agentDefinition",
        aggregateId: "sample",
        type: "agentDefinition.created",
        occurredAt: "2026-11-21T06:00:00Z",
        payload: definition,
      } as DomainEvent,
    ],
    result: {},
  }));
}

const SKILL = {
  name: "release-notes",
  files: [
    {
      path: "SKILL.md",
      content:
        "---\nname: release-notes\ndescription: Write release notes\n---\nKeep them short.\n",
    },
  ],
};

describe("bundles", () => {
  it("moves agents, skills and settings to another daemon, with no secret", async () => {
    const sourceRoot = folder();
    const source = await daemonStore(sourceRoot);
    const target = await daemonStore(folder());
    try {
      const privacy = new PrivateInputGuard({ store: source.store, publish: source.publish });
      const create = creationApi({
        store: source.store,
        privacy,
        publish: source.publish,
        definitions: async () => ({ definitions: [definition] }),
      });
      await create(
        "agent.create",
        {
          value: {
            id: "writer",
            definitionId: "sample",
            name: "Writer",
            avatar: "W",
            kind: "profile",
            permissionProfile: "workspace_write",
            instructions: "Plain words.",
            hidden: false,
            archived: false,
          },
        },
        "create-writer",
      );
      setting(source.store, "style.tone", "plain");
      setting(source.store, "bridge.telegram", { credentialRef: "keychain:zoltbot:abc-1" });
      setting(source.store, "notes.ref", "keychain:zoltbot:def-2");
      setting(source.store, "models.account.work", { configDirectory: "/private/sign-in" });
      setting(source.store, "chief.thread", "thread-1");
      setting(source.store, "mcp.registry", [{ name: "GitHub" }]);
      setting(source.store, "review.folder", "/srv/work");
      bundleSkills(source.store.database).add(SKILL as never);

      const file = path.join(sourceRoot, "export.zip");
      const exported = (await source.api("export.bundle", { path: file })) as {
        counts: Record<string, number>;
      };
      expect(exported.counts).toMatchObject({ agent: 1, skills: 1, settings: 1 });
      // The ZIP itself holds no secret, launch command or private folder.
      const packed = Object.values(unzipSync(readFileSync(file)))
        .map((bytes) => strFromU8(bytes))
        .join("\n");
      for (const text of ["keychain:", "/private/sign-in", "/srv/", "fake", "chief.", "mcp."])
        expect(packed).not.toContain(text);

      // Without the agent's coding tool, the agent can't come over: the preview names the tool.
      const early = (await target.api("import.bundle", { path: file })) as {
        agents: number;
        tools: string[];
      };
      expect(early).toMatchObject({ agents: 0, tools: ["Sample"] });
      setUpTool(target.store);

      const preview = (await target.api("import.bundle", { path: file })) as {
        previewId: string;
        agents: number;
        items: { id: string; action: string }[];
        connections: string[];
        tools: string[];
      };
      expect(preview.agents).toBe(1);
      expect(preview.tools).toEqual([]);
      expect(preview.connections).toEqual(["GitHub", "Gmail"]);
      expect(preview.items.map((item) => item.id).sort()).toEqual([
        "agent:writer",
        "settings:style.tone",
        "skill:release-notes",
      ]);
      expect(preview.items.every((item) => item.action === "add")).toBe(true);
      await expect(
        target.api("import.apply", { previewId: preview.previewId, selected: [], consent: false }),
      ).rejects.toThrow("consent");
      await target.api("import.apply", {
        previewId: preview.previewId,
        selected: preview.items.map((item) => item.id),
        consent: true,
      });

      const after = target.store.snapshot();
      expect(after.agent?.map((row) => row.name)).toEqual(["Writer"]);
      expect(after.settings?.map((row) => row.key)).toEqual(["style.tone"]);
      expect(
        bundleSkills(target.store.database)
          .list()
          .map((skill) => skill.name),
      ).toEqual(["release-notes"]);
      // No secret reference arrived, so none can resolve on this Mac.
      expect(secretReferences(after)).toEqual([]);

      // Importing again replaces instead of adding, and writes again.
      const again = (await target.api("import.bundle", { path: file })) as {
        previewId: string;
        items: { id: string; action: string }[];
      };
      expect(again.items.every((item) => item.action === "replace")).toBe(true);
      await target.api("import.apply", {
        previewId: again.previewId,
        selected: again.items.map((item) => item.id),
        consent: true,
      });
      expect(target.store.snapshot().agent?.map((row) => row.name)).toEqual(["Writer"]);
    } finally {
      source.store.close();
      target.store.close();
    }
  });

  it("keeps a newer knowledge item and a routine's paused state here", async () => {
    const { bundleEvents } = await import("./bundle.js");
    const data = bundleData({
      snapshot: {
        knowledge: [{ id: "k", title: "Old", revision: 3 }],
        routine: [{ id: "r", name: "Morning", paused: false }],
        project: [
          { id: "p", name: "Site", roots: [{ path: "/srv/site", label: "site" }] },
        ],
      },
      skills: [],
      connections: [],
    });
    expect(data.entities.project?.[0]).toEqual({ id: "p", name: "Site", roots: [] });
    const here = {
      knowledge: [{ id: "k", title: "New", revision: 7 }],
      routine: [{ id: "r", name: "Morning", paused: false }],
      project: [{ id: "p", name: "Site", roots: [{ path: "/here", label: "here" }] }],
    };
    const events = bundleEvents(
      data,
      new Set(["knowledge:k", "routine:r", "project:p"]),
      here,
      "t",
    );
    expect(events.map((event) => event.aggregateId)).toEqual(["p", "r"]);
    expect(events[0]?.payload).toMatchObject({ roots: [{ path: "/here" }] });
    expect(events[1]?.payload).toMatchObject({ paused: false });
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it("strips secrets and pauses routines on export", () => {
    const data = bundleData({
      snapshot: {
        routine: [{ id: "r", name: "Morning", paused: false, token: "x" }],
        agent: [{ id: "a", name: "A", apiKey: "sk-123", env: ["keychain:zoltbot:1", "ok"] }],
      },
      skills: [],
      connections: [],
    });
    expect(data.entities.routine?.[0]).toEqual({ id: "r", name: "Morning", paused: true });
    expect(data.entities.agent?.[0]).toEqual({ id: "a", name: "A", env: ["ok"] });
    expect(withoutSecrets({ password: "p", nested: { value: "keychain:zoltbot:2" } })).toEqual({
      nested: {},
    });
  });

  it("refuses a file that isn't an export and drops secrets from a hand-edited one", () => {
    expect(() => unzipBundle(strToU8("not a zip"))).toThrow("invalid_bundle");
    const edited = zipSync({
      "manifest.json": strToU8(JSON.stringify({ format: 1, counts: {}, connections: [] })),
      "entities/agent.json": strToU8(
        JSON.stringify([{ id: "a", secretRef: "keychain:zoltbot:9" }]),
      ),
      "settings.json": strToU8(JSON.stringify([{ key: "runtime.private.x", value: 1 }])),
      "skills.json": strToU8("[]"),
    });

    const data = unzipBundle(edited);
    expect(data.entities.agent).toEqual([{ id: "a" }]);
    expect(data.settings).toEqual([]);
    expect(unzipBundle(zipBundle(data)).entities.agent).toEqual([{ id: "a" }]);
  });
});
