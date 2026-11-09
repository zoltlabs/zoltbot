import type { ToolKind } from "@zoltbot/protocol";

/** Claude tool names stay inside the adapter (I4); events carry provider-neutral kinds. */
export const editTools = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
/** Tools that are answered through an interaction card instead of the tool timeline. */
export const interactiveTools = ["AskUserQuestion", "ExitPlanMode"];
export const agentTools = ["Task", "Agent"];

type Input = Record<string, unknown>;
interface Diff {
  path: string;
  before?: string;
  after?: string;
}
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
// Tool timeline titles are one line summaries, not a copy of the input.
const line = (value: string, limit = 300) => {
  const first = value.trim().split("\n")[0] ?? "";
  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
};

export function toolKind(name: string): ToolKind {
  if (name === "Bash") return "execute";
  if (name === "Read") return "read";
  if (editTools.includes(name)) return "edit";
  if (["Glob", "Grep", "WebSearch"].includes(name)) return "search";
  if (name === "WebFetch") return "fetch";
  if (agentTools.includes(name)) return "agent";
  return "other";
}
export function toolPath(name: string, input: Input) {
  if (name === "NotebookEdit") return text(input.notebook_path);
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name)) return text(input.file_path);
  return undefined;
}
export function toolTitle(name: string, input: Input): string | undefined {
  if (name === "Bash") {
    const value = text(input.command) ?? text(input.description);
    return value && line(value);
  }
  const file = toolPath(name, input);
  if (file) return line(file, 500);
  if (name === "Grep" || name === "Glob") {
    const pattern = text(input.pattern);
    if (!pattern) return undefined;
    const where = text(input.path);
    return line(where ? `${pattern} in ${where}` : pattern);
  }
  if (name === "WebFetch") return text(input.url) && line(input.url as string, 500);
  if (name === "WebSearch") return text(input.query) && line(input.query as string);
  if (agentTools.includes(name))
    return text(input.description) && line(input.description as string);
  if (name === "TodoWrite") return "Update to-do list";
  return undefined;
}
export function toolLocations(name: string, input: Input) {
  const file = toolPath(name, input);
  if (!file) return undefined;
  const line =
    name === "Read" && Number.isSafeInteger(input.offset) && Number(input.offset) >= 1
      ? Number(input.offset)
      : undefined;
  return [{ path: file, ...(line ? { line } : {}) }];
}

// Approval cards and tool results carry the proposed change. A change that does not fit whole,
// too many edits or any oversized side, carries no diffs at all: never a misleading partial one.
const maxDiffs = 50,
  maxSide = 65536;
export function toolDiffs(name: string, input: Input): Diff[] | undefined {
  const file = toolPath(name, input);
  if (!file) return undefined;
  const diffs: Diff[] = [];
  let whole = true;
  const add = (before: string | undefined, after: string) => {
    if ((before?.length ?? 0) > maxSide || after.length > maxSide) whole = false;
    diffs.push({ path: file, ...(before !== undefined ? { before } : {}), after });
  };
  if (name === "Edit") {
    if (typeof input.old_string !== "string" || typeof input.new_string !== "string")
      return undefined;
    add(input.old_string, input.new_string);
  } else if (name === "MultiEdit") {
    if (!Array.isArray(input.edits) || input.edits.length > maxDiffs) return undefined;
    for (const raw of input.edits) {
      if (!raw || typeof raw !== "object") return undefined;
      const edit = raw as Input;
      if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string")
        return undefined;
      add(edit.old_string, edit.new_string);
    }
  } else if (name === "Write") {
    if (typeof input.content !== "string") return undefined;
    add(undefined, input.content);
  } else if (name === "NotebookEdit") {
    if (typeof input.new_source !== "string") return undefined;
    add(undefined, input.new_source);
  } else return undefined;
  return whole && diffs.length ? diffs : undefined;
}
/** Subagent results arrive as text content blocks; show them as plain text. */
export function agentOutput(content: unknown) {
  if (!Array.isArray(content)) return content;
  const parts = content.map((block) =>
    block && typeof block === "object" && (block as Input).type === "text"
      ? (block as Input).text
      : undefined,
  );
  return parts.every((part) => typeof part === "string") ? parts.join("\n") : content;
}
