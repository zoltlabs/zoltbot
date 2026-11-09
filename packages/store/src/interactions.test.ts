import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { answerInteractions, expireInteractions, handle, requestInteraction } from "@zoltbot/core";
import { expect, it } from "vitest";
import { openStore } from "./index.js";

const at = "2026-10-27T12:00:00.000Z";
const context = { commandId: "request", at, actor: { kind: "human" as const, id: "owner" } };
async function fixture() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/interaction-store-"));
  const file = path.join(root, "store.db"),
    store = await openStore(file);
  const definition = {
    id: "fake",
    displayName: "Fake",
    adapter: "acp",
    binaryNames: [],
    versionCommand: [],
    launch: { command: "fake", args: [], env: {} },
    testedVersions: "1.0.0",
    defaults: { permissionProfile: "read_only" },
    staticCapabilities: {},
    nativeSessionRoots: [],
    experimental: false,
  };
  const profile = {
    id: "profile",
    name: "Builder",
    avatar: "B",
    definitionId: "fake",
    kind: "profile",
    permissionProfile: "read_only",
    instructions: "",
    hidden: false,
    archived: false,
  };
  const thread = {
    id: "thread",
    agentId: "profile",
    kind: "main",
    title: "Test",
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: at,
    lastActivityAt: at,
  };
  for (const [kind, value] of [
    ["agentDefinition", definition],
    ["agent", profile],
    ["thread", thread],
  ] as const) {
    const commandId = `seed:${kind}`;
    store.dispatch(commandId, (state) =>
      handle(state, { type: "create", kind, value }, { ...context, commandId }),
    );
  }
  return {
    root,
    file,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const draft = {
  id: "one",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  items: [{ id: "q", prompt: "Private value", secret: true }],
  chain: [],
  urgency: "blocking",
};
it("rolls back request creation and expires three pending requests atomically", async () => {
  const test = await fixture(),
    { store } = test;
  try {
    const before = store.snapshot();
    const create = (state: ReturnType<typeof store.snapshot>) =>
      requestInteraction(state, draft, "item-one", context);
    expect(() => store.dispatch("request", create, { killPoint: "after_events" })).toThrow(
      "kill point",
    );
    expect(store.snapshot()).toEqual(before);
    store.dispatch("request", create);
    for (const id of ["two", "three"])
      store.dispatch(id, (state) =>
        requestInteraction(state, { ...draft, id }, `item-${id}`, { ...context, commandId: id }),
      );
    const pending = store.snapshot();
    const expire = (state: ReturnType<typeof store.snapshot>) =>
      expireInteractions(state, ["thread"], "process_died", {
        ...context,
        commandId: "exit",
        actor: { kind: "system", id: "runtime" },
      });
    expect(() => store.dispatch("exit", expire, { killPoint: "after_projections" })).toThrow(
      "kill point",
    );
    expect(store.snapshot()).toEqual(pending);
    store.dispatch("exit", expire);
    expect(
      store.snapshot().interaction?.every((row) => row.state === "expired" && row.version === 2),
    ).toBe(true);
    const committed = store.snapshot();
    store.rebuild();
    expect(store.snapshot()).toEqual(committed);
  } finally {
    test.close();
  }
});
it("lets one stale device win and never persists a secret in events, receipts, database, or WAL", async () => {
  const test = await fixture(),
    { store } = test;
  try {
    store.dispatch("request", (state) => requestInteraction(state, draft, "item-one", context));
    const secret = "synthetic-private-answer-7df42";
    const answer = {
      action: "accept" as const,
      answers: { q: { value: secret } },
      by: context.actor,
      at,
    };
    const results = await Promise.allSettled(
      ["desktop", "phone"].map((device) =>
        Promise.resolve().then(() =>
          store.dispatch(device, (state) =>
            answerInteractions(state, [{ id: "one", version: 1, answer }], {
              ...context,
              commandId: device,
              actor: { kind: "human", id: device },
            }),
          ),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && String(rejected.reason)).toContain(
      "interaction_conflict",
    );
    expect(JSON.stringify(store.snapshot())).not.toContain(secret);
    expect(JSON.stringify(store.eventsSince(0))).not.toContain(secret);
    expect(
      JSON.stringify(store.database.prepare("SELECT result FROM command_receipts").all()),
    ).not.toContain(secret);
    for (const file of [test.file, `${test.file}-wal`])
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
    expect(JSON.stringify(store.snapshot())).toContain("[secret]");
  } finally {
    test.close();
  }
});
