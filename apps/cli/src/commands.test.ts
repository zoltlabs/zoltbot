import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";
import {
  ask,
  type Daemon,
  findChat,
  plain,
  type Row,
  status,
  tail,
  task,
  UsageError,
} from "./commands.js";

/** A daemon in memory: tests change rows, then call `changed()`. */
function fakeDaemon(
  rows: Record<string, Row[]>,
  answer?: (method: string, params: Row) => unknown,
) {
  const listeners = new Set<() => void>();
  const calls: { method: string; params: Row }[] = [];
  const daemon: Daemon & { changed(): void } = {
    async call(method, params) {
      calls.push({ method, params: params as Row });
      return answer?.(method, params as Row) ?? {};
    },
    rows: (kind) => rows[kind] ?? [],
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    changed: () => {
      for (const listener of [...listeners]) listener();
    },
  };
  return { daemon, calls };
}

const output = (json = false) => {
  const lines: string[] = [];
  const notes: string[] = [];
  return {
    lines,
    notes,
    json,
    write: (line: string) => lines.push(line),
    note: (line: string) => notes.push(line),
  };
};

const base = (): Record<string, Row[]> => ({
  agent: [{ id: "a1", name: "Ada" }],
  thread: [
    {
      id: "t1",
      title: "Website",
      agentId: "a1",
      projectId: "p1",
      kind: "main",
      archived: false,
      lastActivityAt: "2026-11-06T10:00:00.000Z",
    },
    {
      id: "t0",
      title: "Old",
      agentId: "a1",
      kind: "main",
      archived: true,
      lastActivityAt: "2026-11-07T10:00:00.000Z",
    },
  ],
});

