// S5: what agents remember, for the Memory page.

export interface MemoryWriter {
  kind: "human" | "agent" | "system";
  /** The agent's id when an agent wrote it. */
  id: string;
  /** The agent's name; empty for the owner and the app, which the page names itself. */
  name: string;
}

/** The agent an entry belongs to: the one that owns it, or else the one that wrote it. */
export interface MemoryAgent {
  id: string;
  name: string;
}

export interface MemoryEntry {
  id: string;
  title: string;
  body: string;
  kind: string;
  /** The project it belongs to; null for what applies everywhere. */
  projectId: string | null;
  projectName: string;
  writer: MemoryWriter;
  agent: MemoryAgent | null;
  verification: "human" | "unverified" | "confirmed";
  status: "active" | "stale" | "superseded" | "archived";
  revision: number;
  updatedAt: string;
}

export interface MemoryProposal {
  id: string;
  op: "create" | "revise" | "confirm";
  itemId: string | null;
  title: string;
  body: string;
  kind: string;
  projectId: string | null;
  projectName: string;
  writer: MemoryWriter;
  agent: MemoryAgent | null;
  /** The agent's one-line reason. */
  reason: string;
  createdAt: string;
}

export interface MemoryView {
  entries: MemoryEntry[];
  /** Agent proposals waiting for the owner. */
  proposals: MemoryProposal[];
}

export interface MemorySaveInput {
  id: string;
  title: string;
  body: string;
  /** The revision the edit started from, so a newer change isn't overwritten. */
  revision: number;
}

export interface MemoryDecideInput {
  id: string;
  decision: "accept" | "reject";
}

export const MEMORY_CHANNELS = {
  memoryList: "memory:list",
  memoryRevisions: "memory:revisions",
  memorySave: "memory:save",
  memoryArchive: "memory:archive",
  memoryDecide: "memory:decide",
} as const;

export interface MemoryDesktopApi {
  list: () => Promise<MemoryView>;
  /** Every revision of an entry, newest first. */
  revisions: (id: string) => Promise<MemoryEntry[]>;
  save: (input: MemorySaveInput) => Promise<void>;
  archive: (input: { id: string; revision: number }) => Promise<void>;
  /** Keeps or discards what an agent proposed to remember. */
  decide: (input: MemoryDecideInput) => Promise<void>;
}
