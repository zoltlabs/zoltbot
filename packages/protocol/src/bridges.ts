// I1: bridges carry chats from Slack, Telegram, Discord and WhatsApp to Zoltbot chats and
// channels. A bridge is a settings row written only by the daemon (`bridge.*` methods); its token
// lives in the keychain and the row keeps the opaque reference (I7).
import { type Static, Type } from "@sinclair/typebox";
import { At, Id, OptionalText, object, values } from "./common.js";

const ok = object({ ok: Type.Boolean() });

export const BRIDGE_KINDS = ["slack", "telegram", "discord", "whatsapp"] as const;
export const BridgeKindSchema = values([...BRIDGE_KINDS]);
export type BridgeKind = Static<typeof BridgeKindSchema>;

/** The app's name as people know it, for lists and the text an agent reads. */
export const BRIDGE_APP_NAMES: Record<BridgeKind, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
};

/** The app the owner creates from this manifest has exactly the scopes the bridge uses. */
export const SLACK_APP_MANIFEST = {
  display_information: { name: "Zoltbot" },
  features: {
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "Zoltbot", always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "channels:read",
        "chat:write",
        "chat:write.customize",
        "groups:read",
        "im:history",
        "users:read",
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["app_mention", "message.im"] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

/** A place outside Zoltbot: a Slack channel, a Telegram chat, a Discord channel. */
export const BridgePlaceSchema = object({
  /** The app's own id. `dm` matches every direct message to the bot. */
  id: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ maxLength: 200 }),
});
export type BridgePlace = Static<typeof BridgePlaceSchema>;
/** Direct messages to the bot, whoever sends them. */
export const BRIDGE_DIRECT = "dm";

export const BridgeTargetSchema = Type.Union([
  object({ kind: Type.Literal("chat"), threadId: Id }),
  object({ kind: Type.Literal("channel"), channelId: Id }),
]);
export type BridgeTarget = Static<typeof BridgeTargetSchema>;

/** Someone on the app, by the app's user id. */
export const BridgePersonSchema = object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  name: Type.String({ maxLength: 200 }),
});
export type BridgePerson = Static<typeof BridgePersonSchema>;

export const MAX_BRIDGE_ROUTES = 50;
export const MAX_BRIDGE_PEOPLE = 100;

export const BridgeRouteSchema = object({
  id: Id,
  from: BridgePlaceSchema,
  to: BridgeTargetSchema,
  /** Who may talk here. Everyone else gets no reply. Empty means nobody. */
  allow: Type.Array(BridgePersonSchema, { maxItems: MAX_BRIDGE_PEOPLE }),
});
export type BridgeRoute = Static<typeof BridgeRouteSchema>;

export const BridgeSchema = object({
  id: Id,
  kind: BridgeKindSchema,
  label: Type.String({ minLength: 1, maxLength: 120 }),
  /** `keychain:zoltbot:<uuid>`; never the token itself. */
  credentialRef: OptionalText,
  enabled: Type.Boolean(),
  routes: Type.Array(BridgeRouteSchema, { maxItems: MAX_BRIDGE_ROUTES }),
  /** Settings for one app that aren't secret, such as a Telegram pairing code. */
  options: Type.Optional(Type.Record(Type.String({ maxLength: 60 }), Type.Unknown())),
  createdAt: At,
  updatedAt: At,
});
export type Bridge = Static<typeof BridgeSchema>;

/** Why a bridge isn't running, so the screen can name the step that fixes it. */
export const BridgeProblemSchema = values([
  "not_set_up",
  "token_refused",
  "keychain_unavailable",
  "needs_account",
  "network",
]);
export type BridgeProblem = Static<typeof BridgeProblemSchema>;

export const BridgeStatusSchema = object({
  state: values(["connected", "reconnecting", "stopped"]),
  problem: Type.Optional(BridgeProblemSchema),
  /** Shown on the bridge's row, such as the Slack workspace or the bot's user name. */
  account: Type.Optional(Type.String({ maxLength: 200 })),
  at: At,
});
export type BridgeStatus = Static<typeof BridgeStatusSchema>;

/** Someone who wrote but isn't on the route's list. Newest first, at most 20 a bridge. */
export const BridgeRefusalSchema = object({
  id: Id,
  routeId: Type.Optional(Id),
  place: BridgePlaceSchema,
  person: BridgePersonSchema,
  at: At,
});
export type BridgeRefusal = Static<typeof BridgeRefusalSchema>;
export const MAX_BRIDGE_REFUSALS = 20;

export const BRIDGE_PREFIX = "bridge.";
export const bridgeKey = (id: string) => `bridge.record.${id}`;
export const bridgeStatusKey = (id: string) => `bridge.status.${id}`;
export const bridgeRefusedKey = (id: string) => `bridge.refused.${id}`;
/** Bridged messages waiting for their reply, so a restart still answers them. */
export const bridgePendingKey = (id: string) => `bridge.pending.${id}`;

/** The bridge id a settings key belongs to, and which row it is. */
export function bridgeRow(
  key: unknown,
): { id: string; row: "record" | "status" | "refused" | "pending" } | undefined {
  if (typeof key !== "string") return undefined;
  const match = /^bridge\.(record|status|refused|pending)\.(.+)$/.exec(key);
  if (!match?.[2]) return undefined;
  return { id: match[2], row: match[1] as "record" | "status" | "refused" | "pending" };
}

export const BridgeViewSchema = object({
  bridge: BridgeSchema,
  status: BridgeStatusSchema,
  refused: Type.Array(BridgeRefusalSchema, { maxItems: MAX_BRIDGE_REFUSALS }),
});
export type BridgeView = Static<typeof BridgeViewSchema>;

/** What a client sends to add or change a bridge; the daemon keeps ids and times. */
export const BridgeInputSchema = object({
  id: Id,
  kind: BridgeKindSchema,
  label: Type.String({ minLength: 1, maxLength: 120 }),
  enabled: Type.Boolean(),
  routes: Type.Array(BridgeRouteSchema, { maxItems: MAX_BRIDGE_ROUTES }),
  options: Type.Optional(Type.Record(Type.String({ maxLength: 60 }), Type.Unknown())),
});
export type BridgeInput = Static<typeof BridgeInputSchema>;

export const bridgeMethods = {
  "bridge.list": { params: object({}), result: object({ items: Type.Array(BridgeViewSchema) }) },
  /**
   * Adds or changes a bridge. `credentials` are the app's tokens: they go to the keychain and
   * are never stored or returned. Leave them out to keep the saved ones.
   */
  "bridge.save": {
    params: object({
      bridge: BridgeInputSchema,
      credentials: Type.Optional(
        Type.Record(Type.String({ maxLength: 60 }), Type.String({ maxLength: 4000 })),
      ),
    }),
    result: BridgeViewSchema,
  },
  /** Deletes the bridge and its saved tokens (I13). */
  "bridge.remove": { params: object({ id: Id, confirmed: Type.Literal(true) }), result: ok },
};
/** Tokens are pasted on the Mac; a phone can't add or change a bridge. */
export const bridgeMacOnlyMethods = ["bridge.list", "bridge.save", "bridge.remove"] as const;
