import type {
  AgentPromptQuestion,
  BotAvatarColor,
  BotAvatarShape,
  BotSummary,
  ConversationMessage,
  QueueDelivery,
  QueueDeliveryStatus,
  QueueSnapshot,
} from "../shared/ipc";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "../shared/ipc";
import type { Row, Snapshot } from "./daemon-client";

export const VISIBLE_THREAD_KINDS = new Set(["main", "manager", "side"]);

export const body = (row: Row | undefined): Row =>
  row?.body && typeof row.body === "object" && !Array.isArray(row.body) ? (row.body as Row) : {};
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

export interface BotPreferences {
  notifications?: boolean;
  avatarShape?: BotAvatarShape;
  avatarColor?: BotAvatarColor;
}

/** Stable small hash so a chat keeps its avatar without stored state. */
export function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function visibleThreads(snapshot: Snapshot): Row[] {
  return (snapshot.entities.thread ?? [])
    .filter((thread) => thread.archived !== true && VISIBLE_THREAD_KINDS.has(text(thread.kind)))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned === true ? -1 : 1;
      return text(b.lastActivityAt).localeCompare(text(a.lastActivityAt));
    });
}

export function latestSession(snapshot: Snapshot, threadId: string): Row | undefined {
  let latest: Row | undefined;
  for (const session of snapshot.entities.session ?? [])
    if (session.threadId === threadId && text(session.startedAt) >= text(latest?.startedAt))
      latest = session;
  return latest;
}

export function profileFor(snapshot: Snapshot, thread: Row): Row | undefined {
  return (snapshot.entities.agent ?? []).find((agent) => agent.id === thread.agentId);
}

export function threadItems(snapshot: Snapshot, threadId: string): Row[] {
  return (snapshot.entities.item ?? [])
    .filter((item) => item.threadId === threadId)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
}

export function userText(item: Row): string {
  const input = body(item).input;
  if (!Array.isArray(input)) return "";
  return (input as Row[])
    .filter((part) => part.type === "text")
    .map((part) => text(part.text))
    .join("\n");
}

export function previewText(items: Row[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as Row;
    const value = item.kind === "user" ? userText(item) : text(body(item).text);
    if ((item.kind === "user" || item.kind === "message") && value.trim())
      return value.replace(/\s+/g, " ").trim().slice(0, 140);
  }
  return "";
}

export function toBotSummary(
  snapshot: Snapshot,
  thread: Row,
  preferences: BotPreferences = {},
): BotSummary {
  const threadId = text(thread.id);
  const profile = profileFor(snapshot, thread);
  const session = latestSession(snapshot, threadId);
  const project = (snapshot.entities.project ?? []).find((row) => row.id === thread.projectId);
  const roots = Array.isArray(project?.roots) ? (project.roots as Row[]) : [];
  const seed = hash(threadId);
  return {
    id: threadId,
    name: text(thread.title) || text(profile?.name) || "New chat",
    role: text(profile?.name),
    description: text(profile?.roleText),
    notifications: preferences.notifications ?? true,
    model: text(session?.model) || text(profile?.model),
    reasoningEffort: text(session?.effort) || text(profile?.effort),
    threadId,
    workspacePath: text(session?.cwd) || text(roots[0]?.path),
    preview: previewText(threadItems(snapshot, threadId)),
    updatedAt: text(thread.lastActivityAt) || null,
    avatarShape:
      preferences.avatarShape ??
      (BOT_AVATAR_SHAPES[seed % BOT_AVATAR_SHAPES.length] as BotAvatarShape),
    avatarColor:
      preferences.avatarColor ??
      (BOT_AVATAR_COLORS[(seed >>> 8) % BOT_AVATAR_COLORS.length] as BotAvatarColor),
    profileId: text(profile?.id),
    projectId: text(thread.projectId) || null,
    kind: text(thread.kind),
    pinned: thread.pinned === true,
    onboarding: false,
  };
}

const QUEUE_STATES: Record<string, QueueDeliveryStatus> = {
  queued: "queued",
  sending: "starting",
  uncertain: "starting",
  failed: "failed",
};

export function isQueued(item: Row): boolean {
  return (
    item.kind === "user" && ["queued", "sending", "uncertain"].includes(text(body(item).queueState))
  );
}

export function toMessages(
  snapshot: Snapshot,
  threadId: string,
  items: Row[],
): ConversationMessage[] {
  const turns = new Map(
    (snapshot.entities.turn ?? [])
      .filter((turn) => turn.threadId === threadId)
      .map((turn) => [text(turn.id), turn]),
  );
  const messages: ConversationMessage[] = [];
  const queuedPositions = new Map(
    items.filter(isQueued).map((item, index) => [item.id, index + 1]),
  );
  for (const item of items) {
    const value = body(item);
    if (item.kind === "user") {
      const words = userText(item);
      if (!words.trim()) continue;
      const fromAgent = value.origin === "agent";
      const queueState = text(value.queueState);
      const delivery = QUEUE_STATES[queueState];
      messages.push({
        id: text(item.id),
        ...(item.turnId ? { turnId: text(item.turnId) } : {}),
        author: fromAgent ? "agent" : "user",
        source: fromAgent ? "agent" : "user",
        text: words,
        createdAt: text(item.createdAt),
        status: queueState === "failed" ? "failed" : "completed",
        ...(delivery
          ? {
              delivery: {
                id: text(item.id),
                status: delivery,
                position: (queuedPositions.get(item.id) as number | undefined) ?? null,
              },
            }
          : {}),
      });
      continue;
    }
    if (item.kind !== "message") continue;
    const words = text(value.text);
    const turn = item.turnId ? turns.get(text(item.turnId)) : undefined;
    const streaming = value.streaming === true && turn?.status === "running";
    if (!words && !streaming) continue;
    messages.push({
      id: text(item.id),
      ...(item.turnId ? { turnId: text(item.turnId) } : {}),
      author: "assistant",
      source: "assistant",
      text: words,
      createdAt: text(item.createdAt),
      status: streaming
        ? "streaming"
        : turn?.status === "failed"
          ? "failed"
          : turn?.status === "interrupted" && value.partial === true
            ? "interrupted"
            : "completed",
      itemType: text(item.phase) || "agentMessage",
    });
  }
  return messages;
}

