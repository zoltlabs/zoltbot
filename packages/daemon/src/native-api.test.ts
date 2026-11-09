import { expect, it } from "vitest";
import { nativeApi } from "./native-api.js";

const at = "2026-10-27T12:00:00.000Z";
const session = (provider: string, nativeId: string) => ({
  provider,
  nativeId,
  adopted: false,
  missing: false,
  lastSeenAt: at,
});
it("pages stable native metadata and rejects a cursor after the index changes", () => {
  let seq = 1;
  const api = nativeApi({
    snapshot: () => ({ nativeSession: [session("codex", "two"), session("claude", "one")] }),
    seq: () => seq,
  });
  const first = api("native.list", { limit: 1 }) as { items: unknown[]; cursor: string };
  expect(first.items).toEqual([session("claude", "one")]);
  expect(api("native.list", { limit: 1, cursor: first.cursor })).toEqual({
    items: [session("codex", "two")],
  });
  seq++;
  expect(() => api("native.list", { cursor: first.cursor })).toThrow("native_cursor_stale");
});
it("copies a quoted known resume command and rejects unavailable or unverified commands", () => {
  const id = "native'quote";
  const api = nativeApi({
    snapshot: () => ({ nativeSession: [session("claude", id), session("unknown", "one")] }),
    seq: () => 0,
  });
  expect(api("native.openCommand", { provider: "claude", nativeId: id })).toEqual({
    command: "'claude' '--resume' 'native'\\''quote'",
  });
  expect(() => api("native.openCommand", { provider: "codex", nativeId: "absent" })).toThrow(
    "native_session_not_found",
  );
  expect(() => api("native.openCommand", { provider: "unknown", nativeId: "one" })).toThrow(
    "resume_command_unverified",
  );
  expect(api("unrelated", {})).toBeUndefined();
});
