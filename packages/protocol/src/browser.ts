import { Type } from "@sinclair/typebox";
import { Id, Json, object, Text, values } from "./common.js";
export const BrowserSelectionSchema = object({
  mode: values(["visible", "background"]),
  url: Type.Optional(Type.String({ maxLength: 2000 })),
});
export const browserMethods = {
  "browser.readiness": { params: object({}), result: Json },
  "browser.setup": { params: object({ confirmed: Type.Boolean() }), result: Json },
  "browser.task": { params: object({ id: Id }), result: Json },
  "browser.action": {
    params: object({
      id: Id,
      action: values(["open", "stop", "reopen_visible"]),
      confirmed: Type.Boolean(),
      url: Type.Optional(Text),
    }),
    result: Json,
  },
  /**
   * B2: opens, renews (every few seconds) or closes this connection's view of a chat's browser.
   * P8: a paired phone may watch, take over and send input too.
   */
  "browser.view": { params: object({ threadId: Id, open: Type.Boolean() }), result: Json },
  /** B3: the owner takes control of a chat's browser (`control: true`) or hands it back. */
  "browser.takeover": {
    params: object({ threadId: Id, control: Type.Boolean() }),
    result: Json,
  },
  /** B3: one mouse or key event from the owner while in control. Never logged. */
  "browser.input": { params: object({ threadId: Id, event: Json }), result: Json },
  /** M7: the owner starts teaching a task in the chat's browser, finishes (`done`) or cancels. */
  "browser.teach": {
    params: object({
      threadId: Id,
      action: Type.Union(["start", "done", "cancel"].map((v) => Type.Literal(v))),
    }),
    result: Json,
  },
  /** B6: lets the agent pay on one site without asking (`allow: true`), or asks again. */
  "browser.purchase.allow": {
    params: object({ site: Type.String({ minLength: 1, maxLength: 253 }), allow: Type.Boolean() }),
    result: Json,
  },
  /** B5: accept (`accept: true`) or reject cookie banners on one site from now on. */
  "browser.cookies": {
    params: object({ site: Type.String({ minLength: 1, maxLength: 253 }), accept: Type.Boolean() }),
    result: Json,
  },
  /** B1: the agent's kept browser profile, or null. */
  "browser.profile.get": { params: object({ agentId: Id }), result: Json },
  /** B1: signs the agent out of every site by deleting its profile folder. */
  "browser.profile.clear": {
    params: object({ agentId: Id, confirmed: Type.Boolean() }),
    result: Json,
  },
};
export const browserMacOnlyMethods = [
  "browser.setup",
  "browser.action",
  "browser.profile.clear",
  "browser.cookies",
  "browser.purchase.allow",
  "browser.teach",
] as const;

/** B1: a profile an agent keeps between browser launches, in the daemon's data folder. */
export interface BrowserProfile {
  id: string;
  agentId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface BrowserSelection {
  mode: "visible" | "background";
  url?: string;
}
export interface BrowserBinding extends BrowserSelection {
  version: 1;
  id: string;
  session: string;
  runtimeVersion: string;
  launcher: string;
  artifactRoot: string;
  cwd: string;
  home: string;
  browsers: string;
  guidanceText: string;
  guidanceHash: string;
  /** B1: the agent's kept profile folder; the launcher falls back to isolated when it is gone. */
  profile?: { id: string; dir: string };
  /** B2: the daemon runs this browser; the launcher attaches to it. */
  hosted?: true;
}
