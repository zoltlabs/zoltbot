// R5: what each zolt command does, over a small daemon interface so tests can drive it.
import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;

/** The part of the daemon client the commands use. */
export interface Daemon {
  call(method: string, params: unknown, commandId?: string): Promise<unknown>;
  rows(kind: string): Row[];
  onChange(listener: () => void): () => void;
}

export interface Output {
  /** Text for people, or one JSON object per line with --json. */
  json: boolean;
  write(line: string): void;
  /** Text for people that isn't the answer: needs you, failures. Goes to stderr. */
  note(line: string): void;
}

/** The one shape every --json result has; the command's own fields ride alongside. */
export type Status = "done" | "failed" | "needs_you" | "timed_out";

/** 0 done, 1 failed, 2 needs you. */
export type ExitCode = 0 | 1 | 2;

export class UsageError extends Error {}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const body = (item: Row) =>
  item.body && typeof item.body === "object" ? (item.body as Row) : ({} as Row);

// Escape sequences (CSI, OSC) and the other C0/C1 control characters, keeping newlines and tabs.
const TERMINAL_CODES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters removed.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Agent text without terminal control codes, which could redraw the screen or set the clipboard. */
export function plain(words: string): string {
  return words.replace(TERMINAL_CODES, "");
}

function print(output: Output, value: Row & { status: Status }, words: string) {
  if (output.json) output.write(JSON.stringify(value));
  else if (value.status === "done") output.write(plain(words));
  else output.note(plain(words));
}

const CODES: Record<Status, ExitCode> = { done: 0, failed: 1, needs_you: 2, timed_out: 1 };

/** Ten minutes, so a script never hangs on a chat that stopped answering. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

class TimedOut extends Error {}

/** The chat a name means: its id, its title, or the most recent chat of an agent by that name. */
export function findChat(daemon: Daemon, name: string): Row {
  const wanted = name.trim().toLowerCase();
  const chats = daemon
    .rows("thread")
    .filter((thread) => thread.archived !== true && (thread.kind ?? "main") === "main")
    .sort((a, b) => text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)));
  const agents = new Map(
    daemon.rows("agent").map((agent) => [text(agent.id), text(agent.name).toLowerCase()]),
  );
  const chat =
    chats.find((thread) => thread.id === name) ??
    chats.find((thread) => text(thread.title).toLowerCase() === wanted) ??
    chats.find((thread) => agents.get(text(thread.agentId)) === wanted);
  if (!chat)
    throw new UsageError(`No chat or agent named "${name}". Run "zolt status" to list them.`);
  return chat;
}

/** Waits until `check` returns a value, re-checking on every daemon change. */
function until<T>(daemon: Daemon, check: () => T | undefined, timeoutMs?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stop();
            reject(new TimedOut());
          }, timeoutMs);
    const look = () => {
      const value = check();
      if (value === undefined) return;
      stop();
      clearTimeout(timer);
      resolve(value);
    };
    stop = daemon.onChange(look);
    look();
  });
}

const pendingIn = (daemon: Daemon, threadId: unknown) =>
  daemon.rows("interaction").find((row) => row.threadId === threadId && row.state === "pending");

