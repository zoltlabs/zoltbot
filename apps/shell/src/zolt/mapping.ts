import { queueOrderKey, splitQuote } from "@zoltbot/protocol";
import type { BranchOrigin } from "../shared/branches";
import type {
  AgentPromptQuestion,
  ArtifactSummary,
  BotAvatarColor,
  BotAvatarShape,
  BotSummary,
  ContextFullAction,
  ConversationMessage,
  PlanStep,
  QueueDelivery,
  QueueDeliveryStatus,
  QueueSnapshot,
} from "../shared/ipc";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "../shared/ipc";
import { type CompanyRole, companyTree, type TreeEntry } from "./company-tree";
import type { Row, Snapshot } from "./daemon-client";
import { hiddenIds } from "./hidden";
import { isZoltbotNotice, noticeFor, withManagerCards } from "./manager-cards";
import { modelSwitchMessage } from "./models-service";

export const body = (row: Row | undefined): Row =>
  row?.body && typeof row.body === "object" && !Array.isArray(row.body) ? (row.body as Row) : {};
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

export interface BotPreferences {
  notifications?: boolean;
  contextFull?: ContextFullAction;
  avatarShape?: BotAvatarShape;
  avatarColor?: BotAvatarColor;
}

/** Stable small hash so a chat keeps its avatar without stored state. */
export function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The chats the sidebar shows, in company order. */
export function visibleThreads(snapshot: Snapshot): Row[] {
  return companyTree(snapshot).entries.map((entry) => entry.thread);
}

const ROLE_LABELS: Record<CompanyRole, string> = {
  chief: "Chief",
  ceo: "CEO",
  manager: "Manager",
  employee: "Employee",
  chat: "",
};

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

/** A sent reply's own words, without the quote it starts with (C6). */
const previewWords = (value: string) => {
  const reply = splitQuote(value.trim());
  return reply ? reply.rest || reply.quote : value;
};

/** The chat's last words for the sidebar, skipping messages the owner hid (C5). */
export function previewText(items: Row[], hidden: ReadonlySet<string> = new Set()): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as Row;
    if (hidden.has(text(item.id))) continue;
    const value = item.kind === "user" ? userText(item) : text(body(item).text);
    if (isZoltbotNotice(item)) continue;
    if ((item.kind === "user" || item.kind === "message") && value.trim())
      return previewWords(value).replace(/\s+/g, " ").trim().slice(0, 140);
  }
  return "";
}

/** Where a chat was branched from, from the fork provenance on its thread row. */
export function branchOrigin(thread: Row): BranchOrigin | undefined {
  const fork = thread.fork as Row | undefined;
  const point = fork?.boundary as Row | undefined;
  const at = text(point?.kind);
  if (!text(fork?.sourceThreadId) || !text(point?.turnId)) return undefined;
  if (at !== "before_user" && at !== "after_turn") return undefined;
  return { botId: text(fork?.sourceThreadId), turnId: text(point?.turnId), at };
}

/**
 * Whether the owner marked the chat unread, or a turn ended after they last read it. A chat never
 * read on any device counts as read here; the app's own reply count covers new replies there.
 */
export function threadUnread(snapshot: Snapshot, thread: Row): boolean {
  const lastRead = text(thread.lastReadAt);
  if (text(thread.wakeUnreadAt) > lastRead) return true;
  if (!lastRead) return false;
  const id = text(thread.id);
  return (snapshot.entities.turn ?? []).some(
    (turn) => turn.threadId === id && typeof turn.endedAt === "string" && turn.endedAt > lastRead,
  );
}

