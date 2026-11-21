// I1: bridge.list, bridge.save and bridge.remove. Tokens go to the keychain and never come back;
// the row keeps the opaque reference (I7).
import { Value } from "@sinclair/typebox/value";
import {
  type Bridge,
  type BridgeInput,
  BridgeInputSchema,
  type BridgeRoute,
  type DomainEvent,
  parse,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateVault } from "../private-context.js";
import { bridgeRows, bridgeView, bridgeViews, rowKeys, writeRows } from "./records.js";

/** Options the daemon keeps for itself, such as a Telegram pairing code. */
const DAEMON_OPTIONS = new Set(["pairing"]);
const MAX_OPTIONS_BYTES = 4096;

export interface BridgeApiHost {
  store: Store;
  publish(events: DomainEvent[]): void;
  secrets?: PrivateVault;
  /** Never logs or stores a token in the clear: each one is registered before it's saved. */
  remember(value: string): void;
  /** Starts or stops bridges to match what was saved. */
  changed(): void;
  /** Fills in options the daemon owns for a new or changed bridge, such as a pairing code. */
  prepare?(bridge: Bridge, previous: Bridge | undefined): Bridge;
  onRemoved?(id: string): void;
}

function checkRoutes(store: Store, routes: BridgeRoute[]) {
  const state = store.snapshot(["thread", "channel"]);
  const ids = new Set<string>();
  const places = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) throw new Error("invalid_bridge: route ids repeat");
    if (places.has(route.from.id)) throw new Error("invalid_bridge: two routes start in one place");
    ids.add(route.id);
    places.add(route.from.id);
    if (
      route.to.kind === "chat" &&
      !state.thread?.some((row) => row.id === (route.to as { threadId: string }).threadId)
    )
      throw new Error("not_found: chat");
    if (
      route.to.kind === "channel" &&
      !state.channel?.some(
        (row) => row.id === (route.to as { channelId: string }).channelId && !row.archivedAt,
      )
    )
      throw new Error("not_found: channel");
    const people = new Set(route.allow.map((person) => person.id));
    if (people.size !== route.allow.length) throw new Error("invalid_bridge: a person repeats");
  }
}

function ownOptions(input: BridgeInput, previous: Bridge | undefined) {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.options ?? {}))
    if (!DAEMON_OPTIONS.has(key)) options[key] = value;
  for (const key of DAEMON_OPTIONS)
    if (previous?.options?.[key] !== undefined) options[key] = previous.options[key];
  if (Buffer.byteLength(JSON.stringify(options)) > MAX_OPTIONS_BYTES)
    throw new Error("invalid_bridge: options are too long");
  return options;
}

export function bridgeApi(host: BridgeApiHost) {
  const { store } = host;
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (method === "bridge.list") return { items: bridgeViews(store) };
    if (method === "bridge.remove") {
      if (params.confirmed !== true) throw new Error("confirmation_required");
      const id = String(params.id);
      const previous = bridgeRows(store).bridges.get(id);
      if (!previous) return { ok: true };
      writeRows(
        store,
        host.publish,
        Object.values(rowKeys).map((key) => ({ key: key(id), value: false })),
        commandId ? `bridge:remove:${commandId}` : undefined,
      );
      if (previous.credentialRef) await host.secrets?.remove?.(previous.credentialRef);
      host.onRemoved?.(id);
      host.changed();
      return { ok: true };
    }
    if (method !== "bridge.save") return undefined;
    const input = parse(BridgeInputSchema, params.bridge);
    const credentials = params.credentials as Record<string, string> | undefined;
    if (
      credentials !== undefined &&
      !Value.Check(BridgeInputSchema.properties.options, credentials)
    )
      throw new Error("invalid_bridge: credentials");
    const label = input.label.trim();
    if (!label) throw new Error("invalid_bridge: name the bridge");
    checkRoutes(store, input.routes);
    const previous = bridgeRows(store).bridges.get(input.id);
    if (previous && previous.kind !== input.kind)
      throw new Error("invalid_bridge: a bridge keeps its app");
    // A replayed save already happened; storing its tokens again would orphan a keychain entry.
    if (commandId && store.receipt(`bridge:save:${commandId}`)) {
      const view = bridgeView(store, input.id);
      if (view) return view;
    }
    let credentialRef = previous?.credentialRef;
    const tokens = Object.fromEntries(
      Object.entries(credentials ?? {})
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value),
    );
    if (Object.keys(tokens).length) {
      if (!host.secrets) throw new Error("keychain_unavailable");
      for (const value of Object.values(tokens)) host.remember(value);
      // Keep any saved token the owner didn't paste again, such as WhatsApp's app secret.
      // A failed read stops the save rather than silently dropping the tokens it couldn't read.
      const kept = previous?.credentialRef
        ? ((await host.secrets.read(previous.credentialRef).catch(() => {
            throw new Error("keychain_unavailable");
          })) as Record<string, string>)
        : {};
      for (const value of Object.values(kept)) if (typeof value === "string") host.remember(value);
      // A new reference, so the running connection restarts with the new token.
      credentialRef = (await host.secrets.put({ ...kept, ...tokens })).reference;
    }
    const now = new Date().toISOString();
    let bridge: Bridge = {
      id: input.id,
      kind: input.kind,
      label,
      ...(credentialRef ? { credentialRef } : {}),
      enabled: input.enabled,
      routes: input.routes.map((route) => ({
        ...route,
        from: { id: route.from.id.trim(), label: route.from.label.trim() },
        allow: route.allow.map((person) => ({ id: person.id.trim(), name: person.name.trim() })),
      })),
      options: ownOptions(input, previous),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    bridge = host.prepare?.(bridge, previous) ?? bridge;
    // People now on a list no longer show as refused.
    const allowed = new Set(bridge.routes.flatMap((route) => route.allow.map((p) => p.id)));
    const refused = bridgeRows(store).refused.get(bridge.id) ?? [];
    const kept = refused.filter((entry) => !allowed.has(entry.person.id));
    writeRows(
      store,
      host.publish,
      [
        { key: rowKeys.record(bridge.id), value: bridge },
        ...(kept.length !== refused.length
          ? [{ key: rowKeys.refused(bridge.id), value: kept }]
          : []),
      ],
      commandId ? `bridge:save:${commandId}` : undefined,
    );
    // The old token goes only once the record points at the new one.
    if (previous?.credentialRef && previous.credentialRef !== credentialRef)
      await host.secrets?.remove?.(previous.credentialRef).catch(() => {});
    host.changed();
    const view = bridgeView(store, bridge.id);
    if (!view) throw new Error("command_receipt_conflict");
    return view;
  };
}
