import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentContinueKey, fileMimeType, MUTED_PREFIX } from "@zoltbot/protocol";
import { type Outbox, turnOutbox, unreachable, waitingMessage } from "../main/outbox";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelOption,
  AgentStatus,
  AttachmentSummary,
  BotSummary,
  CompanyOverview,
  ConversationMessage,
  ConversationSnapshot,
  DecidePlanInput,
  DraftAttachment,
  MessageReaction,
  QueuedMessageReceipt,
  QueueSnapshot,
  RespondToPromptInput,
  SendMessageInput,
  SetMessageReactionInput,
  TaskActionInput,
  UpdateBotInput,
} from "../shared/ipc";
import type { StaffActionInput } from "../shared/staff";
import type { ReviewTaskInput, TaskSummary } from "../shared/tasks";
import { type AgentChecks, agentChecks, missingAgents, providerStatuses } from "./agent-checks";
import { chooseAgent } from "./agent-choice";
import { asideSource, asideThreads, withAsides } from "./asides";
import { CHANNEL_ROWS, channelService } from "./channel-service";
import { decidePlan, readCompany, refreshBrief } from "./company-service";
import { companyTree } from "./company-tree";
import { contextService } from "./context-service";
import type { DaemonClient, Row, SnapshotChange } from "./daemon-client";
import { artifactDocuments } from "./documents/artifacts";
import { DocumentsService } from "./documents/service";
import { DraftStore } from "./draft-store";
import { setFastMode } from "./fast-mode";
import { withHidden } from "./hidden";
import { relatedThreads, runTaskAction } from "./manager-cards";
import {
  type BotPreferences,
  body,
  latestPlan,
  latestSession,
  runningTurn,
  text,
  threadItems,
  toBotSummary,
  toMessages,
  toPrompt,
  toQueue,
  toResolution,
  visibleThreads,
} from "./mapping";
import { messageParts } from "./message-parts";
import { modelsService, switchDialogFor } from "./models-service";
import { pinnedMessages } from "./pins";
import { withProgress } from "./progress";
import { setReaction, withReactions } from "./reactions";
import { type AttachmentSource, sentAttachmentSource } from "./sent-attachments";
import { changesSpend } from "./spend-view";
import { isStaffApproval, runStaffAction, staffProject, toStaffOverview } from "./staff-view";
import { toTaskSummaries } from "./tasks-view";
import { callParts, sendMode, withCalls } from "./voice-calls";
import { workingStatus } from "./working-status";

interface Preferences {
  bots: Record<string, BotPreferences>;
  reactions: Record<string, MessageReaction>;
}

interface Conversation {
  revision: number;
  history: Map<string, Row>;
  texts: Map<string, string>;
  pending: ConversationMessage[];
  loaded: boolean;
  loading?: Promise<void>;
}

/** Rows that change what a project's Organization panel shows. */
const COMPANY_ROWS = new Set([
  "project",
  "subproject",
  "thread",
  "task",
  "taskResult",
  "companyPlan",
  "projectBrief",
  "initiativeRecord",
  "managerRemit",
  ...CHANNEL_ROWS,
]);

/**
 * The shell's agent backend. It keeps OpenBot's AgentService surface so the renderer stays as it
 * is, and answers every call from the Zoltbot daemon's snapshot. Sends show up at once: the
 * message joins the conversation before the daemon confirms it.
 */
export class ZoltService extends EventEmitter<{ event: [AgentEvent] }> {
  private preferences: Preferences = { bots: {}, reactions: {} };
  private readonly conversations = new Map<string, Conversation>();
  private readonly drafts = new DraftStore();
  private readonly prompts = new Map<string, string>();
  private readonly turns = new Map<string, string | null>();
  private lastBots = "";
  private dirty = new Set<string>();
  private botsDirty = false;
  /** Projects whose company changed since the last flush; null stands for every project. */
  private companyDirty = new Set<string | null>();
  /** Pages that re-read when their rows change: Memory (S5) and Usage (S6). */
  private readonly pagesDirty = new Set<"memory-changed" | "spend-changed">();
  private flushScheduled = false;
  private models: AgentModelOption[] = [];
  /** When each agent was last asked for its models, so reopening the picker doesn't ask again. */
  private readonly modelsAsked = new Map<string, number>();
  private agentChecks: AgentChecks;
  private checking: Promise<AgentStatus> | undefined;

