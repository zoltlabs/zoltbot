import { expect, test } from "@playwright/test";
import { parseEvent } from "@zoltbot/protocol";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** M2: an entry shows when it was learned and until when, and Forget takes out one passage. */
const at = "2026-11-04T00:00:00.000Z";
const owner = { kind: "human" as const, id: "local-owner" };
const agent = { kind: "agent" as const, id: "profile" };
const scope = { type: "user" as const, id: "local" };

test("Forget removes the selected sentence and an agent's forget waits for the owner", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const item = {
    id: "leave",
    scope,
    kind: "lesson",
    title: "Team leave",
    body: "Sam is on leave until 3 Dec. Builds reuse the turbo cache.",
    tags: [],
    sources: [],
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    validUntil: "2026-12-31T00:00:00.000Z",
    owner,
    verification: "human",
    writer: owner,
  };
  const request = {
    id: "forget-units",
    state: "pending",
    op: "revise",
    itemId: "units",
    expectedRevision: 1,
    scope,
    kind: "decision",
    title: "Units",
    body: "Use grams.",
    forget: "Weigh flour twice.",
    tags: [],
    evidence: [],
    reason: "The user asked me to forget it",
    why: "forget_request",
    writer: agent,
    sessionId: "session",
    fingerprint: "fingerprint-forget",
    conflicts: [],
    createdAt: at,
    updatedAt: at,
  };
  const units = {
    ...item,
    id: "units",
    kind: "decision",
    title: "Units",
    body: "Use grams. Weigh flour twice.",
  };
  const event = (index: number, aggregateType: string, payload: { id: string }) =>
    parseEvent({
      eventId: `seed-forget:${index}`,
      aggregateType,
      aggregateId: payload.id,
      type: `${aggregateType}.created`,
      occurredAt: at,
      payload,
    });
  fixture.daemon.store.dispatch("seed-forget", () => ({
    result: {},
    events: [
      event(0, "knowledge", item),
      event(1, "knowledge", units),
      event(2, "knowledgeProposal", request),
    ],
  }));
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Memory/ }).click();
    const memory = page.getByRole("main", { name: "Memory" });

    await memory.getByRole("button", { name: /^Team leave/ }).click();
    await expect(memory.getByText(/^Learned .+ · Until .+/)).toBeVisible();

    // Select the first sentence in the entry, then Forget.
    await page.evaluate(() => {
      const body = document.querySelector('[data-entry-id="leave"] .memory-body');
      const text = body?.firstChild;
      if (!text) throw new Error("no body");
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, "Sam is on leave until 3 Dec.".length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await memory.getByRole("button", { name: "Forget selection", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Forget this?" });
    await expect(dialog).toContainText("Sam is on leave until 3 Dec.");
    expect(await axeViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Forget", exact: true }).click();
    await expect
      .poll(() => fixture.daemon.store.record("knowledge", "leave")?.body)
      .toBe("Builds reuse the turbo cache.");
    await expect(memory.getByText(/^Revision 2 ·/)).toBeVisible();

    // The agent's request shows the exact text; Forget applies it.
    await memory.getByRole("button", { name: /^Needs review/ }).click();
    const row = memory.locator('[data-proposal-id="forget-units"]');
    await expect(row).toContainText("Weigh flour twice.");
    expect(await axeViolations(page)).toEqual([]);
    await row.getByRole("button", { name: "Forget", exact: true }).click();
    await expect
      .poll(() => fixture.daemon.store.record("knowledge", "units")?.body)
      .toBe("Use grams.");
  } finally {
    await shell.close();
    await fixture.close();
  }
});
