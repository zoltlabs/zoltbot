import { Type } from "@sinclair/typebox";
import { Id, object } from "./common.js";

/** Zolt, the main agent above every workspace. */
export const chiefMethods = {
  /**
   * Start a fresh chat for Zolt. Zolt first writes a handoff in its current chat (handingOff:
   * threadId is that chat); the daemon then switches chief.thread. Zolt keeps its notes.
   */
  "chief.clear": {
    params: object({}),
    result: object({
      threadId: Id,
      previousThreadId: Type.Optional(Id),
      handingOff: Type.Optional(Type.Boolean()),
      handedOff: Type.Optional(Type.Boolean()),
    }),
  },
};
