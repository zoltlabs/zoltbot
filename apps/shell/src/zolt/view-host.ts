import { randomUUID } from "node:crypto";
import { parse, type ViewRecord, ViewRecordSchema } from "@zoltbot/protocol";
import { mapTopics, type Request, type TopicValues } from "../../../../packages/view-api/src/index";
import type {
  ViewConnectInput,
  ViewHostEvent,
  ViewSummary,
  ViewTheme,
  ViewUpdateInput,
} from "../shared/ipc";
import type { Row, SnapshotChange } from "./daemon-client";
import { viewActions } from "./view-actions";
import { ViewBridge } from "./view-bridge";

export const COMMAND_MAP_ID = "command-map";
const MAX_SESSIONS = 4;

export interface ViewHostClient {
  readonly snapshot: { entities: Record<string, Row[]> };
  call(method: string, params: unknown, commandId?: string): Promise<unknown>;
  onChange(listener: (change: SnapshotChange) => void): () => void;
}

export interface ViewHostOptions {
  client: ViewHostClient;
  /** Checks the bundle and returns the `zoltbot-view:` URL the frame loads. */
  prepare(bundleHash: string): Promise<{ url: string }>;
  send(event: ViewHostEvent): void;
  /** Asks the person before a view gives an answer that allows more than one action. */
  confirm(request: Request, choice: Request["choices"][number]): Promise<boolean>;
  now?(): number;
  /** How often sessions tick. 0 leaves ticking to the caller, as tests do. */
  tickMs?: number;
}

interface Session {
  id: string;
  viewId: string;
  bundleHash: string;
  granted: string;
  theme: ViewTheme;
  locale: string;
  reducedMotion: boolean;
  bridge: ViewBridge;
  /** Set when the bridge gave up on the view; read after the session is gone. */
  outcome: { failed: boolean };
}

function viewRecords(rows: Row[] | undefined): ViewRecord[] {
  return (rows ?? []).flatMap((row) => {
    try {
      const record = parse(ViewRecordSchema, row);
      return record.removed ? [] : [record];
    } catch {
      return [];
    }
  });
}

/**
 * Hosts daemon-installed views for the shell. The daemon snapshot lives in main, so main builds
 * the topic data, runs each view's bridge and decides its calls. The renderer only owns the frame
 * and relays messages between the frame's MessageChannel and this host.
 */
export class ViewHost {
  private readonly sessions = new Map<string, Session>();
  private data: TopicValues | undefined;
  private dirty = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private lastViews = "";

  constructor(private readonly options: ViewHostOptions) {}