  /** Coding tool sign-ins and backup orders. */
  readonly accounts: ReturnType<typeof modelsService>;
  /** C12: messages waiting until the daemon is reachable. */
  readonly outbox: Outbox;
  /** How full each chat's context is, and compaction. */
  readonly context: ReturnType<typeof contextService>;
  /** Markdown files in project folders, with comments, reviews and versions. */
  readonly documents: DocumentsService;
  /** Agents' Markdown artifacts as text, to compare versions and save them as documents. */
  readonly artifactTexts: ReturnType<typeof artifactDocuments>;

  constructor(
    readonly client: DaemonClient,
    private readonly dataPath: string,
  ) {
    super();
    this.accounts = modelsService(client);
    this.context = contextService(client, (botId) => this.preferences.bots[botId]?.contextFull);
    this.context.attach(this);
    this.documents = new DocumentsService(client, join(dataPath, "documents"), {
      name: (botId) => this.listBots().find((bot) => bot.id === botId)?.name ?? null,
      profileId: (botId) => this.listBots().find((bot) => bot.id === botId)?.profileId || null,
    });
    this.artifactTexts = artifactDocuments(client, this.documents);
    client.onChange((change) => this.changed(change));
    this.outbox = turnOutbox(client, this.file("outbox.json"), (id) => this.emitConversation(id));
  }

  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file("preferences.json"), "utf8"));
      this.preferences = { bots: raw.bots ?? {}, reactions: raw.reactions ?? {} };
    } catch {}
    await this.outbox.load();
    await this.client.start();
  }

  async stop(): Promise<void> {
    this.client.stop();
  }

  getStatus(): AgentStatus {
    const online = this.client.status === "online";
    const providers = providerStatuses(
      this.client.rows("agentDefinition"),
      this.agentChecks,
      online,
    );
    const checked = this.agentChecks instanceof Map;
    return {
      phase: online ? "ready" : this.client.status === "connecting" ? "starting" : "stopped",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers,
      capabilities: {
        chat: !online
          ? "unavailable"
          : checked && !providers.some((provider) => provider.state === "available")
            ? "setup-required"
            : "ready",
        browser: "unavailable",
        computerUse: "unavailable",
      },
      message: online ? null : (this.client.error ?? "Connecting to Zoltbot…"),
      fullAccess: false,
    };
  }

  /**
   * Asks the daemon which agents are installed and signed in. With `scan` it looks for installs
   * again first; without it, it only scans when the daemon hasn't scanned since it started.
   */
  refreshAgents(scan = true): Promise<AgentStatus> {
    if (this.client.status !== "online") return Promise.resolve(this.getStatus());
    if (this.checking && !scan) return this.checking;
    const checking: Promise<AgentStatus> = this.readAgentChecks(scan).then(() => {
      if (this.checking === checking) this.checking = undefined;
      const status = this.getStatus();
      this.emit("event", { type: "status", status });
      return status;
    });
    this.checking = checking;
    return checking;
  }

  private async readAgentChecks(scan: boolean): Promise<void> {
    try {
      if (scan) await this.client.call("detect.scan", {});
      let checks = agentChecks(await this.client.call("doctor.report", {}));
      if (!scan && checks.size === 0) {
        await this.client.call("detect.scan", {});
        checks = agentChecks(await this.client.call("doctor.report", {}));
      }
      this.agentChecks = checks;
    } catch {
      this.agentChecks = this.client.status === "online" ? "failed" : undefined;
    }
    await this.addReadyAgents().catch(() => undefined);
  }

  private adding?: Promise<void>;
  /** Adds an agent for every installed, signed-in tool that doesn't have one yet. */
  private addReadyAgents(): Promise<void> {
    this.adding ??= (async () => {
      for (const provider of missingAgents(
        this.getStatus().providers ?? [],
        this.client.rows("agent"),
      )) {
        const id = randomUUID();
        const name = provider.name || provider.id;
        await this.client.call(
          "agent.create",
          {
            value: {
              id,
              name,
              avatar: name.slice(0, 1) || "A",
              kind: "profile",
              definitionId: provider.id,
              permissionProfile: "workspace_write",
              instructions: "",
              hidden: false,
              archived: false,
            },
          },
          `shell:agent:${provider.id}:${id}`,
        );
      }
    })().finally(() => {
      this.adding = undefined;
    });
    return this.adding;
  }

  async getUsage(): Promise<AccountUsage> {
    return { limits: [] };
  }

  listBots(): BotSummary[] {
    const snapshot = this.client.snapshot;
    return companyTree(snapshot).entries.map((entry) =>
      toBotSummary(snapshot, entry.thread, this.preferences.bots[text(entry.thread.id)], entry),
    );
  }

  async listModels(): Promise<AgentModelOption[]> {
    if (this.client.status !== "online") return this.models;
    const catalog = (await this.client.call("model.catalog", {})) as { items: Row[] };
    const names = new Map(
      this.client.rows("agentDefinition").map((row) => [text(row.id), text(row.displayName)]),
    );
    this.models = catalog.items.flatMap((entry) => {
      const efforts = (Array.isArray(entry.effort) ? entry.effort : []).filter(
        (value): value is string => typeof value === "string",
      );
      const provider = text(entry.definitionId);
      return (Array.isArray(entry.models) ? (entry.models as Row[]) : []).map((model) => ({
        id: text(model.id),
        name: text(model.name) || text(model.id),
        provider,
        providerName: names.get(provider) || provider,
        description: "",
        defaultReasoningEffort: efforts[Math.floor(efforts.length / 2)] ?? "",
        supportedReasoningEfforts: efforts,
      }));
    });
    return this.models;
  }

  /**
   * Asks agents with no models yet for their list (Claude Code and Codex answer without a chat),
   * then lists every model and tells the windows. Each agent is asked at most once a minute.
   */
  async refreshModels(providers: string[]): Promise<AgentModelOption[]> {
    if (this.client.status !== "online") return this.models;
    const now = Date.now();
    const due = [...new Set(providers)].filter(
      (id) => now - (this.modelsAsked.get(id) ?? 0) > 60_000,
    );
    if (!due.length) return this.models;
    for (const id of due) this.modelsAsked.set(id, now);
    await Promise.all(
      due.map((definitionId) =>
        this.client.call("model.refresh", { definitionId }).catch(() => undefined),
      ),
    );
    const models = await this.listModels();
    this.emit("event", { type: "models-changed", models });
    return models;
  }

  /** Creates a project for a folder and its CEO, the manager accountable for the whole project. */
  async createProject(path: string): Promise<BotSummary> {
    const profiles = this.client
      .rows("agent")
      .filter((row) => row.archived !== true && row.hidden !== true);
    if (!chooseAgent(profiles)) throw new Error("Add an agent in Zoltbot first.");
    // A project saved for this folder without its CEO (an earlier attempt failed) gets one now.
    const managed = new Set(
      this.client
        .rows("thread")
        .filter((row) => row.kind === "manager")
        .map((row) => row.projectId),
    );
    const unfinished = this.client
      .rows("project")
      .find(
        (row) =>
          row.archived !== true &&
          !managed.has(row.id) &&
          Array.isArray(row.roots) &&
          (row.roots as Record<string, unknown>[]).some((root) => root.path === path),
      );
    if (typeof unfinished?.id === "string")
      return this.createBot({ projectId: unfinished.id, manager: true });
    const now = new Date().toISOString();
    const id = randomUUID();
    const name = basename(path) || "Project";
    await this.client.call(
      "project.create",
      {
        value: {
          id,
          name,
          goal: "",
          instructions: "",
          constraints: "",
          roots: [{ path, label: "Code" }],
          hierarchyDepth: 3,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: now,
        },
      },
      `shell:project:${id}`,
    );
    return this.createBot({ projectId: id, manager: true });
  }

  async createBot(
    input: {
      profileId?: string;
      projectId?: string | null;
      manager?: boolean;
      title?: string;
    } = {},
  ): Promise<BotSummary> {
    const profiles = this.client
      .rows("agent")
      .filter((row) => row.archived !== true && row.hidden !== true);
    const project = input.projectId
      ? this.client.rows("project").find((row) => row.id === input.projectId)
      : undefined;
    const profile = chooseAgent(profiles, {
      profileId: input.profileId,
      defaultAgentId: project?.defaultAgentId,
    });
    if (!profile) throw new Error("Add an agent in Zoltbot first.");
    const now = new Date().toISOString();
    const id = randomUUID();
    const thread = (await this.client.call(
      "thread.create",
      {
        value: {
          id,
          agentId: profile.id,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.manager && input.projectId
            ? { node: { type: "project", id: input.projectId } }
            : {}),
          kind: input.manager ? "manager" : "main",
          title: input.title || text(profile.name) || "New chat",
          titleSource: "auto",
          pinned: false,
          archived: false,
          createdAt: now,
          lastActivityAt: now,
        },
        // A manager gets authority over the project; the person asked for it by creating one.
        ...(input.manager ? { confirmed: true } : {}),
      },
      `shell:thread:${id}`,
    )) as Row;
    const entry = companyTree(this.client.snapshot).entries.find((row) => row.thread.id === id);
    return toBotSummary(this.client.snapshot, thread, this.preferences.bots[id], entry);
  }

  async updateBot(input: UpdateBotInput): Promise<BotSummary> {
    const thread = this.thread(input.botId);
    const calls: Promise<unknown>[] = [];
    if (input.name?.trim() && input.name !== thread.title)
      calls.push(
        this.client.call(
          "thread.rename",
          { id: thread.id, title: input.name.trim() },
          randomUUID(),
        ),
      );
    const session = latestSession(this.client.snapshot, input.botId);
    if (input.model !== undefined || input.reasoningEffort !== undefined) {
      if (session?.state === "ready" || session?.state === "running") {
        if (input.model)
          calls.push(
            this.client.call(
              "session.setModel",
              {
                id: session.id,
                model: input.model,
                ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
                cacheWarningAccepted: true,
              },
              randomUUID(),
            ),
          );
        else if (input.reasoningEffort)
          calls.push(
            this.client.call(
              "session.setEffort",
              { id: session.id, effort: input.reasoningEffort, cacheWarningAccepted: true },
              randomUUID(),
            ),
          );
      } else
        calls.push(
          this.client.call(
            "agent.update",
            {
              id: thread.agentId,
              changes: {
                ...(input.model ? { model: input.model } : {}),
                ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
              },
            },
            randomUUID(),
          ),
        );
    }
    if (input.talkingStyle !== undefined)
      calls.push(
        this.client.call(
          "agent.update",
          { id: thread.agentId, changes: { style: input.talkingStyle } },
          randomUUID(),
        ),
      );
    if (input.fastMode !== undefined)
      calls.push(setFastMode(this.client, text(thread.agentId), session, input.fastMode));
    if (input.continueTurns !== undefined)
      calls.push(
        this.client.call(
          "settings.set",
          { key: agentContinueKey(text(thread.agentId)), value: input.continueTurns },
          randomUUID(),
        ),
      );
    if (input.role !== undefined)
      calls.push(
        this.client.call(
          "agent.update",
          { id: thread.agentId, changes: { roleText: input.role } },
          randomUUID(),
        ),
      );
    const local: BotPreferences = { ...this.preferences.bots[input.botId] };
    if (input.notifications !== undefined) local.notifications = input.notifications;
    if (input.avatarShape) local.avatarShape = input.avatarShape;
    if (input.avatarColor) local.avatarColor = input.avatarColor;
    if (input.contextFull) local.contextFull = input.contextFull;
    this.preferences.bots[input.botId] = local;
    await Promise.all([...calls, this.save()]);
    this.markBots();
    return toBotSummary(this.client.snapshot, this.thread(input.botId), local);
  }

  /** Reads one project's company: its people, pending plans, initiatives and latest brief. */
  readCompany(projectId: string): Promise<CompanyOverview> {
    return readCompany(this.client, projectId);
  }

  /** The person's decision on a plan. The daemon refuses it if the plan or company changed. */
  decidePlan(input: DecidePlanInput): Promise<CompanyOverview> {
    return decidePlan(this.client, input);
  }

  /** Writes a new project brief from the current work, then returns the updated company. */
  refreshBrief(projectId: string): Promise<CompanyOverview> {
    return refreshBrief(this.client, projectId);
  }

  /** Team channels: list, read, post and act on requests. */
  get channels() {
    return channelService(this.client);
  }

  listTasks(): TaskSummary[] {
    return toTaskSummaries(this.client.snapshot);
  }

  /** The person's review: clicking Accept or Send back is their confirmation. */
  async reviewTask(input: ReviewTaskInput): Promise<void> {
    await this.client.call(
      "task.review",
      {
        id: input.taskId,
        revision: input.revision,
        decision: input.decision,
        ...(input.feedback ? { feedback: input.feedback } : {}),
        confirmed: true,
      },
      `shell:review:${input.taskId}:${input.revision}:${input.decision}`,
    );
  }

  async deleteBot(botId: string): Promise<void> {
    await this.client.call("thread.archive", { id: botId, confirmed: true }, randomUUID());
    this.conversations.delete(botId);
  }

  async readConversation(botId: string): Promise<ConversationSnapshot> {
    const conversation = this.conversation(botId);
    // Callers that arrive while history loads wait for the same load.
    if (!conversation.loaded && this.client.status === "online")
      conversation.loading ??= this.client
        .call("thread.history", { threadId: botId, limit: 200 })
        .then((history) => {
          for (const item of (history as { items: Row[] }).items)
            conversation.history.set(text(item.id), item);
          conversation.loaded = true;
        })
        .catch(() => undefined)
        .finally(() => {
          conversation.loading = undefined;
        });
    await conversation.loading;
    return this.conversationSnapshot(botId);
  }

  listQueue(botId: string): QueueSnapshot {
    return toQueue(botId, this.items(botId));
  }

  async cancelQueuedMessage(botId: string, deliveryId: string): Promise<void> {
    await this.client.call("turn.cancelQueued", { threadId: botId, id: deliveryId }, randomUUID());
  }

  async setQueuePaused(_botId: string, _paused: boolean): Promise<void> {
    throw new Error("Zoltbot sends queued messages in order and can't pause them.");
  }

  async sendMessage(input: SendMessageInput): Promise<QueuedMessageReceipt> {
    const words = input.text.trim();
    const attachments = (input.attachmentDraftIds ?? [])
      .map((id) => this.drafts.get(id))
      .filter((draft): draft is { path: string; summary: DraftAttachment } => Boolean(draft));
    const parts = callParts(
      input.call,
      messageParts(this.items(input.botId), input.replyToMessageId, words, attachments),
    );
    if (!parts.length) throw new Error("Write a message first.");
    const conversation = this.conversation(input.botId);
    const pendingId = `pending:${randomUUID()}`;
    const commandId = randomUUID();
    const running = Boolean(runningTurn(this.client.snapshot, input.botId));
    conversation.pending.push({
      id: pendingId,
      author: "user",
      source: "user",
      text: words,
      createdAt: new Date().toISOString(),
      status: "completed",
      attachments: attachments.map((attachment) => attachment.summary),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      delivery: { id: pendingId, status: running ? "queued" : "starting", position: null },
    });
    this.emitConversation(input.botId);
    try {
      // C12: behind waiting messages, or before the daemon is fully connected, a message waits.
      if (this.client.status !== "online" || this.outbox.has(input.botId))
        throw new Error("Daemon unavailable");
      const result = (await this.client.call(
        "turn.send",
        { threadId: input.botId, input: parts, mode: sendMode(input), outputMode: "auto" },
        commandId,
      )) as { id: string; disposition: string };
      for (const id of input.attachmentDraftIds ?? []) this.drafts.delete(id);
      return {
        messageId: result.id,
        deliveries: [
          {
            id: result.id,
            recipientBotId: input.botId,
            status: result.disposition === "queued" ? "queued" : "starting",
            position: null,
          },
        ],
      };
    } catch (error) {
      if (!unreachable(error)) throw error;
      // C12: the daemon is unreachable; the message waits and sends with this commandId later.
      // Its drafts stay, so the waiting message keeps its previews.
      conversation.pending = conversation.pending.filter((message) => message.id !== pendingId);
      const receipt = await this.outbox.keep(commandId, input, parts, words, attachments);
      if (this.client.status === "online") void this.outbox.flush();
      return receipt;
    } finally {
      conversation.pending = conversation.pending.filter((message) => message.id !== pendingId);
      this.dirty.add(input.botId);
      this.scheduleFlush();
    }
  }

  async setMessageReaction(input: SetMessageReactionInput): Promise<void> {
    await setReaction(this.client, input);
    // C8: the daemon keeps reactions now; drop any copy saved only on this Mac.
    const key = `${input.botId}:${input.messageId}`;
    if (key in this.preferences.reactions) {
      delete this.preferences.reactions[key];
      await this.save();
    }
    this.emitConversation(input.botId);
  }

  async interrupt(botId: string, turnId: string): Promise<void> {
    await this.client.call("turn.interrupt", { threadId: botId, turnId }, randomUUID());
  }

  async interruptAll(): Promise<void> {
    await Promise.all(
      this.client
        .rows("turn")
        .filter((turn) => turn.status === "running")
        .map((turn) => this.interrupt(text(turn.threadId), text(turn.id)).catch(() => undefined)),
    );
  }

  async respondToPrompt(input: RespondToPromptInput): Promise<void> {
    const interaction = this.client.rows("interaction").find((row) => row.id === input.requestId);
    if (!interaction || interaction.state !== "pending")
      throw new Error("This request was already answered.");
    await this.client.call(
      "interaction.answer",
      {
        id: interaction.id,
        version: interaction.version,
        answer: toResolution(interaction, input.answers, new Date().toISOString()),
      },
      randomUUID(),
    );
  }

  readStaff = (projectId: string | null) => toStaffOverview(this.client.snapshot, projectId);
  staffAction = (input: StaffActionInput) =>
    runStaffAction(
      (m, p, id) => this.client.call(m, p, id),
      this.client.rows("interaction"),
      input,
    );

  taskAction(input: TaskActionInput): Promise<void> {
    return runTaskAction((method, params, id) => this.client.call(method, params, id), input);
  }

  /** Keeps a picked file as a draft; the agent reads it from its path when the message is sent. */
  addDraft(path: string, size: number): DraftAttachment {
    return this.drafts.add(path, size);
  }

  /** Picked files at once, so one over 100 MB attaches none of them (C18). */
  addDrafts(files: { path: string; size: number }[]): DraftAttachment[] {
    return this.drafts.addAll(files);
  }

  addDraftBytes(name: string, bytes: Uint8Array): Promise<DraftAttachment> {
    return this.drafts.addBytes(this.file("attachments"), name, bytes);
  }

  /** A draft's file, or a file or picture the owner sent (C16). */
  attachmentSource(id: string): AttachmentSource | undefined {
    const path = this.drafts.path(id);
    if (path) return { path, mimeType: fileMimeType(path) };
    const history = [...this.conversations.values()].flatMap((c) => [...c.history.values()]);
    return sentAttachmentSource([...this.client.rows("item"), ...history], id);
  }

  discardDraftAttachment(id: string): Promise<void> {
    this.drafts.delete(id);
    return Promise.resolve();
  }

  private thread(id: string): Row {
    const thread = this.client.rows("thread").find((row) => row.id === id);
    if (!thread) throw new Error("This chat no longer exists.");
    return thread;
  }

  private conversation(botId: string): Conversation {
    let conversation = this.conversations.get(botId);
    if (!conversation) {
      conversation = {
        revision: 0,
        history: new Map(),
        texts: new Map(),
        pending: [],
        loaded: false,
      };
      this.conversations.set(botId, conversation);
    }
    return conversation;
  }

  private items(botId: string): Row[] {
    const live = threadItems(this.client.snapshot, botId);
    const history = this.conversations.get(botId)?.history;
    if (!history?.size) return live;
    const merged = new Map(history);
    for (const item of live) merged.set(text(item.id), item);
    return [...merged.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
  }

  private conversationSnapshot(botId: string): ConversationSnapshot {
    const conversation = this.conversation(botId);
    conversation.revision++;
    const items = this.items(botId);
    const snapshot = this.client.snapshot;
    const messages = withHidden(
      snapshot,
      botId,
      withCalls(
        snapshot,
        botId,
        withProgress(
          snapshot,
          botId,
          withAsides(snapshot, botId, toMessages(snapshot, botId, items)),
        ),
      ),
    );
    withReactions(snapshot, botId, messages, this.preferences.reactions);
    for (const message of messages) conversation.texts.set(message.id, message.text);
    return {
      botId,
      threadId: botId,
      activeTurnId: text(runningTurn(this.client.snapshot, botId)?.id) || null,
      revision: conversation.revision,
      messages: [
        ...messages,
        ...conversation.pending,
        ...this.outbox.list(botId).map(waitingMessage),
      ],
      plan: latestPlan(items),
      pins: pinnedMessages(this.client.snapshot, botId, messages),
      workingStatus: workingStatus(this.client.snapshot, botId, items),
    };
  }

  private emitConversation(botId: string): void {
    this.emit("event", { type: "conversation", snapshot: this.conversationSnapshot(botId) });
  }

  private changed(change: SnapshotChange): void {
    if (change.kind === "status" || change.kind === "reset") {
      if (change.kind === "reset" || this.client.status !== "online") this.agentChecks = undefined;
      this.emit("event", { type: "status", status: this.getStatus() });
      if (this.client.status === "online" && this.agentChecks === undefined)
        void this.refreshAgents(false);
      if (this.client.status === "online") void this.outbox.flush();
      this.markBots();
      this.companyDirty.add(null);
      this.pagesDirty.add("memory-changed").add("spend-changed");
      for (const thread of visibleThreads(this.client.snapshot)) this.dirty.add(text(thread.id));
      this.scheduleFlush();
      return;
    }
    if (change.streamed && change.aggregateType === "item") {
      for (const item of change.rows) this.streamed(item);
      return;
    }
    if (change.aggregateType === "agentDefinition") void this.refreshAgents(true);
    // M6: skill proposals wait in the Memory page's Needs review too.
    if (change.aggregateType.startsWith("knowledge") || change.aggregateType === "skillProposal")
      this.pagesDirty.add("memory-changed");
    if (changesSpend(change.aggregateType, change.rows)) this.pagesDirty.add("spend-changed");
    for (const row of change.rows) {
      const threadId =
        change.aggregateType === "thread"
          ? text(row.id)
          : change.aggregateType === "artifactVersion"
            ? text(
                (this.client.snapshot.entities.artifact ?? []).find(
                  (artifact) => artifact.id === row.artifactId,
                )?.threadId,
              )
            : text(row.threadId);
      if (
        ["thread", "agent", "session", "project", "subproject", "task", "agentDefinition"].includes(
          change.aggregateType,
        ) ||
        (change.aggregateType === "settings" && text(row.key).startsWith(MUTED_PREFIX))
      )
        this.markBots();
      if (COMPANY_ROWS.has(change.aggregateType)) this.markCompany(change.aggregateType, row);
      const staff = staffProject(change.aggregateType, row);
      if (staff !== undefined) this.companyDirty.add(staff || null);
      if (threadId) this.dirty.add(threadId);
      for (const id of [
        ...asideThreads(this.client.snapshot, change.aggregateType, row, threadId),
        ...relatedThreads(this.client.snapshot, change.aggregateType, row),
      ])
        this.dirty.add(id);
    }
    this.scheduleFlush();
  }

  /** A streamed reply grows by its new text only; anything else resends the conversation. */
  private streamed(item: Row): void {
    const botId = text(item.threadId);
    const conversation = this.conversations.get(botId);
    if (!conversation) {
      // An aside's answer streams into the chat it was asked in.
      const asked = asideSource(this.client.snapshot, botId);
      if (asked && this.conversations.has(asked)) {
        this.dirty.add(asked);
        this.scheduleFlush();
      }
      return;
    }
    const id = text(item.id);
    const next = text(body(item).text);
    const previous = conversation.texts.get(id);
    if (item.kind !== "message" || previous === undefined || !next.startsWith(previous)) {
      this.dirty.add(botId);
      this.scheduleFlush();
      return;
    }
    if (next === previous) return;
    conversation.texts.set(id, next);
    conversation.revision++;
    this.emit("event", {
      type: "conversation-delta",
      botId,
      threadId: botId,
      turnId: text(item.turnId),
      messageId: id,
      delta: next.slice(previous.length),
      createdAt: text(item.createdAt),
      revision: conversation.revision,
    });
  }

  private markBots(): void {
    this.botsDirty = true;
    this.scheduleFlush();
  }

  private markCompany(kind: string, row: Row): void {
    const projectId =
      kind === "project"
        ? text(row.id)
        : text(row.projectId) ||
          text(this.client.rows("thread").find((thread) => thread.id === row.threadId)?.projectId);
    this.companyDirty.add(projectId || null);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.botsDirty) {
      this.botsDirty = false;
      const bots = this.listBots();
      const serialized = JSON.stringify(bots);
      if (serialized !== this.lastBots) {
        this.lastBots = serialized;
        this.emit("event", { type: "bots-changed", bots });
      }
    }
    for (const type of this.pagesDirty) this.emit("event", { type });
    this.pagesDirty.clear();
    const company = this.companyDirty;
    this.companyDirty = new Set();
    if (company.has(null)) this.emit("event", { type: "company-changed", projectId: null });
    else
      for (const projectId of company) this.emit("event", { type: "company-changed", projectId });
    const dirty = this.dirty;
    this.dirty = new Set();
    for (const botId of dirty) {
      this.turnEvents(botId);
      this.promptEvents(botId);
      if (this.conversations.has(botId)) {
        this.emitConversation(botId);
        this.emit("event", { type: "queue-changed", snapshot: this.listQueue(botId) });
      }
    }
  }

  private turnEvents(botId: string): void {
    const running = text(runningTurn(this.client.snapshot, botId)?.id) || null;
    const previous = this.turns.get(botId) ?? null;
    if (running === previous) return;
    this.turns.set(botId, running);
    if (previous) {
      const ended = this.client.rows("turn").find((turn) => turn.id === previous);
      this.emit("event", {
        type: "turn-completed",
        botId,
        threadId: botId,
        turnId: previous,
        status: text(ended?.status) || "completed",
      });
    }
    if (running)
      this.emit("event", { type: "turn-started", botId, threadId: botId, turnId: running });
  }

  private promptEvents(botId: string): void {
    const pending = this.client
      .rows("interaction")
      .filter((row) => row.threadId === botId && row.state === "pending" && !isStaffApproval(row))
      .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)))[0];
    const shown = this.prompts.get(botId);
    if (text(pending?.id) === shown) return;
    if (!pending) {
      this.prompts.delete(botId);
      this.emit("event", { type: "prompt-cleared", botId });
      return;
    }
    this.prompts.set(botId, text(pending.id));
    const { questions } = toPrompt(pending);
    const switchDialog = switchDialogFor(pending);
    this.emit("event", {
      type: "prompt",
      requestId: text(pending.id),
      botId,
      threadId: botId,
      turnId: text(pending.turnId),
      questions,
      ...(switchDialog ? { switchDialog } : {}),
    });
  }

  private file(name: string): string {
    return join(this.dataPath, name);
  }

  private async save(): Promise<void> {
    const path = this.file("preferences.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.preferences), { mode: 0o600 });
    await rename(temporary, path);
  }
}

export type { AttachmentSummary };
