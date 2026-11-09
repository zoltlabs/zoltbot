import { readdirSync } from "node:fs";
import { join } from "node:path";
import { handle } from "@zoltbot/core";
import type { DomainEvent, UserInput } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateInputGuard } from "./private-input.js";

export type DesignFile = { path: string; kind: "guide" | "tokens" };

// Repository files that already tell coding tools how to work, read only at a code root.
const instructionNames = ["AGENTS.md", "CLAUDE.md"];
const guide = /^(design|design[-_]system|style[-_]?guide|brand)\.md$/i;
const tokens = /^((design[-_])?tokens\.(css|scss|json|js|ts)|.+\.tokens\.json)$/i;
const skipped = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "Pods",
  "target",
]);
const maxDepth = 3,
  maxEntries = 4000,
  maxDesign = 8;

function codeRoots(project: Record<string, unknown> | undefined) {
  const roots = Array.isArray(project?.roots) ? (project.roots as { path?: unknown }[]) : [];
  return roots.map((root) => root.path).filter((path): path is string => typeof path === "string");
}

function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Instruction and design files in a workspace's code folders, found by name in a bounded walk. */
export function detectProjectFiles(project: Record<string, unknown> | undefined) {
  const instructions: string[] = [],
    design: DesignFile[] = [];
  for (const root of codeRoots(project)) {
    const top = entries(root);
    for (const name of instructionNames)
      if (top.some((entry) => entry.isFile() && entry.name === name))
        instructions.push(join(root, name));
    let queue = [root],
      seen = 0;
    for (let depth = 0; depth <= maxDepth && queue.length; depth++) {
      const next: string[] = [];
      for (const dir of queue) {
        for (const entry of entries(dir).sort((a, b) => a.name.localeCompare(b.name))) {
          if (++seen > maxEntries || design.length >= maxDesign) break;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && !skipped.has(entry.name)) next.push(path);
          } else if (entry.isFile()) {
            if (guide.test(entry.name)) design.push({ path, kind: "guide" });
            else if (tokens.test(entry.name)) design.push({ path, kind: "tokens" });
          }
        }
      }
      queue = next;
    }
  }
  // Style guides first: they say how to use the tokens.
  design.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "guide" ? -1 : 1));
  return { instructions, design };
}

/** The design files chats get: the owner's list when they edited it, else what is found. */
export function designFilesFor(project: Record<string, unknown> | undefined): string[] {
  if (Array.isArray(project?.designFiles))
    return (project.designFiles as unknown[]).filter(
      (path): path is string => typeof path === "string",
    );
  return detectProjectFiles(project).design.map((file) => file.path);
}

// What the workspace page may change. Roots, review gates and the rest stay with their own flows.
const editable = {
  project: [
    "name",
    "goal",
    "instructions",
    "constraints",
    "designFiles",
    "defaultAgentId",
    "artifactDesignContextId",
  ],
  subproject: ["name", "goal", "instructions"],
} as const;

export function projectFilesApi(host: {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
}) {
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (method === "project.files.detect") {
      if (typeof params.id !== "string") throw new Error("invalid_params");
      const project = host.store.record("project", params.id);
      if (!project || project.archived) throw new Error("scope_unavailable");
      return detectProjectFiles(project);
    }
    if (method !== "project.update" && method !== "subproject.update") return undefined;
    if (!commandId) throw new Error("command_id_required");
    const kind = method === "project.update" ? "project" : "subproject";
    const changes = params.changes as Record<string, unknown> | undefined;
    if (typeof params.id !== "string" || !changes || typeof changes !== "object")
      throw new Error("invalid_params");
    const allowed: readonly string[] = editable[kind];
    if (Object.keys(changes).some((key) => !allowed.includes(key)))
      throw new Error("field_not_editable");
    const parts: UserInput = Object.values(changes)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is string => typeof value === "string")
      .map((text) => ({ type: "text", text }));
    const check = await host.privacy.prepareInput(parts);
    const id = params.id,
      before = host.store.lastSeq();
    const receipt = host.store.dispatch(commandId, (state) => {
      check(state);
      const row = state[kind]?.find((entry) => entry.id === id);
      if (!row || row.archived) throw new Error("scope_unavailable");
      return handle(
        state,
        { type: "update", kind, id, changes },
        { commandId, at: new Date().toISOString(), actor: { kind: "human", id: "local-owner" } },
      );
    });
    host.publish(host.store.eventsSince(before));
    return receipt.result;
  };
}
