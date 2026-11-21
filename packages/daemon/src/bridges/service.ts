// I1: runs the saved bridges. A message from an allowed person becomes a queued input in the
// routed chat (or an owner post in the routed channel); the agent's answer goes back the same way.
// Bridged messages never answer an approval: they only ever queue input, so Interactions raised
// in a bridged turn still wait in the owner's Needs you.
import { createHash } from "node:crypto";
import {
  allowed,
  type BridgeAdapter,
  BridgeError,
  bridgedText,
  bridgeSupervisor,
  defaultBridgeAdapters,
  type InboundMessage,
  type OutboundMessage,
  routeFor,
  type SupervisorStatus,
} from "@zoltbot/bridges";
import {
  type Bridge,
  type BridgeKind,
  type BridgeRefusal,
  type BridgeStatus,
  type DomainEvent,
  MAX_BRIDGE_REFUSALS,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateVault } from "../private-context.js";
import { bridgeApi } from "./api.js";
import { pairingHook, preparePairing } from "./pairing.js";
import {
  bridgeRows,
  MAX_PENDING,
  PENDING_TTL_MS,
  type PendingReply,
  rowKeys,
  writeRows,
} from "./records.js";

/** The sender names a file's type; the first bytes say what it really is. */
const IMAGE_SIGNATURES: [string, number[], number?][] = [
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/webp", [0x57, 0x45, 0x42, 0x50], 8],
];
const imageType = (data: Uint8Array) =>
  IMAGE_SIGNATURES.find(([, bytes, at = 0]) =>
    bytes.every((byte, index) => data[at + index] === byte),
  )?.[0];
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

export type BridgeAdapterFactory = (input: {
  bridge: Bridge;
  credentials: Record<string, string>;
}) => BridgeAdapter;

export interface BridgeHostOptions {
  adapters?: Partial<Record<BridgeKind, BridgeAdapterFactory>>;
  initialMs?: number;
  maxMs?: number;
}

type Call = (
  method: string,
  params: Record<string, unknown>,
  commandId: string,
) => Promise<unknown>;
type Row = Record<string, unknown>;

