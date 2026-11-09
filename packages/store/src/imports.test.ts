import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { importOutcome } from "@zoltbot/core";
import { expect, it } from "vitest";
import { openStore } from "./index.js";

it("rolls back an interrupted import and commits exactly once on retry", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/import-store-"));
  const store = await openStore(path.join(root, "store.db"));
  try {
    const receipt = {
      id: "preview",
      items: [
        { id: "repo", kind: "project", source: "git", name: "Repository", path: "/work/repo" },
      ],
    };
    const context = {
      commandId: "import:preview",
      at: "2026-10-27T17:00:00.000Z",
      actor: { kind: "human" as const, id: "owner" },
    };
    const produce = (state: ReturnType<typeof store.snapshot>) =>
      importOutcome(state, receipt, context, true);
    expect(() => store.dispatch(context.commandId, produce, { killPoint: "after_events" })).toThrow(
      "kill point",
    );
    expect(store.lastSeq()).toBe(0);
    expect(store.snapshot()).toEqual({});
    const committed = store.dispatch(context.commandId, produce);
    expect(store.snapshot().project).toHaveLength(1);
    expect(store.snapshot().audit).toHaveLength(1);
    const seq = store.lastSeq();
    expect(
      store.dispatch(context.commandId, () => {
        throw new Error("must not rerun");
      }),
    ).toEqual(committed);
    expect(store.lastSeq()).toBe(seq);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
