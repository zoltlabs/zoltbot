import { createHash } from "node:crypto";
import type { DomainState } from "@zoltbot/core";

function quote(value: string) {
  if (/[\0\r\n]/.test(value)) throw new Error("invalid_resume_argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function nativeApi(host: { snapshot(): DomainState; seq(): number }) {
  return (method: string, params: Record<string, unknown>): unknown => {
    if (method !== "native.list" && method !== "native.openCommand") return undefined;
    const state = host.snapshot();
    const rows = state.nativeSession ?? [];
    if (method === "native.openCommand") {
      const row = rows.find(
        (row) => row.provider === params.provider && row.nativeId === params.nativeId,
      );
      if (!row) throw new Error("native_session_not_found");
      const commands: Record<string, string[]> = {
        claude: ["claude", "--resume"],
        codex: ["codex", "resume"],
      };
      const provider = String(row.provider);
      const command = Object.hasOwn(commands, provider) ? commands[provider] : undefined;
      if (!command) throw new Error("resume_command_unverified");
      if (String(row.nativeId).startsWith("-")) throw new Error("invalid_resume_argument");
      return { command: [...command, String(row.nativeId)].map(quote).join(" ") };
    }
    const limit = params.limit ?? 50;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("invalid_native_page_size");
    const filter = createHash("sha256")
      .update(JSON.stringify([params.agentId ?? null, params.projectId ?? null]))
      .digest("hex")
      .slice(0, 16);
    const seq = host.seq();
    let offset = 0;
    if (params.cursor !== undefined) {
      const match = /^n1:(\d{1,16}):(\d{1,9}):([a-f0-9]{16})$/.exec(String(params.cursor));
      if (!match || Number(match[1]) !== seq || match[3] !== filter)
        throw new Error("native_cursor_stale");
      offset = Number(match[2]);
    }
    const selected = rows
      .filter((row) => {
        if (!params.agentId && !params.projectId) return true;
        const thread = state.thread?.find((thread) => thread.id === row.threadId);
        return (
          thread &&
          (!params.agentId || thread.agentId === params.agentId) &&
          (!params.projectId || thread.projectId === params.projectId)
        );
      })
      .sort((a, b) =>
        JSON.stringify([a.provider, a.nativeId]).localeCompare(
          JSON.stringify([b.provider, b.nativeId]),
        ),
      );
    const items = structuredClone(selected.slice(offset, offset + limit));
    return {
      items,
      ...(offset + limit < selected.length
        ? { cursor: `n1:${seq}:${offset + limit}:${filter}` }
        : {}),
    };
  };
}