export async function status(daemon: Daemon, output: Output): Promise<ExitCode> {
  const agents = new Map(daemon.rows("agent").map((agent) => [agent.id, text(agent.name)]));
  const chats = daemon
    .rows("thread")
    .filter((thread) => thread.archived !== true && (thread.kind ?? "main") === "main");
  const running = new Set(
    daemon
      .rows("turn")
      .filter((turn) => turn.status === "running")
      .map((turn) => turn.threadId),
  );
  const needsYou = daemon.rows("interaction").filter((row) => row.state === "pending").length;
  const next = daemon
    .rows("routine")
    .filter((routine) => !routine.paused && !routine.doneAt && !routine.event)
    .sort((a, b) => text(a.nextRunAt).localeCompare(text(b.nextRunAt)))[0];
  if (output.json) {
    output.write(
      JSON.stringify({
        status: needsYou ? "needs_you" : "done",
        chats: chats.map((chat) => ({
          id: chat.id,
          title: chat.title,
          agent: agents.get(chat.agentId) ?? null,
          working: running.has(chat.id),
        })),
        needsYou,
        nextRoutine: next ? { name: next.name, at: next.nextRunAt } : null,
      }),
    );
    return needsYou ? 2 : 0;
  }
  output.write(`${chats.length} chats, ${running.size} working, ${needsYou} need you.`);
  for (const chat of chats)
    output.write(
      `${running.has(chat.id) ? "*" : " "} ${text(chat.title)}${agents.has(chat.agentId) ? ` (${agents.get(chat.agentId)})` : ""}`,
    );
  if (next) output.write(`Next routine: ${text(next.name)} at ${text(next.nextRunAt)}`);
  return needsYou ? 2 : 0;
}

