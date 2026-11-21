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
  /** When it was first learned. */
  createdAt: string;
  updatedAt: string;
  /** M2: the fact stops being used after this time; null when it has no end. */
  validUntil: string | null;
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
  /** M2: the exact text an agent asked to forget; null for other proposals. */
  forget: string | null;
  /** M3: a nightly merge of two entries; the text of each before the merge. Null otherwise. */
  merges: { keep: string; drop: string } | null;
  createdAt: string;
}

export interface MemoryView {
  entries: MemoryEntry[];
  /** Agent proposals waiting for the owner. */
  proposals: MemoryProposal[];
  /** M3: whether the nightly tidy-up looks for entries that repeat each other. */
  tidy: boolean;
}

export interface MemorySaveInput {
  id: string;
  title: string;
  body: string;
  /** The revision the edit started from, so a newer change isn't overwritten. */
  revision: number;
}

export interface MemoryForgetInput {
  id: string;
  /** The exact text to take out of the entry. */
  quote: string;
  revision: number;
}

export interface MemoryDecideInput {
  id: string;
  decision: "accept" | "reject";
}

/** M4: where an imported export came from. */
export type MemoryImportSource = "chatgpt" | "claude" | "gemini";

/** M4: the export the owner picked, before anything is imported. */
export interface MemoryImportChoice {
  source: MemoryImportSource;
  path: string;
  /** The file name, shown in the preview. */
  name: string;
  memories: number;
  conversations: number;
}

export interface MemoryImportStatus {
  id: string;
  state: "reading" | "done" | "failed";
  conversations: number;
  read: number;
  proposed: number;
  error?: string;
}

export const MEMORY_CHANNELS = {
  memoryList: "memory:list",
  memoryRevisions: "memory:revisions",
  memorySave: "memory:save",
  memoryArchive: "memory:archive",
  memoryDecide: "memory:decide",
  memoryForget: "memory:forget",
  memorySetTidy: "memory:set-tidy",
  memoryImportChoose: "memory:import-choose",
  memoryImportStart: "memory:import-start",
  memoryImportStatus: "memory:import-status",
} as const;

export interface MemoryDesktopApi {
  list: () => Promise<MemoryView>;
  /** Every revision of an entry, newest first. */
  revisions: (id: string) => Promise<MemoryEntry[]>;
  save: (input: MemorySaveInput) => Promise<void>;
  archive: (input: { id: string; revision: number }) => Promise<void>;
  /** Keeps or discards what an agent proposed to remember. */
  decide: (input: MemoryDecideInput) => Promise<void>;
  /** M2: removes one passage from an entry as a new revision. */
  forget: (input: MemoryForgetInput) => Promise<void>;
  /** M3: turns the nightly tidy-up on or off. */
  setTidy: (on: boolean) => Promise<void>;
  /** M4: asks for an export file and reads what it holds; null when the owner cancels. */
  importChoose: (source: MemoryImportSource) => Promise<MemoryImportChoice | null>;
  importStart: (choice: {
    source: MemoryImportSource;
    path: string;
  }) => Promise<MemoryImportStatus>;
  importStatus: (id: string) => Promise<MemoryImportStatus>;
}
