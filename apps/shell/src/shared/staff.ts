/** Staff changes the shell shows and sends: approval cards and the owner's own edits. */

export type StaffKind = "add" | "change" | "archive";

export interface StaffFieldRow {
  label: string;
  before?: string;
  after?: string;
}

/** One approval card for adding, changing or archiving an employee. */
export interface StaffCard {
  kind: "staff";
  /** The approval request it answers. */
  requestId: string;
  action: StaffKind;
  state: "pending" | "approved" | "declined";
  title: string;
  /** The employee: the new one for an add. */
  name: string;
  projectId: string;
  /** The chat that asked, which the card belongs to. */
  botId: string;
  requestedBy: string;
  fields: StaffFieldRow[];
  /** Queued tasks an archive moves. */
  moves: { title: string; to: string }[];
  /** Running tasks and turns that finish before an archive takes effect. */
  running: number;
  /** Other chats a change to a shared profile also changes. */
  sharedWith: number;
  /** For an add: how many more the checkbox would let the manager add without asking. */
  allowance: number | null;
}

/** One person in a project, as the Organization panel lists them. */
export interface StaffPerson {
  botId: string;
  name: string;
  role: "ceo" | "manager" | "employee";
  teamId: string | null;
  teamName: string;
  model: string;
  roleText: string;
  instructions: string;
  /** Archive is waiting for running work to finish. */
  archiving: boolean;
  /** A pending approval for this person. */
  pending: StaffKind | null;
  /** A manager's standing allowance; null when it has none. */
  allowance: { max: number; used: number } | null;
}

export interface StaffOverview {
  /** Pending approvals, newest last. */
  approvals: StaffCard[];
  people: StaffPerson[];
}

export type StaffActionInput =
  | { action: "approve"; requestId: string; grantAllowance: boolean }
  | { action: "decline"; requestId: string }
  | {
      action: "change";
      threadId: string;
      name?: string;
      role?: string;
      model?: string;
      instructions?: string;
    }
  | { action: "archive"; threadId: string; moveTo?: string }
  | { action: "allowance"; threadId: string; max: number };
