import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { handle } from "../../packages/core/src/index.js";
import { startDaemon } from "../../packages/daemon/src/api.js";
import { QuickRepository } from "../../packages/daemon/src/quick-chat/repository.js";
import { parseEvent } from "../../packages/protocol/src/index.js";
import { runtimeFixture } from "../../tools/fakes/src/runtime-fixture.js";

test("chat row hover icons, context menu actions, pinning, unread, rename, archive, and delete", async () => {
  const f = await runtimeFixture("zoltbot.db");
  const t1At = "2026-11-12T10:00:00.000Z";
  const t2At = "2026-11-12T09:00:00.000Z";
  f.store.dispatch("seed-p1", (s) =>
    handle(
      s,
      {
        type: "create",
        kind: "project",
        value: {
          id: "p1",
          name: "Sample Workspace",
          goal: "Ship features",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 0,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: t2At,
        },
      },
      { commandId: "seed-p1", at: t2At, actor: { kind: "human", id: "fixture" } },
    ),
  );
  f.store.dispatch("seed-t1", (s) =>
    handle(
      s,
      {
        type: "create",
        kind: "thread",
        value: {
          id: "t1",
          agentId: "profile",
          title: "Alpha chat",
          titleSource: "human",
          kind: "side",
          node: { type: "project", id: "p1" },
          projectId: "p1",
          pinned: false,
          archived: false,
          createdAt: t2At,
          lastActivityAt: t1At,
        },
      },
      { commandId: "seed-t1", at: t1At, actor: { kind: "human", id: "fixture" } },
    ),
  );
  f.store.dispatch("seed-s1", () => ({
    events: [
      parseEvent({
        eventId: "seed-s1:0",
        commandId: "seed-s1",
        aggregateType: "session",
        aggregateId: "s-t1",
        type: "session.updated",
        occurredAt: t1At,
        payload: {
          id: "s-t1",
          threadId: "t1",
          provider: "reference",
          cwd: f.root,
          state: "closed",
          capabilities: {},
          startedAt: t2At,
          endedAt: t1At,
        },
      }),
    ],
    result: {},
  }));
  f.store.dispatch("seed-turn1", () => ({
    events: [
      parseEvent({
        eventId: "seed-turn1:0",
        commandId: "seed-turn1",
        aggregateType: "turn",
        aggregateId: "turn1",
        type: "turn.updated",
        occurredAt: t1At,
        payload: {
          id: "turn1",
          threadId: "t1",
          sessionId: "s-t1",
          status: "completed",
          origin: "human",
          startedAt: t2At,
          endedAt: t1At,
        },
      }),
    ],
    result: {},
  }));
  f.store.dispatch("seed-t2", (s) =>
    handle(
      s,
      {
        type: "create",
        kind: "thread",
        value: {
          id: "t2",
          agentId: "profile",
          title: "Beta chat",
          titleSource: "human",
          kind: "side",
          node: { type: "project", id: "p1" },
          projectId: "p1",
          pinned: false,
          archived: false,
          createdAt: t2At,
          lastActivityAt: t2At,
        },
      },
      { commandId: "seed-t2", at: t2At, actor: { kind: "human", id: "fixture" } },
    ),
  );
  new QuickRepository(f.store).saveChat({
    id: "q1",
    title: "Quick scratchpad",
    createdAt: t2At,
    updatedAt: t2At,
    contextSources: [],
    handoffs: [],
  });

  const daemon = await startDaemon({ dataDir: f.root, origins: ["http://127.0.0.1:5189"] });
  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(chromium.executablePath())
      ? chromium.executablePath()
      : path.join(
          homedir(),
          "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(
      ({ url, token }) => {
        window.zoltDesktop = {
          connection: async () => ({ url, token }),
          onConnectionChanged: () => () => {},
          visibleThread() {},
        };
      },
      { url: daemon.url, token: daemon.token },
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("http://127.0.0.1:5189/#chat/t1");
    const tree = page.locator(".scope-tree");
    const alphaRow = tree.locator("button.scope-chat[data-chat='t1']");
    const betaRow = tree.locator("button.scope-chat[data-chat='t2']");
    await expect(alphaRow).toBeVisible();
    await expect(betaRow).toBeVisible();

    // Hovering a chat row reveals the Pin and 3-dots (More actions) buttons.
    const betaShell = tree.locator(".chat-row-shell", {
      has: page.locator("button.scope-chat[data-chat='t2']"),
    });
    await betaShell.hover();
    const pinBeta = betaShell.getByRole("button", { name: "Pin Beta chat", exact: true });
    const moreBeta = betaShell.getByRole("button", {
      name: "More actions for Beta chat",
      exact: true,
    });
    await expect(pinBeta).toBeVisible();
    await expect(moreBeta).toBeVisible();

    // Clicking Pin moves Beta chat above Alpha chat and persists on the daemon store.
    await pinBeta.click();
    await page.mouse.move(0, 0);
    await expect(
      betaShell.getByRole("button", { name: "Unpin Beta chat", exact: true }),
    ).toBeVisible();
    await expect.poll(() => daemon.store.record("thread", "t2")?.pinned).toBe(true);
    await expect
      .poll(() => tree.locator("button.scope-chat").first().getAttribute("data-chat"))
      .toBe("t2");

    // Right-clicking the active Alpha chat opens the context menu and Mark unread keeps it unread ("Done" since it has a finished turn).
    await alphaRow.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Actions for Alpha chat" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Mark unread", exact: true })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Mark unread", exact: true }).click();
    await page.mouse.move(0, 0);
    await expect(alphaRow.locator(".scope-state.done")).toHaveText("Done");
    await expect
      .poll(() => String(daemon.store.record("thread", "t1")?.lastReadAt ?? "") < t1At)
      .toBe(true);

    // 3-dots menu on Alpha chat now offers "Mark read", and Rename updates the chat title.
    const alphaShell = tree.locator(".chat-row-shell", {
      has: page.locator("button.scope-chat[data-chat='t1']"),
    });
    await alphaShell.hover();
    await alphaShell
      .getByRole("button", { name: "More actions for Alpha chat", exact: true })
      .click();
    await expect(page.getByRole("menuitem", { name: "Mark read", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename chat" });
    await expect(renameDialog).toBeVisible();
    await renameDialog.getByLabel("Name").fill("Alpha renamed");
    await renameDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(alphaRow).toContainText("Alpha renamed");
    await expect.poll(() => daemon.store.record("thread", "t1")?.title).toBe("Alpha renamed");

    // Marking a turnless chat (Beta chat) unread shows the "Unread" badge and persists wakeUnreadAt.
    await betaRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark unread", exact: true }).click();
    await page.mouse.move(0, 0);
    await expect(betaRow.locator(".scope-state.unread")).toHaveText("Unread");
    await expect.poll(() => Boolean(daemon.store.record("thread", "t2")?.wakeUnreadAt)).toBe(true);

    // Axe accessibility check on clean state + context menu.
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Right-click -> Archive hides Beta chat from sidebar and marks it archived in store.
    await betaRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(betaRow).toHaveCount(0);
    await expect.poll(() => daemon.store.record("thread", "t2")?.archived).toBe(true);

    // Right-click -> Delete focuses Cancel first and removes Alpha renamed upon confirmation.
    await alphaRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    const deleteDialog = page.getByRole("dialog", { name: "Delete “Alpha renamed”?" });
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await deleteDialog.getByRole("button", { name: "Delete chat", exact: true }).click();
    await expect(alphaRow).toHaveCount(0);
    await expect.poll(() => daemon.store.record("thread", "t1")).toBeUndefined();

    // Quick Chat sidebar row also supports right-click + hover Pin/More actions.
    const quickHistory = page.locator(".quick-history");
    await quickHistory.locator("summary").click();
    const quickRow = quickHistory.locator("button.quick-recent-open", {
      hasText: "Quick scratchpad",
    });
    const quickShell = quickHistory.locator(".chat-row-shell", {
      has: page.locator("button.quick-recent-open", { hasText: "Quick scratchpad" }),
    });
    await expect(quickRow).toBeVisible();
    await quickShell.hover();
    await expect(
      quickShell.getByRole("button", { name: "Pin Quick scratchpad", exact: true }),
    ).toBeVisible();
    await expect(
      quickShell.getByRole("button", { name: "More actions for Quick scratchpad", exact: true }),
    ).toBeVisible();
    await quickRow.click({ button: "right" });
    const quickMenu = page.getByRole("menu", { name: "Actions for Quick scratchpad" });
    await expect(quickMenu.getByRole("menuitem", { name: "Pin", exact: true })).toBeVisible();
    await expect(
      quickMenu.getByRole("menuitem", { name: "Mark unread", exact: true }),
    ).toBeVisible();
    await expect(quickMenu.getByRole("menuitem", { name: "Rename…", exact: true })).toBeVisible();
    await expect(quickMenu.getByRole("menuitem", { name: "Archive", exact: true })).toBeVisible();
    await expect(quickMenu.getByRole("menuitem", { name: "Delete…", exact: true })).toBeVisible();
    await quickMenu.getByRole("menuitem", { name: "Mark unread", exact: true }).click();
    await expect(quickRow.locator(".chat-unread-badge")).toHaveText("Unread");

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await daemon.close();
    f.close();
  }
});
