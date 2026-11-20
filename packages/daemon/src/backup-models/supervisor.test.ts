import { answerInteractions, requestInteraction } from "@zoltbot/core";
import { type InteractionDraft, ProfileSchema, parse } from "@zoltbot/protocol";
import { afterEach, expect, it } from "vitest";
import { forkFixture } from "../../../../tools/fakes/src/fork-fixture.js";
import { copiedContextKey } from "../copied-fork-context.js";
import {
  type ActiveRecord,
  ackKey,
  activeKey,
  backupLaunch,
  defaultAccountId,
  limitKey,
  setting,
} from "./records.js";
import { backupModelsApi } from "./service.js";
import { backupSupervisor } from "./supervisor.js";

const start = Date.parse("2026-10-28T13:00:00Z");
const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();
const minute = 60_000;
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Two Claude sign-ins and one Codex sign-in, all synthetic. No provider runs. */
async function fixture(order: "with-codex" | "claude-only" = "with-codex") {
  const f = await forkFixture();
  const definition = f.store.record("agentDefinition", "fake") as Record<string, unknown>;
  f.put("agentDefinition", {
    ...definition,
    displayName: "Claude",
    adapter: "claude",
    launch: { command: "claude", args: [], env: { CLAUDE_CONFIG_DIR: "/config/claude" } },
  });
  f.put("agentDefinition", {
    ...definition,
    id: "codex-tool",
    displayName: "Codex",
    adapter: "codex",
    launch: { command: "codex", args: [], env: {} },
  });
  f.put("session", { ...f.store.record("session", "session"), provider: "claude" });
  const signIns: { definitionId: string; folder?: string }[] = [];
  const api = backupModelsApi({
    store: f.store,
    publish() {},
    prepareData: async (value) => value,
    dataDir: f.root,
    owned: {
      async accountLoginInfo(definitionId: string, folder?: string) {
        signIns.push({ definitionId, ...(folder ? { folder } : {}) });
        return { provider: "claude", command: "claude auth login", configDirectory: folder ?? "" };
      },
      accountLogin: async () => "signed_in",
    } as never,
  });
  const added = (await api("modelAccount.add", { definitionId: "fake", label: "Work" })) as {
    account: { id: string; configDirectory: string };
  };
  const work = added.account;
  await api("backupOrder.set", {
    role: "employee",
    entries: [
      { accountId: defaultAccountId("fake") },
      { accountId: work.id },
      ...(order === "with-codex" ? [{ accountId: defaultAccountId("codex-tool") }] : []),
    ],
  });
  let now = start + minute;
  const stopped: string[] = [];
  const asked: InteractionDraft[] = [];
  const supervisor = backupSupervisor({
    store: f.store,
    publish() {},
    now: () => now,
    intervalMs: 60 * minute,
    async stopThread(threadId) {
      stopped.push(threadId);
      const session = f.store.record("session", "session");
      if (session?.state === "ready") f.put("session", { ...session, state: "closed" });
    },
    async request(draft, commandId) {
      asked.push(draft);
      f.store.dispatch(commandId, (state) =>
        requestInteraction(state, draft, `${draft.id}:item`, {
          commandId,
          at: iso(0),
          actor: { kind: "system", id: "backup-models" },
        }),
      );
    },
  });
  closers.push(
    () => supervisor.close(),
    () => f.close(),
  );
  const limit = (sessionId: string, observedAt: string, resetsAt: string, startedAt?: string) =>
    f.put("session", {
      ...(f.store.record("session", sessionId) ?? {
        id: sessionId,
        threadId: "thread",
        provider: "claude",
        cwd: f.root,
        capabilities: {},
        nativeId: `${sessionId}-native`,
      }),
      ...(startedAt ? { startedAt } : {}),
      state: "closed",
      runtimeStatus: { state: "rate_limited", resetsAt, observedAt },
    });
  const state = () => f.store.snapshot();
  const notes = () =>
    (state().item ?? [])
      .filter((row) => row.kind === "note")
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((row) => (row.body as { text: string }).text);
  const profile = () => parse(ProfileSchema, f.store.record("agent", "profile"));
  return {
    f,
    api,
    work,
    signIns,
    supervisor,
    stopped,
    asked,
    limit,
    state,
    notes,
    profile,
    at: (offsetMs: number) => {
      now = start + offsetMs;
    },
  };
}

