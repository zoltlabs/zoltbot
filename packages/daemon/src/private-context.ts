import { randomUUID } from "node:crypto";
import { applyEvents, type DomainState, handle } from "@zoltbot/core";
import { compareSessions, type DomainEvent, sessionGeneration } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { connectionCredentialReferences, connectionPrivateValues } from "./connections-private.js";
import type { Redactor } from "./logging.js";
import { protectedCredentialReferences, readRuntimeCredential } from "./runtime-credentials.js";
import type { KeychainSecrets } from "./secrets.js";

export type PrivateVault = Pick<KeychainSecrets, "put" | "read"> &
  Partial<Pick<KeychainSecrets, "remove" | "replace">>;
export class PrivateContexts {
  private readonly pending = new Map<string, Promise<void>>();
  private cached: { stamp: string; values: ReadonlySet<string> } | undefined;
  private loading:
    | { stamp: string; work: Promise<{ stamp: string; values: ReadonlySet<string> }> }
    | undefined;
  constructor(
    private readonly options: {
      store: Store;
      vault: PrivateVault;
      publish(events: DomainEvent[]): void;
    },
  ) {}
  async restore(sessionIds: readonly string[], redactor: Redactor): Promise<string[] | undefined> {
    const state = this.options.store.snapshot(["settings"]);
    const linked = sessionIds
      .map((id) => state.settings?.find((row) => row.key === `runtime.privateRef.${id}`))
      .find((row) => row !== undefined);
    if (!linked) return undefined;
    try {
      if (typeof linked.value !== "string") throw new Error();
      const values = await this.read(linked.value);
      for (const value of values) redactor.register(value);
      redactor.hideFrames();
      return values;
    } catch {
      throw new Error("runtime_private_context_required");
    }
  }
  private async read(reference: string): Promise<string[]> {
    try {
      const context = await this.options.vault.read(reference);
      if (!context || typeof context !== "object" || Array.isArray(context)) throw new Error();
      const value = context as Record<string, unknown>;
      if (
        value.version !== 1 ||
        Object.keys(value).some((key) => !["version", "hideFrames", "values"].includes(key)) ||
        value.hideFrames !== true ||
        !Array.isArray(value.values) ||
        value.values.length > 10000 ||
        value.values.some((entry) => typeof entry !== "string")
      )
        throw new Error();
      return value.values as string[];
    } catch {
      throw new Error("runtime_private_context_required");
    }
  }
  stamp(state: DomainState): string {
    return JSON.stringify(
      [
        ...(state.settings ?? [])
          .filter(
            (row) =>
              String(row.key).startsWith("runtime.privateRef.") ||
              (String(row.key).startsWith("runtime.private.") && row.value === true),
          )
          .map((row) => [row.key, row.value]),
        ...connectionCredentialReferences(this.options.store).map(({ id, reference }) => [
          `connection.credential.${id}`,
          reference,
        ]),
        ...protectedCredentialReferences(state).map(([id, name, reference]) => [
          `runtime.credential.${JSON.stringify([id, name])}`,
          reference,
        ]),
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  }
  async known(
    covered: ReadonlySet<string> = new Set(),
  ): Promise<{ stamp: string; values: ReadonlySet<string> }> {
    const state = this.options.store.snapshot(["settings", "session", "agentDefinition"]),
      stamp = this.stamp(state);
    const refs = (state.settings ?? []).filter((row) =>
      String(row.key).startsWith("runtime.privateRef."),
    );
    const source = (row: Record<string, unknown>) =>
      state.session?.find(
        (session) => session.id === String(row.key).slice("runtime.privateRef.".length),
      );
    for (const marker of state.settings ?? []) {
      if (!String(marker.key).startsWith("runtime.private.") || marker.value !== true) continue;
      const id = String(marker.key).slice("runtime.private.".length);
      if (covered.has(id)) continue;
      if (refs.some((row) => row.key === `runtime.privateRef.${id}`)) continue;
      const original = state.session?.find((row) => row.id === id);
      if (
        !original ||
        typeof original.nativeId !== "string" ||
        !refs.some((row) => {
          const session = source(row);
          return (
            session &&
            session.threadId === original.threadId &&
            session.provider === original.provider &&
            session.nativeId === original.nativeId &&
            session.cwd === original.cwd &&
            sessionGeneration(session) >= sessionGeneration(original)
          );
        })
      )
        throw new Error("runtime_private_context_required");
    }
    if (this.cached?.stamp === stamp) return this.cached;
    if (this.loading?.stamp === stamp) return this.loading.work;
    const work = (async () => {
      const selected = new Map<string, Record<string, unknown>>();
      for (const row of refs.sort((a, b) => compareSessions(source(a) ?? {}, source(b) ?? {}))) {
        const session = source(row),
          scope =
            session && typeof session.nativeId === "string"
              ? JSON.stringify([session.threadId, session.provider, session.nativeId, session.cwd])
              : String(row.key);
        if (!selected.has(scope)) selected.set(scope, row);
      }
      const values = new Set<string>();
      for (const row of selected.values()) {
        if (typeof row.value !== "string") throw new Error("runtime_private_context_required");
        for (const value of await this.read(row.value)) values.add(value);
      }
      for (const reference of new Set(protectedCredentialReferences(state).map((row) => row[2])))
        values.add(await readRuntimeCredential(this.options.vault, reference));
      for (const { reference } of connectionCredentialReferences(this.options.store))
        for (const value of await connectionPrivateValues(this.options.vault, reference))
          values.add(value);
      if (this.stamp(this.options.store.snapshot(["settings", "agentDefinition"])) !== stamp)
        throw new Error("private_context_changed");
      const result = { stamp, values };
      this.cached = result;
      return result;
    })();
    this.loading = { stamp, work };
    try {
      return await work;
    } finally {
      if (this.loading?.work === work) this.loading = undefined;
    }
  }
  persist(sessionId: string, knownValues: ReadonlySet<string>): Promise<void> {
    const work = (this.pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const saved = await this.options.vault.put({
          version: 1,
          hideFrames: true,
          values: [...knownValues],
        });
        const key = `runtime.privateRef.${sessionId}`,
          commandId = `private-context:${randomUUID()}`,
          before = this.options.store.lastSeq();
        this.options.store.dispatch(commandId, (state) => {
          const context = {
            commandId,
            at: new Date().toISOString(),
            actor: { kind: "system" as const, id: "runtime" },
          };
          const linked = handle(
            state,
            state.settings?.some((row) => row.key === key)
              ? { type: "update", kind: "settings", id: key, changes: { value: saved.reference } }
              : { type: "create", kind: "settings", value: { key, value: saved.reference } },
            context,
          );
          const marker = `runtime.private.${sessionId}`;
          const marked = state.settings?.some((row) => row.key === marker && row.value === true)
            ? { events: [], result: {} }
            : handle(
                applyEvents(state, linked.events),
                state.settings?.some((row) => row.key === marker)
                  ? { type: "update", kind: "settings", id: marker, changes: { value: true } }
                  : { type: "create", kind: "settings", value: { key: marker, value: true } },
                context,
              );
          return {
            ...linked,
            events: [...linked.events, ...marked.events].map((event, index) => ({
              ...event,
              eventId: `${commandId}:${index}`,
            })),
          };
        });
        this.options.publish(this.options.store.eventsSince(before));
      });
    this.pending.set(sessionId, work);
    void work.then(
      () => {
        if (this.pending.get(sessionId) === work) this.pending.delete(sessionId);
      },
      () => {
        if (this.pending.get(sessionId) === work) this.pending.delete(sessionId);
      },
    );
    return work;
  }
  async settle() {
    await Promise.allSettled([...this.pending.values()]);
  }
}
