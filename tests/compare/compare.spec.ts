import { AxeBuilder } from "@axe-core/playwright";
import { chromium, expect, test } from "@playwright/test";
import { compareFixture } from "../../tools/fakes/src/compare-fixture.js";

async function fixture(options: { longFirst?: boolean; dropResolveAck?: boolean } = {}) {
  const f = await compareFixture(options);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ZOLTBOT_HEADLESS_CHROMIUM
      ? { executablePath: process.env.ZOLTBOT_HEADLESS_CHROMIUM }
      : {}),
  });
  const browserContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await browserContext.newPage(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(
    ({ url, token }) => {
      window.zoltDesktop = {
        connection: async () => ({ url, token }),
        onConnectionChanged: () => () => {},
        visibleThread() {},
      };
    },
    { url: f.daemon.url, token: f.daemon.token },
  );
  if (options.dropResolveAck)
    await page.routeWebSocket(f.daemon.url, (client) => {
      const server = client.connectToServer();
      let resolveId: unknown;
      client.onMessage((message) => {
        const request = JSON.parse(message.toString());
        if (request.method === "compare.resolve") resolveId = request.id;
        server.send(message);
      });
      server.onMessage((message) => {
        const reply = JSON.parse(message.toString());
        if (resolveId !== undefined && reply.id === resolveId) {
          client.close();
        } else client.send(message);
      });
    });
  await page.goto("http://127.0.0.1:5196/#chat/thread");
  await expect(page.getByRole("button", { name: "+ Compare", exact: true })).toBeVisible();
  return {
    ...f,
    page,
    errors,
    async close() {
      await browser.close();
      await f.close();
    },
  };
}
async function send(
  f: Awaited<ReturnType<typeof fixture>>,
  prompt = "Plan a small project",
  four = false,
) {
  const { page } = f;
  await page.getByRole("button", { name: "+ Compare", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /^Unavailable/ })).toBeDisabled();
  await page.getByText("Second", { exact: true }).click();
  if (four) {
    await page.getByText("Third", { exact: true }).click();
    await page.getByText("Fourth", { exact: true }).click();
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("textbox", { name: "Message First", exact: true }).fill(prompt);
  await page.getByRole("button", { name: four ? "Send to 4" : "Send to 2", exact: true }).click();
  await expect(page.locator(".compare-view")).toBeVisible();
}
test("independent native columns, responsive layouts and both-theme accessibility", async () => {
  const f = await fixture();
  try {
    await send(f);
    const first = f.page.locator('section[aria-label="First answer"]'),
      second = f.page.locator('section[aria-label="Second answer"]');
    await expect(first.getByRole("status")).toHaveText("Done");
    await expect(second.getByRole("status")).toHaveText("Running");
    await expect(
      second.getByRole("article", { name: "Message from Second", exact: true }),
    ).toHaveAttribute("aria-busy", "true");
    await expect(first.getByRole("status")).toHaveText("Done");
    await expect(second.getByRole("status")).toHaveText("Done");
    expect(f.permissions.every((p) => p === "read_only")).toBe(true);
    const inputs = [...f.natives.values()].map((n) => n.received[0]);
    expect(inputs[0]).toEqual(inputs[1]);
    for (const theme of ["light", "dark"]) {
      await f.page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      expect((await new AxeBuilder({ page: f.page }).analyze()).violations).toEqual([]);
      await expect(f.page.locator(".compare-view")).toHaveScreenshot(`compare-${theme}.png`, {
        animations: "disabled",
        mask: [f.page.locator(".compare-metrics")],
      });
    }
    await f.page.setViewportSize({ width: 1000, height: 900 });
    await expect(f.page.getByRole("tablist", { name: "Compare answers" })).toBeVisible();
    await f.page.getByRole("tab", { name: "Second", exact: true }).click();
    await expect(second).toBeVisible();
    await expect(first).toBeHidden();
    await second.locator(".chat-timeline").focus();
    await f.page.keyboard.press("Control+Tab");
    await expect(first).toBeVisible();
    await expect(first.locator(".chat-timeline")).toBeFocused();
    await f.page.getByRole("button", { name: "Stacked", exact: true }).click();
    await expect(f.page.locator(".compare-columns")).toHaveAttribute("data-layout", "stacked");
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test("four columns require 1440 pixels and stop all reaches every session", async () => {
  const f = await fixture();
  try {
    await f.page.setViewportSize({ width: 1280, height: 900 });
    await send(f, "Take time to plan", true);
    await expect(f.page.locator(".compare-columns")).toHaveAttribute("data-layout", "tabs");
    await f.page.setViewportSize({ width: 1440, height: 900 });
    await expect(f.page.locator(".compare-columns")).toHaveAttribute("data-layout", "columns");
    await expect.poll(() => f.natives.size).toBe(4);
    await f.page.getByRole("button", { name: "Stop all", exact: true }).click();
    await expect
      .poll(() => f.daemon.store.snapshot().turn?.filter((r) => r.status === "running").length ?? 0)
      .toBe(0);
    expect([...f.natives.values()].map((n) => n.interrupted)).toEqual([1, 1, 1, 1]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test("a native question appears in its column and Inbox and can be answered", async () => {
  const f = await fixture();
  try {
    await send(f, "Ask a question");
    const column = f.page.locator('section[aria-label="First answer"]');
    await expect(column.getByText("Choose an approach", { exact: true })).toBeVisible();
    await f.page
      .getByRole("button", { name: /Needs you/ })
      .first()
      .click();
    await expect(f.page.getByText("Choose an approach", { exact: true }).first()).toBeVisible();
    await f.page.goBack();
    await expect(column).toBeVisible();
    await column.getByRole("radio", { name: /Use this approach/ }).check();
    await column.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect.poll(() => [...f.natives.values()].some((n) => n.replies.length > 0)).toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("votes, follow-up, continue and the resolved marker preserve the read-only ceiling", async () => {
  const f = await fixture();
  try {
    await send(f);
    await expect(f.page.getByText("Both done", { exact: true })).toBeVisible();
    const first = f.page.locator('section[aria-label="First answer"]'),
      second = f.page.locator('section[aria-label="Second answer"]');
    await first.getByRole("button", { name: "Better", exact: true }).click();
    await expect(first.getByRole("button", { name: "Better", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await second.getByRole("button", { name: "Better", exact: true }).click();
    await expect(first.getByRole("button", { name: "Better", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(second.getByRole("button", { name: "Better", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      f.daemon.store.snapshot().compareMember?.filter((r) => r.vote === "better"),
    ).toHaveLength(1);
    await f.page
      .getByRole("textbox", { name: "Follow up with all", exact: true })
      .fill("Make it shorter");
    await f.page.getByRole("button", { name: "Send to all", exact: true }).click();
    await expect
      .poll(() => [...f.natives.values()].filter((n) => n.received.length === 2).length)
      .toBe(2);
    const inputs = [...f.natives.values()].map((n) => n.received[1]);
    expect(inputs[0]).toEqual(inputs[1]);
    await expect(f.page.getByText("Both done", { exact: true })).toBeVisible();
    await second.getByRole("button", { name: "Continue with Second", exact: true }).click();
    await expect(
      f.page.getByRole("article", { name: "Compare result", exact: true }),
    ).toContainText("continued with Second");
    await expect(
      f.page.getByText("Compare · Read only: no file edits", { exact: true }),
    ).toBeVisible();
    await expect(
      f.page.getByRole("combobox", { name: "Permission mode", exact: true }),
    ).toHaveCount(0);
    await f.page.locator(".compare-sidebar summary").click();
    await expect(f.page.getByRole("button", { name: "First’s answer", exact: true })).toBeVisible();
    await f.page
      .getByRole("article", { name: "Compare result", exact: true })
      .getByRole("link", { name: "View side by side", exact: true })
      .click();
    await expect(f.page.locator(".compare-bar")).toContainText("read-only");
    await expect(second.getByRole("button", { name: "Better", exact: true })).toBeDisabled();
    await expect(second.getByRole("button", { name: "Better", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await second.getByRole("button", { name: "Open as chat", exact: true }).click();
    await f.page.getByRole("button", { name: "Allow profile permissions…", exact: true }).click();
    const dialog = f.page.getByRole("dialog", {
      name: "Allow this profile’s permissions?",
      exact: true,
    });
    await expect(dialog).toContainText("file edits in this workspace");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(f.daemon.store.snapshot().compareMember?.every((r) => r.ceiling === "read_only")).toBe(
      true,
    );
    await f.page.getByRole("button", { name: "Allow profile permissions…", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm profile permissions", exact: true }).click();
    await expect(
      f.page.getByText("Compare · Read only: no file edits", { exact: true }),
    ).toHaveCount(0);
    expect([...f.natives.values()].every((n) => n.received.length === 2)).toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("merge opens a bounded editable draft and sends nothing automatically", async () => {
  const f = await fixture({ longFirst: true });
  try {
    await send(f);
    await expect(f.page.getByText("Both done", { exact: true })).toBeVisible();
    await f.page
      .locator('section[aria-label="Second answer"]')
      .getByRole("button", { name: "Better", exact: true })
      .click();
    await f.page.getByRole("button", { name: "Merge into one…", exact: true }).click();
    const dialog = f.page.getByRole("dialog", { name: "Choose who will merge", exact: true });
    await expect(dialog.getByRole("combobox", { name: "Merge with", exact: true })).toHaveValue(
      [...(f.daemon.store.snapshot().compareMember ?? [])].find((m) => m.position === 1)
        ?.threadId as string,
    );
    await dialog.getByRole("button", { name: "Open merge draft", exact: true }).click();
    const editor = f.page.getByRole("textbox", { name: "Message Second", exact: true });
    await expect(editor).toContainText("Merge these answers");
    const draft = await editor.inputValue();
    expect(draft).toContain("## First");
    expect(draft).toContain("## Second");
    expect(draft).toContain("Second answer");
    expect(draft).toContain("x".repeat(24000));
    expect(draft).not.toContain("x".repeat(24001));
    expect(draft).toContain("[cut: 6000 more characters, open the full answer]");
    expect([...f.natives.values()].every((n) => n.received.length === 1)).toBe(true);
    await editor.fill("My edited merge request");
    await f.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(() => [...f.natives.values()].some((n) => n.received.length === 2))
      .toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("critique drafts require one explicit send and keep the compare open", async () => {
  const f = await fixture();
  try {
    await send(f);
    await expect(f.page.getByText("Both done", { exact: true })).toBeVisible();
    await f.page
      .getByRole("button", { name: "Ask each to critique the others", exact: true })
      .click();
    const dialog = f.page.getByRole("dialog", { name: "Review critique drafts", exact: true });
    await expect(
      dialog.getByRole("textbox", { name: "Critique for First", exact: true }),
    ).toContainText("Second answer");
    await expect(
      dialog.getByRole("textbox", { name: "Critique for Second", exact: true }),
    ).toContainText("First answer");
    expect([...f.natives.values()].every((n) => n.received.length === 1)).toBe(true);
    await dialog
      .getByRole("textbox", { name: "Critique for First", exact: true })
      .fill("Review the other answer carefully.");
    await dialog.getByRole("button", { name: "Send critiques", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => [...f.natives.values()].filter((n) => n.received.length === 2).length)
      .toBe(2);
    expect(f.daemon.store.snapshot().compare?.[0]?.state).toBe("open");
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("critique retry after a partial failure does not duplicate a confirmed send", async () => {
  const f = await fixture();
  try {
    await send(f);
    await expect(f.page.getByText("Both done", { exact: true })).toBeVisible();
    const members = f.daemon.store.snapshot().compareMember ?? [],
      second = members.find((r) => r.position === 1),
      first = members.find((r) => r.position === 0);
    if (typeof second?.threadId !== "string" || typeof first?.threadId !== "string")
      throw Error("missing members");
    f.daemon.store.database.exec(
      `CREATE TRIGGER fail_critique BEFORE INSERT ON item_records WHEN NEW.thread_id='${second.threadId}' AND NEW.kind='user' BEGIN SELECT RAISE(ABORT,'forced_critique_failure'); END`,
    );
    await f.page
      .getByRole("button", { name: "Ask each to critique the others", exact: true })
      .click();
    const dialog = f.page.getByRole("dialog", { name: "Review critique drafts", exact: true });
    await dialog
      .getByRole("textbox", { name: "Critique for First", exact: true })
      .fill("Keep this edited critique.");
    await dialog.getByRole("button", { name: "Send critiques", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect.poll(() => f.natives.get(first.threadId as string)?.received.length).toBe(2);
    expect(f.natives.get(second.threadId)?.received.length).toBe(1);
    await expect(
      dialog.getByRole("textbox", { name: "Critique for First", exact: true }),
    ).toHaveValue("Keep this edited critique.");
    f.daemon.store.database.exec("DROP TRIGGER fail_critique");
    await dialog.getByRole("button", { name: "Send critiques", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => f.natives.get(second.threadId as string)?.received.length).toBe(2);
    expect(f.natives.get(first.threadId)?.received.length).toBe(2);
    await f.page.getByRole("button", { name: "Close compare", exact: true }).click();
    await expect(f.page.locator(".compare-bar")).toContainText("read-only");
    const ids = new Set(members.map((m) => m.threadId));
    expect(
      f.daemon.store
        .snapshot()
        .thread?.filter((r) => ids.has(r.id))
        .every((r) => r.kind === "side"),
    ).toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a lost resolution acknowledgement preserves the unsent merge draft", async () => {
  const f = await fixture({ dropResolveAck: true });
  try {
    await send(f);
    await expect(f.page.getByText("Both done", { exact: true })).toBeVisible();
    await f.page.getByRole("button", { name: "Merge into one…", exact: true }).click();
    const dialog = f.page.getByRole("dialog", { name: "Choose who will merge", exact: true });
    await dialog.getByRole("button", { name: "Open merge draft", exact: true }).click();
    await expect(f.page.locator(".compare-bar")).toContainText("read-only");
    await f.page
      .locator(".compare-bar")
      .getByRole("button", { name: "Open merge draft", exact: true })
      .click();
    const editor = f.page.getByRole("textbox", { name: "Message First", exact: true });
    await expect(editor).toHaveValue(/Merge these answers/);
    const draft = await editor.inputValue();
    expect(draft).toContain("First answer");
    expect(draft).toContain("Second answer");
    expect([...f.natives.values()].every((n) => n.received.length === 1)).toBe(true);
    expect(
      f.daemon.store
        .snapshot()
        .item?.filter(
          (r) => r.kind === "note" && (r.body as { code?: string })?.code === "compare",
        ),
    ).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("differences sends the reviewed prompt once and remembers hidden strips", async () => {
  const f = await fixture();
  try {
    await send(f);
    await expect(f.page.getByText("Both done", { exact: true })).toBeVisible();
    await f.page
      .locator('section[aria-label="Second answer"]')
      .getByRole("button", { name: "Better", exact: true })
      .click();
    await f.page.getByRole("button", { name: "Where they differ", exact: true }).click();
    const dialog = f.page.getByRole("dialog", { name: "Review differences prompt", exact: true });
    await expect(dialog.getByLabel("Summary writer")).toHaveValue("second");
    const prompt = await dialog.getByLabel("Prompt to send").inputValue();
    expect(prompt).toContain("First answer");
    expect(prompt).toContain("Second answer");
    expect(f.natives.size).toBe(2);
    expect(f.daemon.store.snapshot().compare?.[0]?.summaryThreadId).toBeUndefined();
    await dialog.getByRole("button", { name: "Run differences", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const strip = f.page.getByRole("region", { name: "Where they differ", exact: true });
    await expect(strip).toContainText("Their order differs.");
    await expect(strip).toContainText("Summary by Second");
    await expect(strip).toContainText(/Reported \$[0-9.]+/);
    const snapshot = f.daemon.store.snapshot();
    const summaryId = snapshot.compare?.[0]?.summaryThreadId as string;
    expect(snapshot.compareMember).toHaveLength(2);
    expect(f.natives.size).toBe(3);
    expect(f.natives.get(summaryId)?.received).toHaveLength(1);
    expect(f.natives.get(summaryId)?.received[0]).toEqual([{ type: "text", text: prompt }]);
    const user = snapshot.item?.find((r) => r.threadId === summaryId && r.kind === "user");
    expect((user?.body as { input: unknown })?.input).toEqual([{ type: "text", text: prompt }]);
    expect(f.permissions).toEqual(["read_only", "read_only", "read_only"]);
    for (const theme of ["light", "dark"]) {
      await f.page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      expect((await new AxeBuilder({ page: f.page }).analyze()).violations).toEqual([]);
      await expect(f.page.locator(".compare-view")).toHaveScreenshot(`differences-${theme}.png`, {
        animations: "disabled",
        mask: [f.page.locator(".compare-metrics")],
      });
    }
    await strip.getByRole("button", { name: "Hide differences", exact: true }).click();
    await expect(strip).toHaveCount(0);
    await f.page.reload();
    await expect(
      f.page.getByRole("button", { name: "Show differences", exact: true }),
    ).toBeVisible();
    await expect(strip).toHaveCount(0);
    await f.page.getByRole("button", { name: "Show differences", exact: true }).click();
    await expect(strip).toContainText("Their order differs.");
    expect(f.natives.get(summaryId)?.received).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("cancelled mode widening retains the effective selection and can be reviewed again", async () => {
  const f = await fixture();
  try {
    const modulePath = `/@fs/${process.cwd()}/e2e/chat-parity-gallery.tsx`;
    await f.page.evaluate(async (path) => {
      const gallery = await import(path);
      gallery.mountChatParity("light");
    }, modulePath);
    const mode = f.page.getByRole("combobox", { name: "Permission mode", exact: true });
    await mode.selectOption("bypassPermissions");
    const dialog = f.page.getByRole("dialog", {
      name: "Switch to Full access?",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(mode).toHaveValue("default");
    // Hold the browser's close event until after the person opens the same dialog again.
    await dialog.evaluate((node) => {
      node.addEventListener(
        "close",
        (event) => {
          event.stopImmediatePropagation();
          (window as unknown as { delayedClose: Element }).delayedClose = node;
        },
        { capture: true, once: true },
      );
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(() =>
        f.page.evaluate(() => !!(window as unknown as { delayedClose?: Element }).delayedClose),
      )
      .toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(mode).toHaveValue("default");
    expect(
      await f.page.evaluate(() => (window as unknown as { parityCalls: unknown[] }).parityCalls),
    ).toEqual([]);
    await mode.selectOption("bypassPermissions");
    await expect(dialog).toBeVisible();
    await f.page.evaluate(() => {
      const state = window as unknown as { delayedClose?: Element };
      state.delayedClose?.dispatchEvent(new Event("close"));
      delete state.delayedClose;
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Switch to Full access", exact: true }).click();
    expect(
      await f.page.evaluate(() => (window as unknown as { parityCalls: unknown[] }).parityCalls),
    ).toEqual([
      {
        method: "session.setMode",
        params: { id: "s", mode: "bypassPermissions", confirmed: true },
      },
    ]);
  } finally {
    await f.close();
  }
});
