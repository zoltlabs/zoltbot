// S5: the Memory page's daemon calls.
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS } from "../shared/ipc";
import type { MemoryDecideInput, MemoryEntry, MemorySaveInput } from "../shared/memory";
import type { DaemonClient } from "./daemon-client";
import { toMemoryEntry, toMemoryView } from "./memory-view";
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

function parseDecide(input: unknown): MemoryDecideInput {
  if (!isObject(input) || (input.decision !== "accept" && input.decision !== "reject"))
    throw new Error("Choose Keep or Discard.");
  return { id: requireString(input.id, "id"), decision: input.decision };
}

export function memoryService(client: DaemonClient) {
  const entities = () => client.snapshot.entities as Record<string, Row[] | undefined>;
  return {
    list: () => toMemoryView(client.snapshot as { entities: Record<string, Row[] | undefined> }),
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
  };
}
