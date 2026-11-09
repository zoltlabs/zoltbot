import { type Static, Type } from "@sinclair/typebox";
import { Id, object, Text, values } from "./common.js";

export const TerminalInfoSchema = object({
  id: Id,
  threadId: Id,
  sessionId: Id,
  cwd: Text,
  status: values(["running", "stopping", "exited"]),
  cols: Type.Integer(),
  rows: Type.Integer(),
  exitCode: Type.Optional(Type.Integer()),
  signal: Type.Optional(Type.Integer()),
});
export type TerminalInfo = Static<typeof TerminalInfoSchema>;
export const TerminalOutputSchema = object({
  terminal: TerminalInfoSchema,
  data: Text,
  offset: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
  caughtUp: Type.Boolean(),
});
export type TerminalOutput = Static<typeof TerminalOutputSchema>;
const scope = { threadId: Id, id: Id };
const grid = {
  cols: Type.Integer({ minimum: 2, maximum: 500 }),
  rows: Type.Integer({ minimum: 1, maximum: 200 }),
};
const ok = object({ ok: Type.Boolean() });
export const terminalMethods = {
  "terminal.create": {
    params: object({ threadId: Id, confirmed: Type.Literal(true), ...grid }),
    result: TerminalInfoSchema,
  },
  "terminal.list": {
    /** readOnly lists every terminal in the chat, including other devices' (view only). */
    params: object({ threadId: Id, readOnly: Type.Optional(Type.Boolean()) }),
    result: object({ items: Type.Array(TerminalInfoSchema) }),
  },
  /** readOnly attaches to a terminal another device owns; its owner alone can type in it. */
  "terminal.attach": {
    params: object({ ...scope, readOnly: Type.Optional(Type.Boolean()) }),
    result: object({ attachmentId: Id }),
  },
  "terminal.read": {
    params: object({ ...scope, attachmentId: Id, offset: Type.Integer({ minimum: 0 }) }),
    result: TerminalOutputSchema,
  },
  "terminal.detach": { params: object({ ...scope, attachmentId: Id }), result: ok },
  "terminal.input": {
    params: object({ ...scope, data: Type.String({ minLength: 1, maxLength: 16384 }) }),
    result: ok,
  },
  "terminal.resize": { params: object({ ...scope, ...grid }), result: ok },
  "terminal.close": { params: object(scope), result: ok },
};