/** Sends a message and prints the reply once the agent's turn ends. */
export async function ask(
  daemon: Daemon,
  output: Output,
  name: string,
  words: string,
  timeoutMs?: number,
): Promise<ExitCode> {
  if (!words.trim())
    throw new UsageError('Say what to ask, such as zolt ask Ada "Summarize today".');
  const chat = findChat(daemon, name);
  const sent = (await daemon.call(
    "turn.send",
    {
      threadId: chat.id,
      input: [{ type: "text", text: words }],
      mode: "queue",
      outputMode: "auto",
    },
    randomUUID(),
  )) as { id?: string; disposition?: string };
  const where = { chat: chat.id, message: sent.id };
  if (sent.disposition === "handled") {
    print(output, { ...where, status: "done", reply: "" }, "");
    return 0;
  }
  // The message's own item says which turn answers it, so another client's message or a routine
  // waking the chat is never mistaken for the reply.
  type Outcome = { status: Status; turn?: Row };
  let outcome: Outcome;
  try {
    outcome = await until<Outcome>(
      daemon,
      () => {
        const item = daemon.rows("item").find((row) => row.id === sent.id);
        const state = text(body(item ?? {}).queueState);
        if (state === "handled") return { status: "done" };
        if (state === "failed" || state === "uncertain") return { status: "failed" };
        const turn = item?.turnId
          ? daemon.rows("turn").find((row) => row.id === item.turnId)
          : undefined;
        if (turn && turn.status !== "running")
          return { status: turn.status === "completed" ? "done" : "failed", turn };
        if (pendingIn(daemon, chat.id)) return { status: "needs_you" };
        return undefined;
      },
      timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } catch (error) {
    if (!(error instanceof TimedOut)) throw error;
    outcome = { status: "timed_out" };
  }
  if (outcome.status === "needs_you" || outcome.status === "timed_out") {
    print(
      output,
      { ...where, status: outcome.status },
      outcome.status === "needs_you"
        ? `${text(chat.title)} needs you. Open Zoltbot to answer.`
        : `Still working. Run zolt tail "${text(chat.title)}" to follow it.`,
    );
    return CODES[outcome.status];
  }
  const messages = daemon
    .rows("item")
    .filter((item) => outcome.turn && item.turnId === outcome.turn.id && item.kind === "message")
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  // The answer is the final message; progress notes along the way are left out.
  const finals = messages.filter((item) => item.phase === "final");
  const reply = (finals.length ? finals : messages.slice(-1))
    .map((item) => text(body(item).text))
    .filter(Boolean)
    .join("\n\n");
  print(
    output,
    {
      ...where,
      status: outcome.status,
      ...(outcome.turn ? { turn: outcome.turn.id, turnStatus: outcome.turn.status } : {}),
      reply,
    },
    outcome.status === "done" ? reply : `The agent couldn't finish.${reply ? `\n${reply}` : ""}`,
  );
  return CODES[outcome.status];
}

const TASK_DONE = ["review", "completed"];
const TASK_FAILED = ["failed", "cancelled"];

/** Starts a task for an agent; with `wait`, follows it to the end. */
export async function task(
  daemon: Daemon,
  output: Output,
  name: string,
  brief: string,
  options: { wait: boolean; timeoutMs?: number | undefined },
): Promise<ExitCode> {
  if (!brief.trim())
    throw new UsageError('Say what the task is, such as zolt task Ada "Fix the build".');
  const chat = findChat(daemon, name);
  const node =
    chat.node ??
    (typeof chat.projectId === "string" ? { type: "project", id: chat.projectId } : undefined);
  if (!node)
    throw new UsageError(`${text(chat.title)} isn't in a project, so it can't take tasks.`);
  const title = brief.trim().split("\n")[0]?.slice(0, 150) ?? brief;
  const created = (await daemon.call(
    "task.create",
    { title, brief: brief.trim(), profileId: chat.agentId, node },
    randomUUID(),
  )) as Row;
  const id = created.id;
  if (!options.wait) {
    print(
      output,
      { task: id, status: "done", state: created.state ?? "queued" },
      `Started. Run zolt tail "${text(chat.title)}" to follow it.`,
    );
    return 0;
  }
  let state: string;
  try {
    state = await until(
      daemon,
      () => {
        const row = daemon.rows("task").find((entry) => entry.id === id);
        const current = text(row?.state);
        return [...TASK_DONE, ...TASK_FAILED, "blocked"].includes(current) ? current : undefined;
      },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  } catch (error) {
    if (!(error instanceof TimedOut)) throw error;
    state = "timed_out";
  }
  const result: Status = TASK_DONE.includes(state)
    ? "done"
    : state === "blocked"
      ? "needs_you"
      : state === "timed_out"
        ? "timed_out"
        : "failed";
  const words: Record<Status, string> = {
    done: state === "review" ? "Ready for review." : "Done.",
    needs_you: "The task needs you. Open Zoltbot to answer.",
    timed_out: `Still working. Run zolt tail "${text(chat.title)}" to follow it.`,
    failed: state === "cancelled" ? "The task was cancelled." : "The task failed.",
  };
  print(output, { task: id, status: result, state }, words[result]);
  return CODES[result];
}

/** Prints a chat's messages as they arrive, until stopped. */
export function tail(daemon: Daemon, output: Output, name: string, last = 10): () => void {
  const chat = findChat(daemon, name);
  const earlier = daemon
    .rows("item")
    .filter((row) => row.threadId === chat.id && ["user", "message"].includes(text(row.kind)))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  // Only the last few earlier messages print; the rest count as already shown.
  const printed = new Set<unknown>(
    earlier.slice(0, Math.max(0, earlier.length - last)).map((row) => row.id),
  );
  const show = () => {
    for (const item of daemon
      .rows("item")
      .filter((row) => row.threadId === chat.id)
      .sort((a, b) => Number(a.seq) - Number(b.seq))) {
      if (printed.has(item.id) || !["user", "message"].includes(text(item.kind))) continue;
      // A message still streaming has no phase yet; wait for it, and for everything after it,
      // so lines print in order.
      if (item.kind === "message" && item.phase === undefined && runningTurn(daemon, item.turnId))
        break;
      const words = text(body(item).text);
      if (!words) continue;
      printed.add(item.id);
      print(
        output,
        {
          chat: chat.id,
          status: "done",
          id: item.id,
          author: item.kind === "user" ? "you" : "agent",
          text: words,
        },
        `${item.kind === "user" ? "you" : "agent"}: ${words}`,
      );
    }
  };
  show();
  return daemon.onChange(show);
}

const runningTurn = (daemon: Daemon, turnId: unknown) =>
  daemon.rows("turn").some((turn) => turn.id === turnId && turn.status === "running");
