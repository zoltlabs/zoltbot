import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { MacExecJournal, type MacRequestScope } from "./mac-exec-journal.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const scope = (): MacRequestScope => ({
  orgId: "org",
  userId: "member",
  taskId: "task",
  requestId: "request",
});
const signature = () => randomBytes(64).toString("base64url");
const binding = "a".repeat(64);
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mac-journal-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const open = () => {
    const journal = MacExecJournal.open(directory);
    cleanup.push(() => journal.close());
    return journal;
  };
  return { directory, open };
}
const result = () => ({
  requestId: "request",
  taskId: "task",
  exitCode: 0,
  stdout: "Darwin\n",
  stderr: "",
  truncated: false,
  durationMs: 1,
  mac: "Test Mac",
});
it("claims once before execution and returns a completed result after reconnect and restart", () => {
  const f = fixture(),
    journal = f.open(),
    signed = signature();
  expect(journal.begin(scope(), binding, signed).state).toBe("new");
  expect(journal.begin(scope(), binding, signed).state).toBe("executing");
  journal.complete(scope(), binding, result());
  expect(journal.begin(scope(), binding, signed)).toEqual({ state: "completed", result: result() });
  journal.close();
  expect(f.open().begin(scope(), binding, signed)).toEqual({
    state: "completed",
    result: result(),
  });
  expect(statSync(path.join(f.directory, "mac-exec.db")).mode & 0o777).toBe(0o600);
  expect(statSync(f.directory).mode & 0o777).toBe(0o700);
});
it("keeps an unfinished command uncertain after reopening instead of permitting another execution", () => {
  const f = fixture(),
    journal = f.open(),
    signed = signature();
  expect(journal.begin(scope(), binding, signed).state).toBe("new");
  journal.close();
  const recovered = f.open();
  expect(recovered.begin(scope(), binding, signed).state).toBe("uncertain");
  expect(() => recovered.complete(scope(), binding, result())).toThrow("mac_request_conflict");
  expect(() => recovered.begin(scope(), "b".repeat(64), signature())).toThrow(
    "mac_request_conflict",
  );
});
it("refuses reuse of a consumed approval for a second request or organization", () => {
  const journal = fixture().open(),
    signed = signature();
  journal.begin(scope(), binding, signed);
  for (const other of [
    { ...scope(), requestId: "other" },
    { ...scope(), orgId: "other" },
  ])
    expect(() => journal.begin(other, binding, signed)).toThrow("mac_approval_replayed");
  expect(journal.begin({ ...scope(), requestId: "other" }, binding, signature()).state).toBe("new");
});
it("refuses a second journal owner, symlinks, malformed claims and cross-request results", () => {
  const f = fixture(),
    journal = f.open();
  expect(() => MacExecJournal.open(f.directory)).toThrow("mac_journal_unavailable");
  expect(() => journal.begin({} as MacRequestScope, binding, signature())).toThrow(
    "mac_request_invalid",
  );
  journal.begin(scope(), binding, signature());
  expect(() => journal.complete(scope(), binding, { ...result(), taskId: "other" })).toThrow(
    "mac_result_unavailable",
  );
  journal.close();
  expect(() => journal.begin(scope(), binding, signature())).toThrow("mac_journal_closed");
  const link = path.join(f.directory, "alias");
  symlinkSync(f.directory, link);
  expect(() => MacExecJournal.open(link)).toThrow("mac_journal_unavailable");
});
