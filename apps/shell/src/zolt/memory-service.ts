// S5: the Memory page's daemon calls.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { MEMORY_TIDY_SETTING } from "@zoltbot/protocol";
import { IPC_CHANNELS } from "../shared/ipc";
import type {
  MemoryDecideInput,
  MemoryEntry,
  MemoryForgetInput,
  MemoryImportChoice,
  MemoryImportSource,
  MemoryImportStatus,
  MemorySaveInput,
  MemorySkillDecideInput,
  MemoryView,
} from "../shared/memory";
import type { DaemonClient } from "./daemon-client";
import { toMemoryEntry, toMemoryView, toSkillProposals } from "./memory-view";
import { isObject, requireString } from "./parsers";

type Row = Record<string, unknown>;

function parseSave(input: unknown): MemorySaveInput {
  if (!isObject(input)) throw new Error("Invalid memory entry.");
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Invalid memory revision.");
  const title = requireString(input.title, "title").trim();
  const body = typeof input.body === "string" ? input.body : "";
  if (!title) throw new Error("Give the entry a title.");
  if (body.length > 1200) throw new Error("Keep the entry under 1,200 characters.");
  return { id: requireString(input.id, "id"), title, body, revision };
}

function parseForget(input: unknown): MemoryForgetInput {
  if (!isObject(input)) throw new Error("Invalid memory entry.");
  const quote = requireString(input.quote, "quote").trim();
  const revision = Number(input.revision);
  if (!quote || quote.length > 1200) throw new Error("Pick the text to forget.");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Invalid memory revision.");
  return { id: requireString(input.id, "id"), quote, revision };
}

const IMPORT_SOURCES: readonly MemoryImportSource[] = ["chatgpt", "claude", "gemini"];
function parseSource(value: unknown): MemoryImportSource {
  if (!IMPORT_SOURCES.includes(value as MemoryImportSource)) throw new Error("Invalid source.");
  return value as MemoryImportSource;
}

/** The daemon's import errors carry a code and a sentence; the sentence is for the owner. */
function importError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  const sentence = /import_[a-z_]+: (.+)$/.exec(message)?.[1];
  return new Error(
    sentence
      ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
      : "Couldn’t read this export. Try again.",
  );
}

/** The Mac's file picker; loaded only in the app, so the service stays testable in Node. */
async function pickExport(): Promise<string | undefined> {
  const { BrowserWindow, dialog } = await import("electron");
  const options = {
    title: "Choose the export file",
    buttonLabel: "Choose",
    properties: ["openFile" as const],
    filters: [{ name: "Export", extensions: ["zip", "json"] }],
  };
  const window = BrowserWindow.getFocusedWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

function parseDecideSkill(input: unknown): MemorySkillDecideInput {
  if (!isObject(input) || (input.decision !== "save" && input.decision !== "discard"))
    throw new Error("Choose Save or Discard.");
  return { id: requireString(input.id, "id"), decision: input.decision };
}

/** The daemon's skill errors carry a code and a sentence; the sentence is for the owner. */
function skillError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  const sentence = /skill_[a-z_]+: ([A-Z].+)$/.exec(message)?.[1];
  if (sentence) return new Error(sentence);
  // The library re-checks the text when it saves; a retry won't change that outcome.
  if (/SKILL\.md:|possible secret|invalid relative path|skill: /.test(message))
    return new Error("This skill can’t be saved as written. Discard it.");
  return new Error("Couldn’t save this skill. Try again.");
}

function parseDecide(input: unknown): MemoryDecideInput {
  if (!isObject(input) || (input.decision !== "accept" && input.decision !== "reject"))
    throw new Error("Choose Keep or Discard.");
  return { id: requireString(input.id, "id"), decision: input.decision };
}

