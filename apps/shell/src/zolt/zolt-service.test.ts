// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import type { AgentEvent, ConversationSnapshot } from "../shared/ipc";
import { DaemonClient } from "./daemon-client";
import { ZoltService } from "./zolt-service";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = await compareFixture();
  const client = new DaemonClient(async () => ({
    url: fixture.daemon.url,
    token: fixture.daemon.token,
  }));
  const service = new ZoltService(client, mkdtempSync(join(tmpdir(), "zoltbot-shell-")));
  const events: AgentEvent[] = [];
  service.on("event", (event) => events.push(event));
  cleanups.push(async () => {
    await service.stop();
    await fixture.close();
  });
  await service.initialize();
  return { service, events, fixture };
}

async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the daemon.");
    await new Promise((done) => setTimeout(done, 20));
  }
}

const lastConversation = (events: AgentEvent[], botId: string) =>
  events
    .filter(
      (event): event is Extract<AgentEvent, { type: "conversation" }> =>
        event.type === "conversation" && event.snapshot.botId === botId,
    )
    .at(-1)?.snapshot;

describe("ZoltService against a real daemon", () => {
  it("lists daemon chats and reports a ready status", async () => {
    const { service } = await setup();
    expect(service.getStatus().phase).toBe("ready");
    expect(service.listBots().map((bot) => bot.id)).toContain("thread");
    const status = await service.refreshAgents();
    // This test daemon has no install checks, so each agent says it couldn't be checked.
    expect(status.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fake", name: "Fake", state: "error" }),
        expect.objectContaining({ id: "unavailable", name: "Unavailable tool", state: "error" }),
      ]),
    );
    expect(status.capabilities.chat).toBe("ready");
  });

  it("shows a sent message at once, then the streamed reply and the finished turn", async () => {
    const { service, events } = await setup();
    const bot = await service.createBot({ profileId: "profile" });
    await until(() => service.listBots().find((row) => row.id === bot.id));
    await service.readConversation(bot.id);

    const sending = service.sendMessage({ botId: bot.id, text: "Hello there" });
    const optimistic = lastConversation(events, bot.id) as ConversationSnapshot;
    expect(optimistic.messages.at(-1)).toMatchObject({ author: "user", text: "Hello there" });
    await sending;

    const replied = await until(() => {
      const snapshot = lastConversation(events, bot.id);
      return snapshot?.messages.some(
        (message) => message.author === "assistant" && message.text === "First answer",
      )
        ? snapshot
        : undefined;
    });
    expect(replied.messages.filter((message) => message.text === "Hello there")).toHaveLength(1);
    await until(() =>
      events.find((event) => event.type === "turn-completed" && event.botId === bot.id),
    );
    expect(events.some((event) => event.type === "turn-started" && event.botId === bot.id)).toBe(
      true,
    );
  });

  it("turns an agent question into a prompt and answers it", async () => {
    const { service, events } = await setup();
    const bot = await service.createBot({ profileId: "profile" });
    await until(() => service.listBots().find((row) => row.id === bot.id));
    await service.readConversation(bot.id);
    await service.sendMessage({ botId: bot.id, text: "Ask me a question" });
    const prompt = await until(() =>
      events.find(
        (event): event is Extract<AgentEvent, { type: "prompt" }> =>
          event.type === "prompt" && event.botId === bot.id,
      ),
    );
    expect(prompt.questions[0]).toMatchObject({
      question: "Choose an approach",
      options: [{ label: "Use this approach", description: "" }],
    });
    await service.respondToPrompt({
      requestId: prompt.requestId,
      answers: { q: ["Use this approach"] },
    });
    await until(() =>
      events.find((event) => event.type === "prompt-cleared" && event.botId === bot.id),
    );
    await until(() =>
      events.find((event) => event.type === "turn-completed" && event.botId === bot.id),
    );
  });

  it("creates a project with its CEO and places new chats under it", async () => {
    const { service } = await setup();
    const ceo = await service.createProject(mkdtempSync(join(tmpdir(), "launch-")));
    expect(ceo).toMatchObject({ companyRole: "ceo", kind: "manager" });
    const chat = await service.createBot({ projectId: ceo.projectId });
    const bots = await until(() => {
      const rows = service.listBots();
      return rows.some((row) => row.id === chat.id) && rows.some((row) => row.id === ceo.id)
        ? rows
        : undefined;
    });
    const ceoRow = bots.find((row) => row.id === ceo.id);
    expect(ceoRow?.projectName).toMatch(/^launch-/);
    expect(bots.findIndex((row) => row.id === chat.id)).toBeGreaterThan(
      bots.findIndex((row) => row.id === ceo.id),
    );
  });

  it("shows a proposed plan, applies it on approval and writes a project brief", async () => {
    const { service, events, fixture } = await setup();
    const ceo = await service.createProject(mkdtempSync(join(tmpdir(), "company-")));
    const projectId = ceo.projectId as string;
    const empty = await service.readCompany(projectId);
    expect(empty).toMatchObject({ ceo: { botId: ceo.id }, teams: [], pendingPlans: [] });

    const teamId = randomUUID();
    const leadId = randomUUID();
    const proposer = new DaemonClient(async () => ({
      url: fixture.daemon.url,
      token: fixture.daemon.token,
    }));
    await proposer.start();
    try {
      await proposer.call(
        "company.propose",
        {
          id: randomUUID(),
          projectId,
          title: "Add a design team",
          explanation: "Design work needs its own lead.",
          changes: [
            {
              kind: "team",
              id: teamId,
              name: "Design",
              parent: { type: "project", id: projectId },
              why: "Design is growing",
            },
            {
              kind: "chat",
              id: leadId,
              title: "Design lead",
              parent: { type: "subproject", id: teamId },
              profileId: "profile",
              manager: true,
              why: "The team needs a manager",
            },
          ],
        },
        randomUUID(),
      );
    } finally {
      proposer.stop();
    }

    await until(() =>
      events.find((event) => event.type === "company-changed" && event.projectId === projectId),
    );
    const proposed = await service.readCompany(projectId);
    expect(proposed.pendingPlans).toHaveLength(1);
    const [plan] = proposed.pendingPlans;
    expect(plan?.changes.map((change) => change.summary)).toEqual([
      `Create the Design team under ${proposed.projectName}`,
      "Hire Design lead as manager in Design",
    ]);

    const applied = await service.decidePlan({
      projectId,
      planId: plan?.id as string,
      version: plan?.version as number,
      approve: true,
    });
    expect(applied.pendingPlans).toHaveLength(0);
    expect(applied.teams).toEqual([
      {
        id: teamId,
        name: "Design",
        manager: { botId: leadId, name: "Design lead" },
        employees: 0,
      },
    ]);

    const briefed = await service.refreshBrief(projectId);
    expect(briefed.brief?.summary).toContain(proposed.projectName);
  });

  it("renames and archives a chat through the daemon", async () => {
    const { service } = await setup();
    const bot = await service.createBot({ profileId: "profile" });
    await until(() => service.listBots().find((row) => row.id === bot.id));
    await service.updateBot({ botId: bot.id, name: "Release notes" });
    await until(() => service.listBots().find((row) => row.name === "Release notes"));
    await service.deleteBot(bot.id);
    await until(() => (service.listBots().some((row) => row.id === bot.id) ? undefined : true));
  });
});