export function toBotSummary(
  snapshot: Snapshot,
  thread: Row,
  preferences: BotPreferences = {},
  entry?: TreeEntry,
): BotSummary {
  const threadId = text(thread.id);
  const profile = profileFor(snapshot, thread);
  const session = latestSession(snapshot, threadId);
  const projectId = entry ? entry.projectId : text(thread.projectId) || null;
  const project = (snapshot.entities.project ?? []).find((row) => row.id === projectId);
  const roots = Array.isArray(project?.roots) ? (project.roots as Row[]) : [];
  const seed = hash(threadId);
  const branchedFrom = branchOrigin(thread);
  const unread = threadUnread(snapshot, thread);
  return {
    id: threadId,
    name: text(thread.title) || text(profile?.name) || "New chat",
    role: text(profile?.name),
    description: text(profile?.roleText),
    notifications: preferences.notifications ?? true,
    contextFull: preferences.contextFull ?? "ask",
    ...(branchedFrom ? { branchedFrom } : {}),
    ...(unread ? { unread } : {}),
    model: text(session?.model) || text(profile?.model),
    reasoningEffort: text(session?.effort) || text(profile?.effort),
    threadId,
    workspacePath: text(session?.cwd) || text(roots[0]?.path),
    preview: previewText(threadItems(snapshot, threadId), hiddenIds(snapshot, threadId)),
    updatedAt: text(thread.lastActivityAt) || null,
    avatarShape:
      preferences.avatarShape ??
      (BOT_AVATAR_SHAPES[seed % BOT_AVATAR_SHAPES.length] as BotAvatarShape),
    avatarColor:
      preferences.avatarColor ??
      (BOT_AVATAR_COLORS[(seed >>> 8) % BOT_AVATAR_COLORS.length] as BotAvatarColor),
    profileId: text(profile?.id),
    projectId,
    kind: text(thread.kind),
    pinned: thread.pinned === true,
    onboarding: false,
    depth: entry?.depth ?? 0,
    companyRole: entry?.role ?? "chat",
    roleLabel: ROLE_LABELS[entry?.role ?? "chat"],
    parentId: entry?.parentId ?? null,
    projectName: text(project?.name),
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

/**
 * Whether Edit can put the whole queued message back in the composer: the owner's own words,
 * only text, with nothing the composer can't hold (an artifact target or output mode).
 */
export function editableQueued(value: Row): boolean {
  const input = Array.isArray(value.input) ? (value.input as Row[]) : [];
  return (
    !value.origin &&
    !value.artifactTarget &&
    !value.outputMode &&
    input.every((part) => part.type === "text")
  );
}

/** Queued user items in send order: those already on their way, then the owner's order (C1). */
export function queueOrdered(items: Row[]): Row[] {
  const inFlight = (item: Row) => (text(body(item).queueState) === "queued" ? 1 : 0);
  return items
    .filter(isQueued)
    .sort(
      (a, b) =>
        inFlight(a) - inFlight(b) ||
        queueOrderKey(a) - queueOrderKey(b) ||
        Number(a.seq) - Number(b.seq),
    );
}

const PLAN_STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

/**
 * The steps of the newest top-level plan in a chat. A subagent's plan (one with a parent item)
 * belongs to that subagent, not the chat. Steps without text are dropped; an unknown status
 * reads as pending.
 */
export function latestPlan(items: Row[]): PlanStep[] {
  const row = items.findLast((item) => item.kind === "plan" && !text(body(item).parentItemId));
  const entries = body(row).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Row;
    const step = text(value.step).trim();
    if (!step) return [];
    const status = PLAN_STATUSES.includes(text(value.status))
      ? (text(value.status) as PlanStep["status"])
      : "pending";
    return [{ step, status }];
  });
}

