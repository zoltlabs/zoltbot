import { expect, test } from "@playwright/test";
import { MEMORY_TIDY_SETTING, parseEvent } from "@zoltbot/protocol";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** M3: a nightly merge waits in Needs review; Merge folds two entries into one. */
const at = "2026-11-04T00:00:00.000Z";
const later = "2026-11-10T00:00:00.000Z";
const owner = { kind: "human" as const, id: "local-owner" };
const scope = { type: "user" as const, id: "local" };

test("Merge folds two repeated entries into one, and the nightly search can be turned off", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const entry = (id: string, body: string, updatedAt: string) => ({
    id,
    scope,
    kind: "lesson",
    title: "Builds",
    body,
    tags: [],
    sources: [],
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt,
    owner,
    verification: "human",
    writer: owner,
  });
  const merge = {
    id: "proposal-tidy",
    state: "pending",
    op: "revise",
    itemId: "fresh",
    expectedRevision: 1,
    scope,
    kind: "lesson",
    title: "Builds",
    body: "Every branch build and CI run reuses the turbo cache.",
    tags: [],
    evidence: [],
    reason: "These entries overlap.",
    merges: { id: "old", revision: 1 },
    why: "tidy_merge",
    writer: { kind: "system", id: "memory-tidy" },
    sessionId: "memory-tidy",
    fingerprint: "tidy-fingerprint",
    conflicts: ["old"],
    createdAt: later,
    updatedAt: later,
  };
  const event = (index: number, aggregateType: string, payload: { id: string }) =>
    parseEvent({
      eventId: `seed-tidy:${index}`,
      aggregateType,
      aggregateId: payload.id,
      type: `${aggregateType}.created`,
      occurredAt: at,
      payload,
    });
  fixture.daemon.store.dispatch("seed-tidy", () => ({
    result: {},
    events: [
      event(0, "knowledge", entry("old", "Builds reuse the turbo cache in CI.", at)),
      event(1, "knowledge", entry("fresh", "Every branch build reuses the turbo cache.", later)),
      event(2, "knowledgeProposal", merge),
    ],
  }));
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Memory/ }).click();
    const memory = page.getByRole("main", { name: "Memory" });
    await memory.getByRole("button", { name: /^Needs review/ }).click();

    const row = memory.locator('[data-proposal-id="proposal-tidy"]');
    await expect(row).toContainText("Repeat");
    const replaced = row.getByRole("list", { name: "Replaces" });
    await expect(replaced.getByRole("listitem")).toHaveText([
      "Every branch build reuses the turbo cache.",
      "Builds reuse the turbo cache in CI.",
    ]);
    expect(await axeViolations(page)).toEqual([]);

    await row.getByRole("button", { name: "Merge", exact: true }).click();
    await expect
      .poll(() => fixture.daemon.store.record("knowledge", "fresh")?.body)
      .toBe(merge.body);
    expect(fixture.daemon.store.record("knowledge", "old")?.status).toBe("archived");
    await expect(memory.getByText("Merged into Builds.")).toBeAttached();

    const tidy = memory.getByRole("checkbox", { name: "Find repeated entries each night" });
    await expect(tidy).toBeChecked();
    await tidy.click();
    await expect
      .poll(() => fixture.daemon.store.record("settings", MEMORY_TIDY_SETTING)?.value)
      .toBe(false);
    await expect(tidy).not.toBeChecked();
  } finally {
    await shell.close();
    await fixture.close();
  }
});
