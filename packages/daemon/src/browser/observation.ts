import { realpathSync } from "node:fs";
import type { AgentEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { type BrowserEvidence, evidenceBytes, frozenBrowser } from "./evidence.js";
/** Image delivery is observed only after a successful known native image result, never a start. */
export function browserObserver(store: Store, executionId: string, sessionId: string) {
  const pending = new Map<string, { id: string; hash: string }>();
  return (event: AgentEvent) => {
    if (event.t === "tool.started" && event.kind === "read" && event.name === "Read") {
      const file = (event.input as { file_path?: unknown })?.file_path;
      if (typeof file !== "string") return;
      let canonical: string;
      try {
        canonical = realpathSync(file);
      } catch {
        return;
      }
      const rows = store.database.prepare("SELECT metadata FROM browser_evidence").all() as {
        metadata: string;
      }[];
      for (const row of rows) {
        const e = JSON.parse(row.metadata) as BrowserEvidence;
        if (e.executionId === executionId && e.canonicalPath === canonical) {
          try {
            if (frozenBrowser(store, e.taskId, sessionId).executionId !== executionId) continue;
            evidenceBytes(store, e.id);
            pending.set(event.itemId, { id: e.id, hash: e.hash });
          } catch {}
          break;
        }
      }
    }
    if (event.t === "tool.done") {
      const receipt = pending.get(event.itemId);
      pending.delete(event.itemId);
      if (!receipt || event.status !== "ok" || !Array.isArray(event.output)) return;
      if (
        !event.output.some(
          (p) => p && typeof p === "object" && (p as { type?: unknown }).type === "image",
        )
      )
        return;
      try {
        evidenceBytes(store, receipt.id);
        store.database
          .prepare(
            "INSERT OR IGNORE INTO browser_observations(evidence_id,session_id,item_id,observed_at) VALUES(?,?,?,?)",
          )
          .run(receipt.id, sessionId, event.itemId, new Date().toISOString());
      } catch {}
    }
  };
}
