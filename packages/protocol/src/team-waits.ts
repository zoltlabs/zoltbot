import { type Static, Type } from "@sinclair/typebox";
import { At, Id, object, values } from "./common.js";

/** The settings key that holds a chat's team wait. A chat has at most one. */
export const teamWaitKey = (threadId: string) => `team.wait.${threadId}`;
/**
 * A chat waiting for work it delegated: tasks it is accountable for and turns in chats it
 * manages. The daemon wakes the chat when every target finishes, at the fallback time, or when
 * the owner wakes it. It grants nothing and needs no approval, because it only covers the
 * chat's own assignments; any other wait goes through a Wake when card.
 */
export const TeamWaitSchema = object({
  id: Id,
  threadId: Id,
  taskIds: Type.Array(Id, { maxItems: 20 }),
  chatIds: Type.Array(Id, { maxItems: 20 }),
  note: Type.Optional(Type.String({ maxLength: 1000 })),
  status: values(["waiting", "woken", "cancelled"]),
  reason: Type.Optional(values(["finished", "fallback", "owner", "replaced"])),
  revision: Type.Integer({ minimum: 1 }),
  fallbackAt: At,
  createdAt: At,
  updatedAt: At,
});
export type TeamWait = Static<typeof TeamWaitSchema>;