/** A refused person shows once per place in this window, not once per message. */
const REFUSAL_QUIET_MS = 10 * 60 * 1000;

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function startBridges(
  options: BridgeHostOptions & {
    store: Store;
    publish(events: DomainEvent[]): void;
    secrets?: PrivateVault;
    remember(value: string): void;
    /** `turn.send` and `channel.post`, as the owner's own calls. */
    send: Call;
    onError?: (code: string) => void;
  },
) {
  const { store } = options;
  const adapters = { ...defaultBridgeAdapters, ...options.adapters };
  const write = (entries: { key: string; value: unknown }[]) =>
    writeRows(store, options.publish, entries);

  const setStatus = (id: string, next: SupervisorStatus) => {
    const current = bridgeRows(store).status.get(id);
    const value: BridgeStatus = {
      state: next.state,
      ...("problem" in next && next.problem ? { problem: next.problem } : {}),
      ...(next.state === "connected" && next.account
        ? { account: next.account.slice(0, 200) }
        : next.state !== "connected" && current?.account
          ? { account: current.account }
          : {}),
      at: new Date().toISOString(),
    };
    if (
      current &&
      current.state === value.state &&
      current.problem === value.problem &&
      current.account === value.account
    )
      return;
    write([{ key: rowKeys.status(id), value }]);
  };

  const create = async (id: string): Promise<BridgeAdapter> => {
    const bridge = bridgeRows(store).bridges.get(id);
    if (!bridge) throw new BridgeError("not_set_up");
    const factory = adapters[bridge.kind];
    if (!factory || !bridge.credentialRef) throw new BridgeError("not_set_up");
    if (!options.secrets) throw new BridgeError("keychain_unavailable");
    let credentials: Record<string, string>;
    try {
      credentials = (await options.secrets.read(bridge.credentialRef)) as Record<string, string>;
    } catch {
      throw new BridgeError("keychain_unavailable");
    }
    for (const value of Object.values(credentials))
      if (typeof value === "string") options.remember(value);
    return factory({ bridge, credentials });
  };

  // Replies collected per bridged turn, newest message last.
  const replies = new Map<string, Map<string, { seq: number; text: string; final: boolean }>>();
  const handled = new Set<string>();
  // Turns answering a bridged message; rebuilt from the saved rows after a restart.
  const tracked = new Set(
    [...bridgeRows(store).pending.values()].flatMap((rows) =>
      rows.flatMap((row) => (row.turnId ? [row.turnId] : [])),
    ),
  );

  const savePending = (id: string, update: (rows: PendingReply[]) => PendingReply[]) => {
    const now = Date.now();
    const current = bridgeRows(store).pending.get(id) ?? [];
    const next = update(current)
      .filter((entry, index, all) => all.findIndex((row) => row.id === entry.id) === index)
      .filter((entry) => now - Date.parse(entry.at) < PENDING_TTL_MS)
      .slice(-MAX_PENDING);
    if (JSON.stringify(next) !== JSON.stringify(current))
      write([{ key: rowKeys.pending(id), value: next }]);
  };

  const refuse = (bridge: Bridge, message: InboundMessage, routeId: string | undefined) => {
    const now = new Date();
    const refused = bridgeRows(store).refused.get(bridge.id) ?? [];
    const recent = refused.find(
      (entry) =>
        entry.person.id === message.sender.id &&
        entry.place.id === message.place.id &&
        now.getTime() - Date.parse(entry.at) < REFUSAL_QUIET_MS,
    );
    if (recent) return;
    const entry: BridgeRefusal = {
      id: `refused-${hash(`${bridge.id}:${message.id}`)}`,
      ...(routeId ? { routeId } : {}),
      place: { id: message.place.id.slice(0, 200), label: message.place.label.slice(0, 200) },
      person: { id: message.sender.id.slice(0, 200), name: message.sender.name.slice(0, 200) },
      at: now.toISOString(),
    };
    const next = [
      entry,
      ...refused.filter(
        (row) => !(row.person.id === entry.person.id && row.place.id === entry.place.id),
      ),
    ];
    write([{ key: rowKeys.refused(bridge.id), value: next.slice(0, MAX_BRIDGE_REFUSALS) }]);
  };

  /** Extra handling one app needs before routing, such as Telegram's pairing. True when used. */
  const hooks: ((bridge: Bridge, message: InboundMessage) => Promise<boolean> | boolean)[] = [];

  const inbound = async (id: string, message: InboundMessage) => {
    const key = `${id}:${message.id}`;
    if (handled.has(key)) return;
    handled.add(key);
    if (handled.size > 2000) handled.delete(handled.values().next().value as string);
    const bridge = bridgeRows(store).bridges.get(id);
    if (!bridge?.enabled) return;
    for (const hook of hooks) if (await hook(bridge, message)) return;
    const route = routeFor(bridge, message);
    if (!route) return;
    if (!allowed(route, message.sender.id)) return refuse(bridge, message, route.id);
    // Photos go to a chat as images; other files are named, not passed on.
    const files = message.attachments ?? [];
    const images =
      route.to.kind === "chat"
        ? files
            .filter((file) => file.data.byteLength <= MAX_IMAGE && imageType(file.data))
            .slice(0, MAX_IMAGES)
        : [];
    const skipped = files.length - images.length;
    if (!message.text.trim() && !files.length) return;
    const body = `${bridgedText(bridge.kind, message)}${
      skipped ? `\n(${skipped === 1 ? "A file" : `${skipped} files`} not passed on.)` : ""
    }`;
    const commandId = `bridge:${id}:${hash(message.id)}`;
    const entry: PendingReply = {
      id: message.id,
      routeId: route.id,
      reply: message.reply,
      at: new Date().toISOString(),
    };
    if (route.to.kind === "chat") {
      const sent = (await options.send(
        "turn.send",
        {
          threadId: route.to.threadId,
          input: [
            { type: "text", text: body },
            ...images.map((file) => ({
              type: "image",
              mimeType: imageType(file.data),
              base64: Buffer.from(file.data).toString("base64"),
            })),
          ],
          mode: "queue",
        },
        commandId,
      )) as { id?: string };
      if (sent?.id) savePending(id, (rows) => [...rows, { ...entry, itemId: sent.id as string }]);
      return;
    }
    const posted = (await options.send(
      "channel.post",
      { channelId: route.to.channelId, id: `bridge-${hash(key)}`, text: body.slice(0, 4000) },
      commandId,
    )) as { request?: { id?: string } };
    const requestId = posted?.request?.id;
    if (requestId) savePending(id, (rows) => [...rows, { ...entry, requestId }]);
  };

  const supervisor = bridgeSupervisor({
    create,
    onStatus: setStatus,
    onMessage: (id, message) =>
      void inbound(id, message).catch(() => options.onError?.("bridge_inbound_failed")),
    ...(options.initialMs !== undefined ? { initialMs: options.initialMs } : {}),
    ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
  });

  const sync = () => {
    const bridges = [...bridgeRows(store).bridges.values()];
    void supervisor.sync(() =>
      [...bridgeRows(store).bridges.values()].map((bridge) => ({
        id: bridge.id,
        enabled: bridge.enabled,
        fingerprint: `${bridge.kind}:${bridge.credentialRef ?? ""}`,
      })),
    );
    for (const bridge of bridges) if (!bridge.enabled) setStatus(bridge.id, { state: "stopped" });
  };

  const post = async (bridgeId: string, entry: PendingReply, message: OutboundMessage) => {
    const adapter = supervisor.adapter(bridgeId);
    if (!adapter || !message.text.trim()) return;
    await adapter.send(entry.reply, message).catch(() => options.onError?.("bridge_send_failed"));
  };

  const agentName = (threadId: string) => {
    const thread = store.record("thread", threadId);
    const agent = thread ? store.record("agent", String(thread.agentId)) : undefined;
    return text(agent?.name) || undefined;
  };

  const observe = (events: DomainEvent[]) => {
    const relevant = events.filter((event) =>
      ["item", "turn", "channelPost"].includes(event.aggregateType),
    );
    if (!relevant.length) return;
    const pending = bridgeRows(store).pending;
    if (!pending.size) return;
    for (const event of relevant) {
      const payload = event.payload as Row;
      if (event.aggregateType === "item" && payload.kind === "user" && payload.turnId) {
        for (const rows of pending.values())
          if (rows.some((row) => row.itemId === payload.id)) tracked.add(String(payload.turnId));
        for (const [bridgeId, rows] of pending)
          if (rows.some((row) => row.itemId === payload.id && row.turnId !== payload.turnId))
            savePending(bridgeId, (current) =>
              current.map((row) =>
                row.itemId === payload.id ? { ...row, turnId: String(payload.turnId) } : row,
              ),
            );
      }
      if (event.aggregateType === "item" && payload.kind === "message" && payload.turnId) {
        const turnId = String(payload.turnId);
        if (!tracked.has(turnId)) continue;
        const map = replies.get(turnId) ?? new Map();
        map.set(String(payload.id), {
          seq: Number(payload.seq),
          text: text((payload.body as Row | undefined)?.text),
          final: payload.phase === "final",
        });
        replies.set(turnId, map);
      }
      if (
        event.aggregateType === "turn" &&
        ["completed", "failed", "interrupted"].includes(text(payload.status))
      ) {
        const turnId = String(payload.id);
        if (!tracked.delete(turnId)) continue;
        const collected = [...(replies.get(turnId)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
        replies.delete(turnId);
        // The answer is the turn's final message, not what the agent said on the way.
        // A turn that stopped early sends nothing rather than its narration.
        const final = collected.filter((row) => row.final).at(-1);
        const answer = (final ?? (payload.status === "completed" ? collected.at(-1) : undefined))
          ?.text;
        for (const [bridgeId, rows] of bridgeRows(store).pending) {
          const done = rows.filter((row) => row.turnId === turnId);
          if (!done.length) continue;
          savePending(bridgeId, (current) => current.filter((row) => row.turnId !== turnId));
          const name = agentName(text(payload.threadId));
          for (const row of done)
            if (answer)
              void post(bridgeId, row, { text: answer, ...(name ? { as: { name } } : {}) });
        }
      }
      if (event.aggregateType === "channelPost" && event.type === "channelPost.created") {
        const author = payload.author as Row | undefined;
        if (author?.kind !== "thread" || !payload.requestId) continue;
        for (const [bridgeId, rows] of pending)
          for (const row of rows)
            if (row.requestId === payload.requestId) {
              const name = agentName(text(author.threadId));
              void post(bridgeId, row, {
                text: text(payload.text),
                ...(name ? { as: { name } } : {}),
              });
            }
      }
    }
  };

  hooks.push(
    pairingHook({
      store,
      publish: options.publish,
      adapter: (id) => supervisor.adapter(id),
      ...(options.onError ? { onError: options.onError } : {}),
    }),
  );

  const api = bridgeApi({
    store,
    publish: options.publish,
    prepare: preparePairing,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    remember: options.remember,
    changed: sync,
  });

  sync();
  return {
    api,
    observe,
    /** For an app that handles some messages itself before routing. */
    hook(handler: (bridge: Bridge, message: InboundMessage) => Promise<boolean> | boolean) {
      hooks.push(handler);
    },
    adapter: (id: string) => supervisor.adapter(id),
    close: () => supervisor.close(),
  };
}