describe("R5 zolt", () => {
  it("reads arguments and options", () => {
    expect(parseArgs(["ask", "Ada", "hi", "there", "--json", "--timeout", "5"])).toMatchObject({
      command: "ask",
      args: ["Ada", "hi", "there"],
      json: true,
      timeoutMs: 5000,
    });
    expect(() => parseArgs(["status", "--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["ask", "--timeout", "soon"])).toThrow(UsageError);
    expect(
      parseArgs(["ask", "Ada", "--timeout=30", "--", "--json", "is", "a", "flag"]),
    ).toMatchObject({ args: ["Ada", "--json", "is", "a", "flag"], json: false, timeoutMs: 30_000 });
  });

  it("finds a chat by id, title or agent, skipping archived chats", () => {
    const { daemon } = fakeDaemon(base());
    expect(findChat(daemon, "t1").id).toBe("t1");
    expect(findChat(daemon, "website").id).toBe("t1");
    expect(findChat(daemon, "ADA").id).toBe("t1");
    expect(() => findChat(daemon, "Old")).toThrow(UsageError);
  });

  it("reports status, with exit code 2 when something needs you", async () => {
    const rows: Record<string, Row[]> = {
      ...base(),
      turn: [{ id: "u", threadId: "t1", status: "running" }],
    };
    const { daemon } = fakeDaemon(rows);
    const text = output();
    expect(await status(daemon, text)).toBe(0);
    expect(text.lines[0]).toBe("1 chats, 1 working, 0 need you.");
    expect(text.lines[1]).toBe("* Website (Ada)");
    rows.interaction = [{ id: "i", threadId: "t1", state: "pending" }];
    const json = output(true);
    expect(await status(daemon, json)).toBe(2);
    expect(JSON.parse(json.lines[0] ?? "")).toMatchObject({
      needsYou: 1,
      chats: [{ id: "t1", working: true }],
    });
  });

  it("asks, waits for its own turn and prints only the final reply", async () => {
    const message = { id: "m1", threadId: "t1", kind: "user", body: { queueState: "queued" } };
    const rows = { ...base(), turn: [] as Row[], item: [message] as Row[] };
    const { daemon, calls } = fakeDaemon(rows, () => ({ id: "m1", disposition: "queued" }));
    const text = output();
    const done = ask(daemon, text, "Ada", "Summarize today");
    await Promise.resolve();
    // A routine's turn ends first; it isn't the reply.
    rows.turn.push({ id: "other", threadId: "t1", status: "completed" });
    daemon.changed();
    rows.turn.push({ id: "turn-1", threadId: "t1", status: "running" });
    rows.item[0] = { ...message, turnId: "turn-1", body: { queueState: "sent" } };
    daemon.changed();
    rows.item.push(
      {
        id: "c",
        turnId: "turn-1",
        kind: "message",
        phase: "commentary",
        seq: 2,
        body: { text: "Looking." },
      },
      {
        id: "x",
        turnId: "turn-1",
        kind: "message",
        phase: "final",
        seq: 3,
        body: { text: "All quiet." },
      },
    );
    rows.turn[1] = { ...rows.turn[1], status: "completed" };
    daemon.changed();
    expect(await done).toBe(0);
    expect(text.lines).toEqual(["All quiet."]);
    expect(calls[0]).toMatchObject({
      method: "turn.send",
      params: { threadId: "t1", input: [{ type: "text", text: "Summarize today" }] },
    });
  });

  it("exits 2 for permission, 1 for a failed message or turn, and 1 on timeout", async () => {
    const rows = { ...base(), turn: [] as Row[], interaction: [] as Row[], item: [] as Row[] };
    const { daemon } = fakeDaemon(rows, () => ({ id: "m", disposition: "started" }));
    const waiting = ask(daemon, output(), "Ada", "Deploy");
    rows.interaction.push({ id: "i", threadId: "t1", state: "pending" });
    daemon.changed();
    expect(await waiting).toBe(2);
    rows.interaction.length = 0;
    rows.item.push({ id: "m", threadId: "t1", kind: "user", body: { queueState: "failed" } });
    const failed = output(true);
    expect(await ask(daemon, failed, "Ada", "Deploy")).toBe(1);
    expect(JSON.parse(failed.lines[0] ?? "")).toMatchObject({ status: "failed" });
    rows.item[0] = { id: "m", threadId: "t1", kind: "user", turnId: "turn-2", body: {} };
    rows.turn.push({ id: "turn-2", threadId: "t1", status: "failed" });
    const text = output();
    expect(await ask(daemon, text, "Ada", "Deploy")).toBe(1);
    expect(text.lines).toEqual([]);
    expect(text.notes[0]).toBe("The agent couldn't finish.");
    rows.turn[0] = { id: "turn-2", threadId: "t1", status: "running" };
    const slow = output(true);
    expect(await ask(daemon, slow, "Ada", "Deploy", 5)).toBe(1);
    expect(JSON.parse(slow.lines[0] ?? "")).toMatchObject({ status: "timed_out" });
  });

  it("starts a task in the chat's project and follows it with --wait", async () => {
    const rows = { ...base(), task: [] as Row[] };
    const { daemon, calls } = fakeDaemon(rows, () => ({ id: "task-1", state: "queued" }));
    const following = task(daemon, output(), "Ada", "Fix the build\nIt fails on main.", {
      wait: true,
    });
    await Promise.resolve();
    rows.task.push({ id: "task-1", state: "review" });
    daemon.changed();
    expect(await following).toBe(0);
    expect(calls[0]?.params).toMatchObject({
      title: "Fix the build",
      profileId: "a1",
      node: { type: "project", id: "p1" },
    });
    rows.task[0] = { id: "task-1", state: "blocked" };
    expect(await task(daemon, output(), "Ada", "Again", { wait: true })).toBe(2);
  });

  it("tails the last messages, then new ones once final", () => {
    const rows = {
      ...base(),
      turn: [{ id: "r", threadId: "t1", status: "running" }] as Row[],
      item: Array.from({ length: 12 }, (_, index) => ({
        id: `i${index}`,
        threadId: "t1",
        kind: "user",
        seq: index + 1,
        body: { text: `note ${index}` },
      })) as Row[],
    };
    const { daemon } = fakeDaemon(rows);
    const text = output();
    const stop = tail(daemon, text, "Ada");
    expect(text.lines).toHaveLength(10);
    expect(text.lines[0]).toBe("you: note 2");
    rows.item.push({
      id: "s",
      threadId: "t1",
      turnId: "r",
      kind: "message",
      seq: 20,
      body: { text: "Work" },
    });
    daemon.changed();
    expect(text.lines).toHaveLength(10);
    rows.turn[0] = { id: "r", threadId: "t1", status: "completed" };
    daemon.changed();
    expect(text.lines.at(-1)).toBe("agent: Work");
    stop();
  });

  it("strips terminal control codes from agent text", () => {
    expect(plain("ok\u001b[2J\u001b]52;c;aGk=\u0007 done\n\tnext\u0007")).toBe("ok done\n\tnext");
  });
});
