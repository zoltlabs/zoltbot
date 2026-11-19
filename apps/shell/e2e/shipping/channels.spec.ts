import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

type Fixture = Awaited<ReturnType<typeof compareFixture>>;
type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

/** Writes synthetic rows straight into the fixture daemon's store. */
function seed(fixture: Fixture, rows: [kind: string, id: string, row: Row][]) {
  const store = fixture.daemon.store;
  for (const [kind, id, row] of rows) {
    const commandId = `seed:${kind}:${id}`;
    store.dispatch(commandId, () => ({
      events: [
        {
          eventId: `${commandId}:0`,
          commandId,
          aggregateType: kind,
          aggregateId: id,
          type: `${kind}.created`,
          occurredAt: now(),
          payload: row,
        },
      ],
      result: {},
    }));
  }
}

const chat = (id: string, title: string, kind: "manager" | "side"): [string, string, Row] => [
  "thread",
  id,
  {
    id,
    agentId: "profile",
    projectId: "acme",
    node: { type: "subproject", id: "pay" },
    kind,
    title,
    titleSource: "human",
    pinned: false,
    archived: false,
    createdAt: now(),
    lastActivityAt: now(),
  },
];

/**
 * A Payments team gets its own channel led by its manager. The lead's question to Theo shows
 * who owes a reply; the owner's post with an @mention reaches Mira and starts a request, which
 * the owner then stops.
 */
test("team channels route posts, show requests and who owes a reply", async ({ page }) => {
  const fixture = await compareFixture();
  // The team's chats exist before the shell connects, as they would after a restart.
  seed(fixture, [
    [
      "project",
      "acme",
      {
        id: "acme",
        name: "Acme",
        goal: "",
        instructions: "",
        constraints: "",
        roots: [],
        hierarchyDepth: 2,
        tags: [],
        requireCodeReview: false,
        skipFinalGateWhenReviewed: false,
        archived: false,
        createdAt: now(),
      },
    ],
    [
      "subproject",
      "pay",
      {
        id: "pay",
        projectId: "acme",
        name: "Payments",
        label: "Team",
        goal: "",
        instructions: "",
        depth: 1,
        archived: false,
        createdAt: now(),
      },
    ],
    chat("lead", "Payments", "manager"),
    chat("mira", "Mira", "side"),
    chat("theo", "Theo", "side"),
  ]);
  const shell = await shellSession(fixture.daemon);
  try {
    // Adding the CEO is a company change, so the daemon creates the channels.
    await shell.service.createBot({ projectId: "acme", manager: true });
    const store = fixture.daemon.store;
    await expect
      .poll(() => store.record("channel", "channel-team-pay")?.memberThreadIds)
      .toEqual(["lead", "mira", "theo"]);
    seed(fixture, [
      [
        "channelPost",
        "lead-ask",
        {
          id: "lead-ask",
          channelId: "channel-team-pay",
          projectId: "acme",
          author: { kind: "thread", threadId: "lead" },
          text: "@Theo can you own the refund tests?",
          mentions: ["theo"],
          recipients: ["theo"],
          messageIds: [],
          question: true,
          createdAt: now(),
        },
      ],
    ]);

    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const channels = sidebar.getByRole("list", { name: "Acme channels" });
    await expect(channels.getByRole("button")).toHaveText(["#general", "#payments"]);
    await channels.getByRole("button", { name: "payments" }).click();

    const main = page.getByRole("main", { name: "#payments" });
    await expect(main.getByRole("heading", { name: "#payments" })).toBeFocused();
    const posts = main.getByRole("list", { name: "Posts" });
    await expect(posts.getByText("Lead")).toBeVisible();
    await expect(main.getByRole("region", { name: "Waiting for replies" })).toContainText(
      "Theo owes Payments a reply",
    );
    const panel = main.getByRole("complementary", { name: "Channel details" });
    await expect(panel.getByRole("button", { name: "Mira" })).toBeVisible();

    const composer = main.getByRole("textbox", { name: "Message #payments" });
    await composer.click();
    await composer.pressSequentially("@Mi");
    await expect(main.getByRole("listbox", { name: "Members" }).getByRole("option")).toHaveText([
      "Mira",
    ]);
    await composer.press("Enter");
    await composer.pressSequentially("please take the refund endpoint");
    await composer.press("Enter");
    await expect(posts.getByText("@Mira please take the refund endpoint")).toBeVisible();
    await expect(posts.getByText("to Mira")).toBeVisible();

    const bar = main.getByRole("region", { name: "Current request" });
    await expect(bar).toContainText("@Mira please take the refund endpoint");
    expect(await axeViolations(page)).toEqual([]);

    await bar.getByRole("button", { name: "Stop" }).click();
    await expect(bar.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Archive @Mira please take the refund endpoint" }),
    ).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
