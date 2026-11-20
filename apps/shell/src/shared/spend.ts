// S6: what the Usage page reads and writes over IPC.

/** One usage record, tied to the chat or agent that ran it. */
export interface SpendRow {
  at: string;
  botId: string;
  botName: string;
  projectId: string | null;
  projectName: string;
  model: string;
  costUsd: number;
  /** False when the provider reported no price for this run. */
  costKnown: boolean;
  tokens: number;
}

export interface SpendBudget {
  projectId: string;
  usd?: number;
  tokens?: number;
}

export interface SpendView {
  rows: SpendRow[];
  budgets: SpendBudget[];
  projects: { id: string; name: string }[];
}

export interface SpendBudgetInput {
  projectId: string;
  usd: number;
}

export const SPEND_CHANNELS = {
  spendList: "spend:list",
  spendSetBudget: "spend:set-budget",
} as const;

export interface SpendDesktopApi {
  /** Usage records from `from` (an ISO date) to now. */
  list: (input: { from: string }) => Promise<SpendView>;
  setBudget: (input: SpendBudgetInput) => Promise<void>;
}
