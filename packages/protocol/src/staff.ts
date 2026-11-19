import { type Static, Type } from "@sinclair/typebox";
import { At, Id, Json, object, values } from "./common.js";

/**
 * Staff changes: adding, changing and archiving one employee. An employee is a chat in a project
 * with its own profile, usually in a team below a manager. Agents ask through `company_work`
 * action `staff` and the owner approves each request, unless the manager holds a standing
 * allowance that covers an add. The owner applies the same requests directly with `staff.apply`.
 */
const Name = Type.String({ minLength: 1, maxLength: 150 });
const Model = Type.String({ minLength: 1, maxLength: 100 });
const Folder = Type.String({ minLength: 1, maxLength: 300 });
const Folders = Type.Array(Folder, { maxItems: 20 });
const Instructions = Type.String({ maxLength: 4000 });
const Role = Type.String({ maxLength: 300 });

export const StaffRequestSchema = Type.Union([
  object({
    kind: Type.Literal("add"),
    name: Name,
    role: Role,
    /** A team at or below the requesting manager's team. Defaults to the manager's own team. */
    teamId: Type.Optional(Id),
    /** The profile to copy the provider from. Defaults to the requesting manager's profile. */
    profileId: Type.Optional(Id),
    model: Type.Optional(Model),
    instructions: Type.Optional(Instructions),
    /** Folders the employee may edit, relative to the project. Empty means no folder limit. */
    folders: Type.Optional(Folders),
    firstTask: Type.Optional(
      object({
        title: Name,
        brief: Type.String({ minLength: 1, maxLength: 2000 }),
      }),
    ),
  }),
  object({
    kind: Type.Literal("change"),
    threadId: Id,
    name: Type.Optional(Name),
    role: Type.Optional(Role),
    model: Type.Optional(Model),
    instructions: Type.Optional(Instructions),
  }),
  object({
    kind: Type.Literal("archive"),
    threadId: Id,
    /** The teammate that takes the queued tasks. Defaults to the manager above the employee. */
    moveTo: Type.Optional(Id),
  }),
]);
export type StaffRequest = Static<typeof StaffRequestSchema>;

/** The settings key of a manager's standing allowance. A manager has at most one. */
export const staffAllowanceKey = (threadId: string) => `staff.allowance.${threadId}`;
export const STAFF_ALLOWANCE_PREFIX = "staff.allowance.";
export const STAFF_ALLOWANCE_MAX = 20;
/**
 * A manager may add up to `max` employees without asking, each using one of `models` (empty:
 * any model of the manager's provider) and editing only within `folders` (empty: no folder
 * limit). It never covers wider permissions, changes or archiving. Off unless the owner grants it.
 */
export const StaffAllowanceSchema = object({
  threadId: Id,
  projectId: Id,
  max: Type.Integer({ minimum: 0, maximum: STAFF_ALLOWANCE_MAX }),
  used: Type.Integer({ minimum: 0 }),
  models: Type.Array(Model, { maxItems: 10 }),
  folders: Folders,
  /** The approval that granted it, when the owner ticked the box on a card. */
  interactionId: Type.Optional(Id),
  revision: Type.Integer({ minimum: 1 }),
  grantedAt: At,
  updatedAt: At,
});
export type StaffAllowance = Static<typeof StaffAllowanceSchema>;

/** One before-and-after row of a staff change, as the approval card shows it. */
export const StaffFieldSchema = object({
  label: Type.String({ maxLength: 40 }),
  before: Type.Optional(Type.String({ maxLength: 4000 })),
  after: Type.Optional(Type.String({ maxLength: 4000 })),
});
export type StaffField = Static<typeof StaffFieldSchema>;
/** What a staff request will do, computed from current state. The card renders it as is. */
export const StaffPreviewSchema = object({
  kind: values(["add", "change", "archive"]),
  projectId: Id,
  /** The employee's name: the new one for an add, the current one otherwise. */
  name: Name,
  threadId: Type.Optional(Id),
  teamName: Type.String({ maxLength: 150 }),
  requestedBy: Type.Optional(object({ threadId: Id, name: Name })),
  fields: Type.Array(StaffFieldSchema, { maxItems: 12 }),
  /** Queued tasks an archive moves, and to whom. */
  moves: Type.Optional(Type.Array(object({ taskId: Id, title: Name, to: Name }), { maxItems: 50 })),
  /** Running tasks and turns that finish before an archive takes effect. */
  running: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Other chats whose profile a change also edits. */
  sharedWith: Type.Optional(Type.Integer({ minimum: 0 })),
  /** For an add: the allowance the card's checkbox grants. */
  allowanceOffer: Type.Optional(
    object({
      max: Type.Integer({ minimum: 1, maximum: STAFF_ALLOWANCE_MAX }),
      models: Type.Array(Model, { maxItems: 10 }),
      folders: Folders,
    }),
  ),
});
export type StaffPreview = Static<typeof StaffPreviewSchema>;
/** Item and option ids of a staff approval. Ticking the option grants `allowanceOffer`. */
export const STAFF_APPROVAL_ITEM = "change";
export const STAFF_ALLOWANCE_OPTION = "allowance";

export const staffMethods = {
  /** The owner adds, changes or archives an employee directly. Agents cannot call it. */
  "staff.apply": { params: object({ request: StaffRequestSchema }), result: Json },
  /** The owner sets a manager's standing allowance. `max` 0 turns it off. */
  "staff.allowance": {
    params: object({
      threadId: Id,
      max: Type.Integer({ minimum: 0, maximum: STAFF_ALLOWANCE_MAX }),
      models: Type.Optional(Type.Array(Model, { maxItems: 10 })),
      folders: Type.Optional(Folders),
    }),
    result: Json,
  },
};