it("adds a sign-in folder per account without storing credentials", async () => {
  const t = await fixture();
  expect(t.signIns).toEqual([{ definitionId: "fake", folder: t.work.configDirectory }]);
  expect(t.work.configDirectory.startsWith(t.f.root)).toBe(true);
  const list = (await t.api("modelAccount.list", {})) as { items: { id: string }[] };
  expect(list.items.map((row) => row.id).sort()).toEqual(
    [defaultAccountId("codex-tool"), defaultAccountId("fake"), t.work.id].sort(),
  );
  await expect(
    t.api("modelAccount.remove", { id: defaultAccountId("fake"), confirmed: true }),
  ).rejects.toThrow("model_account_default");
  t.f.put("agentDefinition", {
    ...(t.f.store.record("agentDefinition", "codex-tool") as Record<string, unknown>),
    id: "acp-tool",
    displayName: "Antigravity",
    adapter: "acp",
  });
  await expect(
    t.api("modelAccount.add", { definitionId: "acp-tool", label: "Work" }),
  ).rejects.toThrow("model_account_unsupported");
  expect(t.signIns).toHaveLength(1);
  const rows = t.state().settings?.filter((row) => String(row.key).startsWith("models."));
  expect(JSON.stringify(rows)).not.toMatch(/token|password|secret/i);
});

it("switches to the next account at a limit, asks before another provider, and moves back", async () => {
  const t = await fixture();
  t.limit("session", iso(0), iso(60 * minute));
  await t.supervisor.tick();

  const first = setting<ActiveRecord>(t.state(), activeKey("thread"));
  expect(first).toMatchObject({ accountId: t.work.id, copied: true, boundarySessionId: "session" });
  expect(setting(t.state(), limitKey(defaultAccountId("fake")))).toMatchObject({
    resetsAt: iso(60 * minute),
  });
  expect(setting(t.state(), copiedContextKey("thread"))).toBeTruthy();
  expect(t.notes()).toEqual(["Claude hit its limit. Continuing on Claude · Work."]);
  expect(t.stopped).toEqual(["thread"]);

  // The next launch runs in the work account's folder, in a fresh native session.
  const launch = backupLaunch(t.state(), "thread", t.profile());
  expect(launch.definition.launch.env.CLAUDE_CONFIG_DIR).toBe(t.work.configDirectory);
  expect(launch.fresh).toBe(true);

  // A second tick on the same limit does nothing.
  await t.supervisor.tick();
  expect(t.notes()).toHaveLength(1);

  // The work account hits its limit too; Codex is another provider, so the owner is asked.
  t.at(3 * minute);
  t.limit("session-2", iso(2 * minute), iso(90 * minute), iso(2 * minute));
  await t.supervisor.tick();
  expect(t.asked).toHaveLength(1);
  expect(t.asked[0]?.title).toBe("Continue on Codex?");
  expect(setting<ActiveRecord>(t.state(), activeKey("thread"))?.accountId).toBe(t.work.id);

  const interaction = t.state().interaction?.find((row) => row.id === t.asked[0]?.id);
  t.f.store.dispatch("answer", (state) =>
    answerInteractions(
      state,
      [
        {
          id: String(interaction?.id),
          version: Number(interaction?.version),
          answer: {
            action: "accept",
            answers: { choice: { options: ["continue"] }, remember: { options: ["remember"] } },
            by: { kind: "human", id: "owner" },
            at: iso(3 * minute),
          },
        },
      ],
      { commandId: "answer", at: iso(3 * minute), actor: { kind: "human", id: "owner" } },
    ),
  );
  await t.supervisor.tick();
  expect(setting<ActiveRecord>(t.state(), activeKey("thread"))?.accountId).toBe(
    defaultAccountId("codex-tool"),
  );
  expect(setting(t.state(), ackKey("thread:thread"))).toBeTruthy();
  expect(t.notes().at(-1)).toBe("Claude · Work hit its limit. Continuing on Codex.");
  const codex = backupLaunch(t.state(), "thread", t.profile());
  expect(codex.definition.adapter).toBe("codex");
  expect(codex.fresh).toBe(true);

  // Both Claude limits reset: the chat moves back to the agent's own sign-in without asking.
  t.at(2 * 60 * minute);
  await t.supervisor.tick();
  const back = setting<ActiveRecord>(t.state(), activeKey("thread"));
  expect(back).toMatchObject({ accountId: defaultAccountId("fake"), home: true });
  expect(t.notes().at(-1)).toBe("Back on Claude.");
  expect(t.asked).toHaveLength(1);
  const home = backupLaunch(t.state(), "thread", t.profile());
  expect(home.definition.launch.env.CLAUDE_CONFIG_DIR).toBe("/config/claude");
});

it("writes one notice when every backup is at its limit", async () => {
  const t = await fixture("claude-only");
  t.limit("session", iso(0), iso(60 * minute));
  await t.supervisor.tick();
  t.at(3 * minute);
  t.limit("session-2", iso(2 * minute), iso(90 * minute), iso(2 * minute));
  await t.supervisor.tick();
  await t.supervisor.tick();
  expect(t.notes()).toEqual([
    "Claude hit its limit. Continuing on Claude · Work.",
    "Claude · Work hit its limit. No backup is free.",
  ]);
  expect(setting<ActiveRecord>(t.state(), activeKey("thread"))?.accountId).toBe(t.work.id);
});
