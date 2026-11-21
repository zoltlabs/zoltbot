import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { handle } from "@zoltbot/core";
import { type Interaction, InteractionSchema, parse } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { describe, expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { mcpRegistryClient } from "../../connections/src/mcp-registry.js";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { connectionProposalTools, respondConnectionProposal } from "./connection-proposal.js";
import { connectionsApi } from "./connections-api.js";
import { registryConnections } from "./connections-registry.js";
import { respondHostApproval } from "./host-approvals.js";
import { PrivateInputGuard } from "./private-input.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../connections/src/fixtures/mcp-registry-search.json", import.meta.url),
    "utf8",
  ),
) as unknown;
const registry = () =>
  registryConnections({
    client: mcpRegistryClient({ get: async () => fixture }),
    paths: async () => ["/nowhere", "/usr/bin"],
  });

async function setup() {
  const f = await runtimeFixture();
  const seed = (command: Parameters<typeof handle>[1]) => {
    const commandId = `seed:${randomUUID()}`;
    f.store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  seed({
    type: "create",
    kind: "project",
    value: {
      id: "proj",
      name: "Shop",
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
  });
  seed({ type: "update", kind: "thread", id: "thread", changes: { projectId: "proj" } });
  return f;
}
const contextFor = (store: Store) => ({
  store,
  privacy: new PrivateInputGuard({ store, publish() {} }),
  publish() {},
  async wake() {},
});
const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
const invoke = (store: Store, args: Record<string, unknown>, mcp = registry()) =>
  connectionProposalTools(
    contextFor(store),
    mcp,
  )({
    actor,
    arguments: args,
    idempotencyKey: randomUUID(),
  } as never) as Promise<Record<string, unknown>>;
const card = (store: Store, id: string) =>
  parse(InteractionSchema, store.record("interaction", id)) as Interaction;
const answer = (option: "add" | "later") => ({
  action: "accept" as const,
  answers: { add: { options: [option] } },
  by: { kind: "human" as const, id: "local-owner" },
  at,
});
const told = (store: Store) =>
  (store.snapshot(["item"]).item ?? [])
    .filter((row) => row.threadId === "thread" && row.kind === "user")
    .map((row) => JSON.stringify(row.body))
    .join("\n");

describe("connection proposals", () => {
  it("asks with the agent's reason and, on Add, turns the app on for that agent only", async () => {
    const f = await setup();
    try {
      const found = await invoke(f.store, { action: "search", query: "notes" });
      expect(found.items).toContainEqual(
        expect.objectContaining({ registryId: "com.example/notes", addable: true }),
      );
      const asked = await invoke(f.store, {
        action: "propose",
        registryId: "com.example/notes",
        reason: "To read the meeting notes you mentioned.",
      });
      expect(asked).toMatchObject({ status: "queued" });
      const request = card(f.store, String(asked.interactionId));
      expect(request.title).toBe("Fixture wants to add Example Notes");
      expect(request.items[0]?.options?.map((option) => option.label)).toEqual(["Add", "Not now"]);
      // Where it connects comes first; the agent's words are quoted and labelled.
      expect(request.items[0]?.prompt).toBe(
        "From example.com.\n\nConnects to https://mcp.example.com/mcp.\n\nFixture’s reason: “To read the meeting notes you mentioned.”",
      );
      // Asking again returns the same card.
      expect(
        await invoke(f.store, {
          action: "propose",
          registryId: "com.example/notes",
          reason: "Again.",
        }),
      ).toMatchObject({ interactionId: asked.interactionId });

      await respondHostApproval(contextFor(f.store), request, answer("add"));
      const saved = new ConnectionRegistry(f.store.database).list("proj");
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        source: "registry:com.example/notes@1.4.0",
        transport: { kind: "https", url: "https://mcp.example.com/mcp" },
        enabled: true,
        profileIds: ["profile"],
      });
      expect(told(f.store)).toContain("The person added Example Notes");
      // A retried answer saves nothing twice.
      await respondConnectionProposal(contextFor(f.store), request, answer("add"));
      expect(new ConnectionRegistry(f.store.database).list("proj")).toHaveLength(1);
      expect(
        await invoke(f.store, { action: "propose", registryId: "com.example/notes", reason: "x" }),
      ).toEqual({ error: "already_added" });
    } finally {
      f.store.close();
    }
  });

  it("saves nothing on Not now and refuses apps that need settings", async () => {
    const f = await setup();
    try {
      const asked = await invoke(f.store, {
        action: "propose",
        registryId: "com.example/notes",
        reason: "Notes.",
      });
      await respondHostApproval(
        contextFor(f.store),
        card(f.store, String(asked.interactionId)),
        answer("later"),
      );
      expect(new ConnectionRegistry(f.store.database).list("proj")).toHaveLength(0);
      expect(told(f.store)).toContain("chose not to add Example Notes");
      expect(
        await invoke(f.store, {
          action: "propose",
          registryId: "io.github.acme/issues",
          reason: "Issues.",
        }),
      ).toEqual({ error: "registry_server_needs_settings" });
    } finally {
      f.store.close();
    }
  });

  it("shows the exact command for a package and needs the runner on the Mac", async () => {
    const f = await setup();
    try {
      const none = registryConnections({
        client: mcpRegistryClient({ get: async () => fixture }),
        paths: async () => ["/nowhere"],
      });
      expect(
        await invoke(
          f.store,
          { action: "propose", registryId: "io.github.someone/weather", reason: "Rain?" },
          none,
        ),
      ).toEqual({ error: "registry_needs_uv" });
    } finally {
      f.store.close();
    }
  });
});

describe("Settings: add from the registry", () => {
  it("adds a remote app turned off and a package only after confirming its command", async () => {
    const f = await setup();
    const service = connectionsApi({ store: f.store, mcpRegistry: registry() });
    const call = (method: string, params: Record<string, unknown>) =>
      service.api(method, params, randomUUID());
    try {
      const { items } = (await call("connection.registry.search", { query: "notes" })) as {
        items: { id: string; install: string; runs?: string; needs: string[] }[];
      };
      expect(items.find((item) => item.id === "io.github.acme/issues")).toMatchObject({
        install: "package",
        runs: "npx -y @acme/issues-mcp@0.3.1",
        needs: ["ACME_TOKEN"],
      });
      expect(items.find((item) => item.id === "io.github.docker/only")?.install).toBe(
        "unsupported",
      );
      const added = (await call("connection.registry.add", {
        projectId: "proj",
        registryId: "com.example/notes",
        version: "1.4.0",
        url: "https://mcp.example.com/mcp",
      })) as { enabled: boolean; name: string };
      expect(added.enabled).toBe(false);
      expect(added.name).toMatch(/^notes_[0-9a-f]{8}$/);
      // The owner confirmed one version; a different one in the registry is refused, not saved.
      await expect(
        call("connection.registry.add", {
          projectId: "proj",
          registryId: "com.example/notes",
          version: "1.3.0",
          url: "https://mcp.example.com/mcp",
        }),
      ).rejects.toThrow("registry_server_changed");
      await expect(
        call("connection.registry.add", {
          projectId: "missing",
          registryId: "com.example/notes",
          version: "1.4.0",
          url: "https://mcp.example.com/mcp",
        }),
      ).rejects.toThrow("connection_scope_denied");
    } finally {
      service.close();
      f.store.close();
    }
  });
});
