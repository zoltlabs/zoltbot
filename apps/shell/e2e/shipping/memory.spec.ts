import { expect, test } from "@playwright/test";
import { parseEvent } from "@zoltbot/protocol";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

/** S5: the Memory page edits an entry, reverts it, and keeps or discards what agents proposed. */
const at = "2026-11-04T00:00:00.000Z";
const agent = { kind: "agent" as const, id: "profile" };
const owner = { kind: "human" as const, id: "local-owner" };
const scope = { type: "user" as const, id: "local" };

function proposal(id: string, title: string) {
  return {
    id,
    state: "pending",
    op: "create",
    scope,
    kind: "lesson",
    title,
    body: `${title} body.`,
    tags: [],
    evidence: [],
    reason: "Seen twice this week",
    why: "scope_denied",
    writer: agent,
    sessionId: "session",
    fingerprint: `fingerprint-${id}`,
    conflicts: [],
    createdAt: at,
    updatedAt: at,
  };
}

test("memory entries edit and revert, and proposals are kept or discarded", async ({ page }) => {
  const fixture = await compareFixture();
  const item = {
    id: "units",
    scope,
    kind: "decision",
    title: "Units",
    body: "Use grams.",
    tags: [],
    sources: [],
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    owner,
    verification: "unverified",
    writer: agent,
  };
  const event = (index: number, aggregateType: string, payload: { id: string }) =>
    parseEvent({
      eventId: `seed-memory:${index}`,
      aggregateType,
      aggregateId: payload.id,
      type: `${aggregateType}.created`,
      occurredAt: at,
      payload,
    });
  fixture.daemon.store.dispatch("seed-memory", () => ({
    result: {},
    events: [
      event(0, "knowledge", item),
      event(1, "knowledgeProposal", proposal("keep-me", "Tests run with pnpm")),
      event(2, "knowledgeProposal", proposal("drop-me", "Deploys on Fridays")),
    ],
  }));
  const shell = await shellSession(fixture.daemon);
  try {
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: /^Memory/ }).click();
    const memory = page.getByRole("main", { name: "Memory" });
    await expect(memory.getByRole("heading", { name: "Memory", level: 1 })).toBeFocused();

    // Edit: open the entry, change its text and save.
    const entry = memory.getByRole("button", { name: /^Units/ });
    await entry.click();
    await expect(entry).toHaveAttribute("aria-expanded", "true");
    await memory.getByRole("button", { name: "Edit", exact: true }).click();
    await memory.getByRole("textbox", { name: "Text" }).fill("Use kilograms.");
    expect(await axeViolations(page)).toEqual([]);
    await memory.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => fixture.daemon.store.record("knowledge", "units")?.revision).toBe(2);
    await expect(memory.getByText("Use kilograms.").first()).toBeVisible();

    // Revert: the history lists both revisions; going back to the first restores its text.
    await expect(memory.getByText(/^Revision 1 ·/)).toBeVisible();
    await memory.getByRole("button", { name: "Revert to this" }).click();
    await expect
      .poll(() => fixture.daemon.store.record("knowledge", "units")?.body)
      .toBe("Use grams.");
    await expect(memory.getByText(/^Revision 3 ·/)).toBeVisible();

    // Review: Keep turns a proposal into an entry; Discard drops it.
    await memory.getByRole("button", { name: /^Needs review/ }).click();
    await expect(memory.getByText("Tests run with pnpm", { exact: true })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await memory
      .getByRole("listitem")
      .filter({ hasText: "Deploys on Fridays" })
      .getByRole("button", { name: "Discard" })
      .click();
    // The row goes away; focus moves to the next proposal rather than the page.
    await expect(
      memory
        .getByRole("listitem")
        .filter({ hasText: "Tests run with pnpm" })
        .getByRole("button", { name: "Keep" }),
    ).toBeFocused();
    await memory
      .getByRole("listitem")
      .filter({ hasText: "Tests run with pnpm" })
      .getByRole("button", { name: "Keep" })
      .click();
    await expect
      .poll(() => fixture.daemon.store.record("knowledgeProposal", "keep-me")?.state)
      .toBe("accepted");
    await expect
      .poll(() => fixture.daemon.store.record("knowledgeProposal", "drop-me")?.state)
      .toBe("rejected");
    await expect(memory.getByText("Nothing to review.")).toBeVisible();
    await expect(memory.getByRole("heading", { name: "Memory", level: 1 })).toBeFocused();
    await memory.getByRole("button", { name: "All", exact: true }).click();
    await expect(memory.getByRole("button", { name: /^Tests run with pnpm/ })).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
