import { type Static, Type } from "@sinclair/typebox";
import { At, Id, OptionalText, object, Text, values } from "./common.js";

// Backup models: several sign-ins per coding tool and an ordered fallback list per role.
// An account only names the provider's own config folder; credentials stay in that folder or
// the Keychain, where the provider's sign-in put them.

export const ModelAccountLoginSchema = values(["signed_in", "signed_out", "unknown"]);
export const ModelAccountSchema = object({
  id: Id,
  label: Type.String({ minLength: 1, maxLength: 80 }),
  /** The agent definition this sign-in runs. */
  definitionId: Id,
  /** The definition's adapter, for grouping. */
  provider: Id,
  /** The provider's config folder for this sign-in. */
  configDirectory: Text,
  /** The sign-in the definition uses when no account is chosen. It cannot be removed. */
  isDefault: Type.Boolean(),
  /** The tool reads its sign-in folder from a setting, so it can hold more than one sign-in. */
  canAddAccounts: Type.Optional(Type.Boolean()),
  login: ModelAccountLoginSchema,
  /** Present while the account is at a usage limit. */
  limit: Type.Optional(object({ resetsAt: OptionalText, observedAt: At })),
  /** Chats currently running on this account because of a switch. */
  inUse: Type.Integer({ minimum: 0 }),
  createdAt: Type.Optional(At),
});
export type ModelAccount = Static<typeof ModelAccountSchema>;
export const BackupEntrySchema = object({
  accountId: Id,
  /** Absent: the agent's own model on its own provider, otherwise the provider's default. */
  model: OptionalText,
});
export type BackupEntry = Static<typeof BackupEntrySchema>;
const Entries = Type.Array(BackupEntrySchema, { maxItems: 8 });
export const BackupRoleSchema = values(["ceo", "manager", "employee"]);
export type BackupRole = Static<typeof BackupRoleSchema>;
export const BackupOrdersSchema = object({
  employee: Entries,
  /** Null: same as employees. */
  manager: Type.Union([Entries, Type.Null()]),
  /** Null: same as employees. */
  ceo: Type.Union([Entries, Type.Null()]),
  /** Per-agent orders by chat id. They replace the role order. */
  agents: Type.Record(Id, Entries),
});
export type BackupOrders = Static<typeof BackupOrdersSchema>;
/** The note item a switch writes into the chat. */
export const ModelSwitchNoteSchema = object({
  code: Type.Literal("model_switch"),
  change: values(["switched", "returned", "exhausted"]),
  from: Text,
  to: OptionalText,
  until: OptionalText,
  /** The switch started a fresh native session with the visible conversation copied in. */
  copied: Type.Optional(Type.Boolean()),
  text: Text,
});
export type ModelSwitchNote = Static<typeof ModelSwitchNoteSchema>;
const SignInSchema = object({
  command: Text,
  configDirectory: Text,
  /** What to type inside the tool when the command only opens it. */
  slashCommand: OptionalText,
});
const ok = object({ ok: Type.Boolean() });
export const backupModelMethods = {
  "modelAccount.list": {
    params: object({}),
    result: object({ items: Type.Array(ModelAccountSchema), orders: BackupOrdersSchema }),
  },
  /** Creates a config folder for a new sign-in and returns the command that signs in there. */
  "modelAccount.add": {
    params: object({ definitionId: Id, label: Type.String({ minLength: 1, maxLength: 80 }) }),
    result: object({ account: ModelAccountSchema, signIn: SignInSchema }),
  },
  "modelAccount.signIn": { params: object({ id: Id }), result: SignInSchema },
  /** Asks the provider whether this folder is signed in. */
  "modelAccount.check": { params: object({ id: Id }), result: ModelAccountSchema },
  "modelAccount.remove": {
    params: object({ id: Id, confirmed: Type.Literal(true) }),
    result: ok,
  },
  "backupOrder.set": {
    params: Type.Union([
      object({ role: BackupRoleSchema, entries: Type.Union([Entries, Type.Null()]) }),
      object({ threadId: Id, entries: Type.Union([Entries, Type.Null()]) }),
    ]),
    result: BackupOrdersSchema,
  },
};
/** Sign-ins run on the Mac. */
export const backupModelMacOnlyMethods = [
  "modelAccount.add",
  "modelAccount.signIn",
  "modelAccount.check",
  "modelAccount.remove",
] as const;
