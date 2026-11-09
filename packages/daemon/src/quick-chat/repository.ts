import type { QuickChat, QuickConnection, QuickMessage, QuickSettings } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export type StoredConnection = QuickConnection;
export type StoredSettings = QuickSettings;
const defaults: StoredSettings = { deeperModels: {} };
export function publicConnection(row: StoredConnection, secretRef: string | null): QuickConnection {
  return { ...row, hasSecret: Boolean(secretRef) };
}
/** Plain SQL over the Quick Chat tables (migration 015). Not part of the event log. */
export class QuickRepository {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.database;
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  chats(limit = 100): QuickChat[] {
    return (
      this.db
        .prepare("SELECT body FROM quick_chats ORDER BY updated_at DESC, id LIMIT ?")
        .all(limit) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  chat(id: string): QuickChat | undefined {
    const row = this.db.prepare("SELECT body FROM quick_chats WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  saveChat(chat: QuickChat) {
    this.db
      .prepare(
        "INSERT INTO quick_chats(id,title,body,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at",
      )
      .run(chat.id, chat.title, JSON.stringify(chat), chat.createdAt, chat.updatedAt);
  }
  /** Removes the chat, its messages and request receipts. */
  deleteChat(id: string): boolean {
    return this.db.prepare("DELETE FROM quick_chats WHERE id=?").run(id).changes > 0;
  }
  messages(chatId: string): QuickMessage[] {
    return (
      this.db
        .prepare("SELECT body FROM quick_messages WHERE chat_id=? ORDER BY seq")
        .all(chatId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  message(id: string): QuickMessage | undefined {
    const row = this.db.prepare("SELECT body FROM quick_messages WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  insertMessage(message: QuickMessage) {
    const next = (
      this.db
        .prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM quick_messages WHERE chat_id=?")
        .get(message.chatId) as { n: number }
    ).n;
    this.db
      .prepare(
        "INSERT INTO quick_messages(id,chat_id,seq,role,status,body,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        message.id,
        message.chatId,
        next,
        message.role,
        message.status,
        JSON.stringify(message),
        message.createdAt,
      );
  }
  /** Returns false when the message was deleted with its chat while a reply was running. */
  updateMessage(message: QuickMessage): boolean {
    return (
      this.db
        .prepare("UPDATE quick_messages SET status=?, body=? WHERE id=?")
        .run(message.status, JSON.stringify(message), message.id).changes > 0
    );
  }
  /** Replies still streaming when the host stopped: the provider may have charged for them. */
  markAbandoned(message: string): QuickMessage[] {
    const rows = (
      this.db.prepare("SELECT body FROM quick_messages WHERE status='streaming'").all() as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as QuickMessage);
    for (const row of rows)
      this.updateMessage({
        ...row,
        status: row.text ? "interrupted" : "uncertain",
        error: { code: "host_restarted", message },
      });
    return rows;
  }
  request(commandId: string) {
    return this.db
      .prepare(
        "SELECT chat_id AS chatId, user_message_id AS userMessageId, reply_id AS replyId FROM quick_requests WHERE command_id=?",
      )
      .get(commandId) as { chatId: string; userMessageId: string; replyId: string } | undefined;
  }
  saveRequest(commandId: string, ids: { chatId: string; userMessageId: string; replyId: string }) {
    this.db
      .prepare(
        "INSERT INTO quick_requests(command_id,chat_id,user_message_id,reply_id,created_at) VALUES(?,?,?,?,?)",
      )
      .run(commandId, ids.chatId, ids.userMessageId, ids.replyId, new Date().toISOString());
  }
  replies(from?: string): QuickMessage[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM quick_messages WHERE role='assistant' AND created_at>=? ORDER BY created_at",
        )
        .all(from ?? "") as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  connections(): { row: StoredConnection; secretRef: string | null }[] {
    return (
      this.db
        .prepare("SELECT body, secret_ref FROM quick_connections ORDER BY created_at, id")
        .all() as { body: string; secret_ref: string | null }[]
    ).map((entry) => ({ row: JSON.parse(entry.body), secretRef: entry.secret_ref }));
  }
  connection(id: string): { row: StoredConnection; secretRef: string | null } | undefined {
    const entry = this.db
      .prepare("SELECT body, secret_ref FROM quick_connections WHERE id=?")
      .get(id) as { body: string; secret_ref: string | null } | undefined;
    return entry ? { row: JSON.parse(entry.body), secretRef: entry.secret_ref } : undefined;
  }
  saveConnection(row: StoredConnection, secretRef: string | null) {
    this.db
      .prepare(
        "INSERT INTO quick_connections(id,kind,body,secret_ref,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,secret_ref=excluded.secret_ref,updated_at=excluded.updated_at",
      )
      .run(row.id, row.kind, JSON.stringify(row), secretRef, row.createdAt, row.updatedAt);
  }
  removeConnection(id: string) {
    this.db.prepare("DELETE FROM quick_connections WHERE id=?").run(id);
  }
  setting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM quick_settings WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO quick_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  settings(): StoredSettings {
    return { ...defaults, ...(this.setting<StoredSettings>("defaults") ?? {}) };
  }
  saveSettings(settings: StoredSettings) {
    this.setSetting("defaults", settings);
  }
}