export function toQueue(threadId: string, items: Row[]): QueueSnapshot {
  const deliveries: QueueDelivery[] = items.filter(isQueued).map((item, index) => ({
    id: text(item.id),
    messageId: text(item.id),
    recipientBotId: threadId,
    sender: { kind: "user" },
    text: userText(item),
    attachments: [],
    replyToMessageId: null,
    status: QUEUE_STATES[text(body(item).queueState)] ?? "queued",
    position: index + 1,
    turnId: null,
    error: null,
    createdAt: text(item.createdAt),
  }));
  return { botId: threadId, paused: false, deliveries };
}

export function runningTurn(snapshot: Snapshot, threadId: string): Row | undefined {
  return (snapshot.entities.turn ?? []).find(
    (turn) => turn.threadId === threadId && turn.status === "running",
  );
}

const APPROVAL_LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_session: "Allow for this chat",
  allow_accept_edits: "Allow edits for this chat",
  reject_once: "Deny",
};

export interface PromptOption {
  label: string;
  description: string;
  answer: Row;
}

/** Turns a pending interaction into the shell's prompt questions plus how to answer each label. */
export function toPrompt(interaction: Row): {
  questions: AgentPromptQuestion[];
  options: Map<string, PromptOption[]>;
} {
  const items = Array.isArray(interaction.items) ? (interaction.items as Row[]) : [];
  const type = text(interaction.type);
  const options = new Map<string, PromptOption[]>();
  const questions = items.map((item, index) => {
    const id = text(item.id) || `q${index}`;
    let choices: PromptOption[] = [];
    if (type === "approval") {
      const native = Array.isArray(item.choices) ? (item.choices as Row[]) : [];
      for (const choice of native) {
        const label = APPROVAL_LABELS[text(choice.id)];
        if (!label) continue;
        choices.push({
          label,
          description: text(choice.label),
          answer: {
            action: text(choice.id) === "reject_once" ? "decline" : "accept",
            choice: text(choice.id),
          },
        });
      }
      if (!choices.length)
        choices = [
          { label: "Allow", description: "", answer: { action: "accept" } },
          { label: "Deny", description: "", answer: { action: "decline" } },
        ];
    } else if (type === "plan" || type === "gate") {
      choices = [
        { label: "Approve", description: "", answer: { action: "accept" } },
        { label: "Decline", description: "", answer: { action: "decline" } },
      ];
    } else if (Array.isArray(item.options)) {
      choices = (item.options as Row[]).map((option) => ({
        label: text(option.label),
        description: text(option.description),
        answer: { action: "accept", answers: { [id]: { options: [text(option.id)] } } },
      }));
    }
    options.set(id, choices);
    const context = (interaction.context ?? {}) as Row;
    const detail = [text(context.command), text(context.markdown)].filter(Boolean).join("\n\n");
    return {
      id,
      header: text(item.header) || text(interaction.title) || headerFor(type),
      question: [text(item.prompt), detail].filter(Boolean).join("\n\n"),
      isSecret: item.secret === true,
      options: choices.length
        ? choices.map((choice) => ({ label: choice.label, description: choice.description }))
        : null,
    };
  });
  return { questions, options };
}

function headerFor(type: string): string {
  if (type === "approval") return "Approval";
  if (type === "plan") return "Plan";
  if (type === "gate") return "Review";
  return "Question";
}

/** Builds the daemon resolution from the labels or free text the person chose. */
export function toResolution(interaction: Row, answers: Record<string, string[]>, at: string): Row {
  const { options } = toPrompt(interaction);
  const resolution: Row = { action: "accept", by: { kind: "human", id: "local-owner" }, at };
  const free: Record<string, Row> = {};
  for (const [questionId, labels] of Object.entries(answers)) {
    const choices = options.get(questionId) ?? [];
    const matched = labels
      .map((label) => choices.find((choice) => choice.label === label))
      .filter((choice): choice is PromptOption => Boolean(choice));
    if (matched.length) {
      for (const choice of matched) {
        const answer = choice.answer;
        if (answer.action) resolution.action = answer.action;
        if (answer.choice) resolution.choice = answer.choice;
        if (answer.answers) {
          const merged = (resolution.answers ?? {}) as Record<string, Row>;
          for (const [key, value] of Object.entries(answer.answers as Record<string, Row>)) {
            const previous = (merged[key]?.options as string[] | undefined) ?? [];
            merged[key] = { options: [...previous, ...((value.options as string[]) ?? [])] };
          }
          resolution.answers = merged;
        }
      }
    } else if (labels.length) free[questionId] = { other: labels.join("\n") };
  }
  if (Object.keys(free).length)
    resolution.answers = { ...((resolution.answers ?? {}) as Row), ...free };
  return resolution;
}
