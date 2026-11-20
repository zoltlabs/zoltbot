import { expect, it } from "vitest";
import { withHidden } from "./hidden";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";

const snapshot = (value: unknown) =>
  ({ entities: { settings: [{ key: "chat.hidden.chat", value }] } }) as unknown as Snapshot;
const row = (id: string) => ({ id, kind: "message", text: id }) as TranscriptRow;

it("marks the chat's hidden rows", () => {
  const out = withHidden(snapshot(["b"]), "chat", [row("a"), row("b")]);
  expect(out.map((r) => r.hidden ?? false)).toEqual([false, true]);
  expect(withHidden(snapshot(["b"]), "other", [row("b")])[0]?.hidden).toBeUndefined();
});
