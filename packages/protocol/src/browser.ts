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
};
export const browserMacOnlyMethods = ["browser.setup", "browser.action"] as const;

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
}