/** A centered "Compacted" line where the provider finished compacting the chat's context. */
function compactedMessage(item: Row): ConversationMessage | undefined {
  if (body(item).code !== "context_compacted") return undefined;
  return {
    id: text(item.id),
    author: "assistant",
    source: "system",
    text: "Compacted",
    createdAt: text(item.createdAt),
    status: "completed",
    itemType: "compacted",
  };
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
  const queuedPositions = new Map(queueOrdered(items).map((item, index) => [item.id, index + 1]));
  for (const item of items) {
    const value = body(item);
    if (item.kind === "user") {
      const words = userText(item);
      if (!words.trim()) continue;
      const fromAgent = value.origin === "agent";
      const queueState = text(value.queueState);
      const delivery = QUEUE_STATES[queueState];
      const notice = noticeFor(snapshot, item);
      messages.push({
        id: text(item.id),
        ...(item.turnId ? { turnId: text(item.turnId) } : {}),
        ...(notice ? { notice } : {}),
        author: fromAgent ? "agent" : "user",
        source: notice ? "system" : fromAgent ? "agent" : "user",
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
    if (item.kind === "note") {
      const notice = modelSwitchMessage(item) ?? compactedMessage(item);
      if (notice) messages.push(notice);
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
  attachArtifacts(messages, artifactsByTurn(snapshot, threadId));
  return withManagerCards(snapshot, threadId, messages);
}

/** The thread's live artifacts, keyed by the turn that produced each version. */
export function artifactsByTurn(snapshot: Snapshot, threadId: string): Map<string, ArtifactRef[]> {
  const artifacts = new Map(
    (snapshot.entities.artifact ?? [])
      .filter((artifact) => artifact.threadId === threadId && artifact.state !== "archived")
      .map((artifact) => [text(artifact.id), artifact]),
  );
  const latest = new Map<string, { version: Row; artifact: Row }>();
  for (const version of snapshot.entities.artifactVersion ?? []) {
    const artifact = artifacts.get(text(version.artifactId));
    const turnId = text(version.turnId);
    if (!artifact || !turnId) continue;
    const key = `${turnId}\n${text(artifact.id)}`;
    const previous = latest.get(key);
    if (!previous || Number(version.number) > Number(previous.version.number))
      latest.set(key, { version, artifact });
  }
  const byTurn = new Map<string, ArtifactRef[]>();
  for (const { version, artifact } of latest.values()) {
    const turnId = text(version.turnId);
    const openable =
      version.metadataOnly !== true &&
      version.held !== true &&
      /^[a-f0-9]{64}$/.test(text(version.manifestHash));
    byTurn.set(turnId, [
      ...(byTurn.get(turnId) ?? []),
      {
        id: text(artifact.id),
        versionId: text(version.id),
        title: text(artifact.title),
        kind: text(artifact.kind),
        version: Number(version.number) || 1,
        manifestHash: openable ? text(version.manifestHash) : null,
        createdAt: text(version.createdAt),
      },
    ]);
  }
  for (const list of byTurn.values())
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return byTurn;
}

type ArtifactRef = ArtifactSummary & { createdAt: string };

/**
 * Shows each turn's artifacts under that turn's last reply. A turn that produced artifacts but
 * no reply gets an empty agent message to carry them.
 */
function attachArtifacts(messages: ConversationMessage[], byTurn: Map<string, ArtifactRef[]>) {
  for (const [turnId, refs] of byTurn) {
    const artifacts = refs.map(({ createdAt: _, ...summary }) => summary);
    let last = -1;
    let reply = -1;
    messages.forEach((message, index) => {
      if (message.turnId !== turnId) return;
      last = index;
      if (message.author === "assistant" && message.itemType !== "commentary") reply = index;
    });
    const target = messages[reply];
    if (target) {
      target.artifacts = artifacts;
      continue;
    }
    const carrier: ConversationMessage = {
      id: `artifacts:${turnId}`,
      turnId,
      author: "assistant",
      source: "assistant",
      text: "",
      createdAt: refs[0]?.createdAt ?? "",
      status: "completed",
      itemType: "agentMessage",
      artifacts,
    };
    if (last >= 0) messages.splice(last + 1, 0, carrier);
    else {
      const at = messages.findIndex((message) => message.createdAt > carrier.createdAt);
      messages.splice(at < 0 ? messages.length : at, 0, carrier);
    }
  }
}

export function toQueue(threadId: string, items: Row[]): QueueSnapshot {
  const deliveries: QueueDelivery[] = queueOrdered(items).map((item, index) => ({
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
    editable: editableQueued(body(item)),
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