export function memoryService(
  client: DaemonClient,
  pick: () => Promise<string | undefined> = pickExport,
) {
  const entities = () => client.snapshot.entities as Record<string, Row[] | undefined>;
  return {
    /** Entries and proposals from the snapshot; M6 skill proposals from the daemon. */
    async list(): Promise<MemoryView> {
      const view = toMemoryView(client.snapshot as { entities: Record<string, Row[] | undefined> });
      // The page still lists memory when skill proposals can't be read.
      const result = (await client.call("skill.proposal.list", {}).catch(() => ({}))) as {
        proposals?: Row[];
      };
      return { ...view, skills: toSkillProposals(entities(), result.proposals ?? []) };
    },
    async decideSkill(input: MemorySkillDecideInput): Promise<void> {
      try {
        await client.call(
          "skill.proposal.decide",
          { id: input.id, decision: input.decision },
          randomUUID(),
        );
      } catch (error) {
        throw skillError(error);
      }
    },
    async revisions(id: string): Promise<MemoryEntry[]> {
      const rows = ((await client.call("knowledge.revisions", { id })) ?? []) as Row[];
      return rows
        .map((row) => toMemoryEntry(entities(), row))
        .sort((a, b) => b.revision - a.revision);
    },
    /** Saves new text; also how an older revision is restored. */
    async save(input: MemorySaveInput): Promise<void> {
      const current = (await client.call("knowledge.get", { id: input.id })) as Row;
      if (Number(current.revision) !== input.revision)
        throw new Error("This entry changed while you were editing. Your changes weren't saved.");
      await client.call(
        "knowledge.upsert",
        {
          value: { ...current, title: input.title, body: input.body },
          expectedRevision: input.revision,
        },
        randomUUID(),
      );
    },
    async archive(id: string, revision: number): Promise<void> {
      await client.call("knowledge.archive", { id, expectedRevision: revision }, randomUUID());
    },
    async forget(input: MemoryForgetInput): Promise<void> {
      try {
        await client.call(
          "knowledge.forget",
          { id: input.id, quote: input.quote, expectedRevision: input.revision },
          randomUUID(),
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code.includes("knowledge_revision_conflict"))
          throw new Error("This entry changed. Open it again and pick the text.");
        if (code.includes("knowledge_quote_not_found"))
          throw new Error("That text isn't in the entry anymore.");
        throw error;
      }
    },
    async setTidy(on: boolean): Promise<void> {
      try {
        await client.call("settings.set", { key: MEMORY_TIDY_SETTING, value: on }, randomUUID());
      } catch {
        throw new Error("Couldn’t change this setting. Try again.");
      }
    },
    async importChoose(source: MemoryImportSource): Promise<MemoryImportChoice | null> {
      const path = await pick();
      if (!path) return null;
      try {
        const counts = (await client.call("memory.import.preview", { source, path })) as {
          memories: number;
          conversations: number;
        };
        return { source, path, name: basename(path), ...counts };
      } catch (error) {
        throw importError(error);
      }
    },
    async importStart(source: MemoryImportSource, path: string): Promise<MemoryImportStatus> {
      try {
        return (await client.call(
          "memory.import.start",
          { source, path },
          randomUUID(),
        )) as MemoryImportStatus;
      } catch (error) {
        throw importError(error);
      }
    },
    async importStatus(id: string): Promise<MemoryImportStatus> {
      try {
        return (await client.call("memory.import.status", { id })) as MemoryImportStatus;
      } catch (error) {
        throw importError(error);
      }
    },
    async decide(input: MemoryDecideInput): Promise<void> {
      await client.call(
        "proposal.decide",
        { id: input.id, decision: input.decision },
        randomUUID(),
      );
    },
  };
}

export function memoryHandlers(client: DaemonClient): Record<string, (input: unknown) => unknown> {
  const service = memoryService(client);
  return {
    [IPC_CHANNELS.memoryList]: () => service.list(),
    [IPC_CHANNELS.memoryRevisions]: (id) => service.revisions(requireString(id, "id")),
    [IPC_CHANNELS.memorySave]: (input) => service.save(parseSave(input)),
    [IPC_CHANNELS.memoryArchive]: (input) => {
      if (!isObject(input)) throw new Error("Invalid memory entry.");
      return service.archive(requireString(input.id, "id"), Number(input.revision) || 0);
    },
    [IPC_CHANNELS.memoryDecide]: (input) => service.decide(parseDecide(input)),
    [IPC_CHANNELS.memoryDecideSkill]: (input) => service.decideSkill(parseDecideSkill(input)),
    [IPC_CHANNELS.memoryForget]: (input) => service.forget(parseForget(input)),
    [IPC_CHANNELS.memoryImportChoose]: (source) => service.importChoose(parseSource(source)),
    [IPC_CHANNELS.memoryImportStart]: (input) => {
      if (!isObject(input)) throw new Error("Invalid import.");
      return service.importStart(parseSource(input.source), requireString(input.path, "path"));
    },
    [IPC_CHANNELS.memoryImportStatus]: (id) => service.importStatus(requireString(id, "id")),
    [IPC_CHANNELS.memorySetTidy]: (input) => {
      if (typeof input !== "boolean") throw new Error("Invalid setting.");
      return service.setTidy(input);
    },
  };
}
