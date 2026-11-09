import { randomUUID } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import { handle } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { browserGeneration, frozenBrowser } from "./evidence.js";
import { type BrowserBinding, browserCommand, browserReadiness, setupBrowser } from "./runtime.js";
export function browserApi(
  store: Store,
  directory: string,
  options: {
    onReady?: () => void;
    checkPublic?: (value: unknown) => Promise<(state: DomainState) => void>;
    publish?: (events: DomainEvent[]) => void;
  } = {},
) {
  const pending = new Set<string>();
  const audit = async (
    action: string,
    target: string,
    authority: "human" | "task_policy",
    input: unknown,
  ) => {
    const guard = await options.checkPublic?.(input);
    const id = `browser:${randomUUID()}`;
    const at = new Date().toISOString();
    const actor = {
      kind: authority === "human" ? ("human" as const) : ("system" as const),
      id: authority === "human" ? "local-owner" : "task-policy",
    };
    const before = store.lastSeq();
    store.dispatch(id, (state) => {
      guard?.(state);
      return handle(
        state,
        {
          type: "create",
          kind: "audit",
          value: {
            id,
            actor,
            action: `browser.${action}`,
            target,
            result: "authorized",
            detail: { confirmed: true, authority },
            at,
          },
        },
        { commandId: id, at, actor },
      );
    });
    options.publish?.(store.eventsSince(before));
  };
  return async (
    method: string,
    p: Record<string, unknown>,
    authority: "human" | "task_policy" = "human",
  ) => {
    if (!method.startsWith("browser.")) return undefined;
    if (method === "browser.readiness") return browserReadiness(directory);
    if (method === "browser.setup") {
      if (p.confirmed !== true) throw Error("confirmation_required");
      if (pending.has("setup")) throw Error("browser_setup_running");
      pending.add("setup");
      try {
        await audit("setup", "local-browser", authority, {});
        const readiness = await setupBrowser(directory);
        if (readiness.state === "ready") options.onReady?.();
        return readiness;
      } finally {
        pending.delete("setup");
      }
    }
    const id = String(p.id);
    if (method === "browser.task") {
      const task = store.record("task", id);
      if (!task) throw Error("task_not_found");
      const evidence = store.database
        .prepare(
          "SELECT metadata FROM browser_evidence WHERE task_id=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(id) as { metadata: string }[];
      let owner: ReturnType<typeof frozenBrowser> | undefined;
      try {
        owner = frozenBrowser(store, id);
      } catch {}
      if (owner) browserGeneration(store, owner.binding.id, owner.binding);
      const lifecycle = owner
        ? store.database
            .prepare(
              "SELECT generation,state,mode,url,updated_at FROM browser_lifecycle WHERE binding_id=?",
            )
            .get(owner.binding.id)
        : undefined;
      let health = "not_open";
      if (owner)
        try {
          await browserCommand(owner.binding, ["snapshot"]);
          health = "running";
        } catch {
          health = "disconnected";
        }
      return {
        selection: task.browser ?? null,
        binding: owner?.binding ?? null,
        lifecycle: lifecycle ?? null,
        health,
        association: "user_or_agent_supplied",
        evidence: evidence.map((r) => {
          const e = JSON.parse(r.metadata);
          return {
            ...e,
            observed: !!store.database
              .prepare("SELECT 1 FROM browser_observations WHERE evidence_id=? LIMIT 1")
              .get(e.id),
          };
        }),
      };
    }
    if (method !== "browser.action") throw Error("unknown_browser_method");
    if (p.confirmed !== true) throw Error("confirmation_required");
    if (pending.has(id)) throw Error("browser_action_running");
    pending.add(id);
    try {
      const owner = frozenBrowser(store, id);
      const b = owner.binding;
      let generation = browserGeneration(store, b.id, b);
      const prior = store.database
        .prepare("SELECT state,mode FROM browser_lifecycle WHERE binding_id=?")
        .get(b.id) as { state: string; mode: string } | undefined;
      if (!prior && p.action !== "stop") generation = 0;
      const visible = p.action === "reopen_visible";
      const url = typeof p.url === "string" ? p.url : b.url;
      if (url) {
        const parsed = new URL(url);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash
        )
          throw Error("browser_url_requires_plain_http_origin_or_path");
      }
      if (p.action !== "stop" && !url) throw Error("browser_url_required");
      if (p.action === "open" && prior?.state === "running") {
        try {
          await browserCommand(b, ["snapshot"]);
          return { ok: true, generation };
        } catch {}
      }

      await audit(String(p.action), b.id, authority, { url });
      store.database
        .prepare(
          "INSERT INTO browser_lifecycle(binding_id,generation,state,mode,url,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET generation=excluded.generation,state=excluded.state,mode=excluded.mode,url=excluded.url,updated_at=excluded.updated_at",
        )
        .run(
          b.id,
          generation,
          "pending",
          visible ? "visible" : b.mode,
          url ?? null,
          new Date().toISOString(),
        );
      if (p.action === "stop" || visible)
        try {
          await browserCommand(b, ["close"]);
        } catch {
          if (p.action === "stop") throw Error("browser_stop_uncertain");
        }
      if (p.action !== "stop") {
        // Visible restart uses a distinct immutable launcher/config with the same owned session.
        const launch: BrowserBinding = visible
          ? { ...b, mode: "visible", launcher: `${b.launcher}-visible/browser` }
          : b;
        await browserCommand(launch, ["open", url as string]);
      }
      generation = browserGeneration(store, b.id, b);
      store.database
        .prepare("UPDATE browser_lifecycle SET state=? WHERE binding_id=?")
        .run(p.action === "stop" ? "closed" : "running", b.id);
      return { ok: true, generation };
    } finally {
      pending.delete(id);
    }
  };
}