  start(): void {
    this.unsubscribe ??= this.options.client.onChange((change) => this.changed(change));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const session of [...this.sessions.values()]) session.bridge.close();
    this.stopTimer();
  }

  /** The command map, or the person's own copy of it when that copy replaces the built-in one. */
  mapView(): ViewSummary | null {
    const records = viewRecords(this.options.client.snapshot.entities.view).filter(
      (record) => record.id === COMMAND_MAP_ID || record.basedOn?.id === COMMAND_MAP_ID,
    );
    const record =
      records.find((row) => row.overridesBuiltin && row.enabled) ??
      records.find((row) => row.id === COMMAND_MAP_ID) ??
      records[0];
    if (!record) return null;
    return {
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      canRead: record.granted.includes("read"),
      error: record.error?.message ?? null,
    };
  }

  /** Grants the read permission only. Acting and answering stay as the person set them. */
  async allowRead(viewId: string): Promise<void> {
    const record = this.require(viewId);
    if (record.granted.includes("read")) return;
    if (!record.requested.includes("read")) throw new Error("This view doesn't read chats.");
    await this.options.client.call(
      "view.setGrants",
      { id: record.id, permissions: [...new Set([...record.granted, "read"])], confirmed: true },
      randomUUID(),
    );
  }

  async turnOn(viewId: string): Promise<void> {
    const record = this.require(viewId);
    if (record.enabled) return;
    await this.options.client.call(
      "view.setEnabled",
      { id: record.id, enabled: true },
      randomUUID(),
    );
  }

  async prepare(viewId: string): Promise<{ url: string }> {
    return this.options.prepare(this.usable(viewId).bundleHash);
  }

  connect(input: ViewConnectInput): { sessionId: string } {
    const record = this.usable(input.viewId);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.values().next().value?.bridge.close();
    const id = randomUUID();
    const outcome = { failed: false };
    const current = () => this.record(input.viewId) ?? { ...record, enabled: false, granted: [] };
    const bridge = new ViewBridge({
      port: {
        postMessage: (message) => this.options.send({ type: "message", sessionId: id, message }),
        close: () => this.closed(id),
      },
      ...(this.options.now ? { now: this.options.now } : {}),
      ready: () => {
        const view = current();
        const session = this.sessions.get(id);
        return {
          t: "ready",
          api: 1,
          view: { id: view.id, name: view.name, version: view.version },
          granted: view.enabled ? view.granted : [],
          theme: session?.theme ?? input.theme,
          locale: session?.locale ?? input.locale,
          reducedMotion: session?.reducedMotion ?? input.reducedMotion,
          mock: false,
        };
      },
      failed: () => {
        outcome.failed = true;
      },
      key: (combo) => this.options.send({ type: "key", combo }),
      call: viewActions({
        record: current,
        snapshot: () => this.options.client.snapshot,
        call: (method, params, commandId) => this.options.client.call(method, params, commandId),
        confirm: this.options.confirm,
        open: (target) =>
          this.options.send({
            type: "open",
            chatId: typeof target.chatId === "string" ? target.chatId : null,
          }),
      }),
    });
    this.sessions.set(id, {
      id,
      viewId: input.viewId,
      bundleHash: record.bundleHash,
      granted: record.granted.join(),
      theme: input.theme,
      locale: input.locale,
      reducedMotion: input.reducedMotion,
      bridge,
      outcome,
    });
    const data = this.topics();
    if (data) bridge.update(data);
    this.startTimer();
    return { sessionId: id };
  }

  /** A message the view posted. The bridge checks its size, shape and rate. */
  receive(sessionId: string, message: unknown): void {
    this.sessions.get(sessionId)?.bridge.receive(message);
  }

  update(input: ViewUpdateInput): void {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    if (input.theme) {
      session.theme = input.theme;
      session.bridge.event("theme", input.theme);
    }
    if (input.visible !== undefined) session.bridge.visibility(input.visible);
  }

  close(sessionId: string): void {
    this.sessions.get(sessionId)?.bridge.close();
  }

  /** Sends changed topic data and keeps each connection alive. Runs every 100 ms by default. */
  tick(): void {
    if (this.dirty) {
      const data = this.topics();
      if (data) for (const session of this.sessions.values()) session.bridge.update(data);
      return;
    }
    for (const session of this.sessions.values()) session.bridge.tick();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private topics(): TopicValues | undefined {
    if (this.dirty || !this.data) {
      try {
        this.data = mapTopics(this.options.client.snapshot);
        this.dirty = false;
      } catch (error) {
        console.warn("Couldn't build view data:", error);
      }
    }
    return this.data;
  }

  private changed(change: SnapshotChange): void {
    if (change.kind === "status") return;
    this.dirty = true;
    if (change.kind === "reset" || change.aggregateType === "view") this.viewsChanged();
  }

  private viewsChanged(): void {
    for (const session of [...this.sessions.values()]) {
      const record = this.record(session.viewId);
      if (
        !record?.enabled ||
        !record.granted.includes("read") ||
        record.bundleHash !== session.bundleHash
      ) {
        session.bridge.close();
        continue;
      }
      if (record.granted.join() === session.granted) continue;
      session.granted = record.granted.join();
      session.bridge.event("grants", record.granted);
    }
    const views = JSON.stringify(this.options.client.snapshot.entities.view ?? []);
    if (views === this.lastViews) return;
    this.lastViews = views;
    this.options.send({ type: "views-changed" });
  }

  private closed(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (!this.sessions.size) this.stopTimer();
    // The bridge reports a failure right after it closes, so wait for that before telling the
    // renderer why the view stopped.
    queueMicrotask(() =>
      this.options.send({ type: "closed", sessionId: id, failed: session.outcome.failed }),
    );
  }

  private record(viewId: string): ViewRecord | undefined {
    return viewRecords(this.options.client.snapshot.entities.view).find((row) => row.id === viewId);
  }

  private require(viewId: string): ViewRecord {
    const record = this.record(viewId);
    if (!record) throw new Error("This view isn't installed.");
    return record;
  }

  private usable(viewId: string): ViewRecord {
    const record = this.require(viewId);
    if (!record.enabled) throw new Error("This view is turned off.");
    if (!record.granted.includes("read")) throw new Error("This view can't read your chats.");
    if (!record.bundleHash) throw new Error("This view has no files.");
    return record;
  }

  private startTimer(): void {
    const interval = this.options.tickMs ?? 100;
    if (this.timer || interval <= 0) return;
    this.timer = setInterval(() => this.tick(), interval);
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
