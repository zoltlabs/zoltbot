import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, showActivity, showMessageDetails } from "./desktop.js";

test("renders saved chat, tool details, Markdown, usage, and multiline input", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await expect(page.getByRole("heading", { name: "Chat verification" })).toBeVisible();
    await expect(page.getByText("Ready to work.", { exact: true })).toBeVisible();
    expect(await page.locator(".chat-virtual-row").count()).toBeLessThan(45);
    await expect(page.getByRole("heading", { name: "A clear result" })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { fixtureUnsafe?: boolean }).fixtureUnsafe),
    ).toBeUndefined();
    await showActivity(page);
    const thought = page.getByRole("article", { name: "Builder thinking" });
    await expect(thought.getByText("Compare the two options before editing.")).toBeHidden();
    await thought.getByText("Reasoning", { exact: true }).click();
    await expect(thought.getByText("Compare the two options before editing.")).toBeVisible();
    await expect(page.getByRole("region", { name: "To-do list", exact: true })).toContainText(
      "Check the result",
    );
    await expect(page.getByRole("article", { name: "To-do update", exact: true })).toContainText(
      "2/3 done",
    );
    await page.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    // Edits open with their diff inline and line counts in the summary.
    await expect(page.getByRole("article", { name: "Tool Edit", exact: true })).toContainText("+1");
    await expect(
      page.getByText("+export const greeting = 'hello';", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "output/playwright/chat-light.png", fullPage: true });
    const violations = await new AxeBuilder({ page }).setLegacyMode().analyze();
    expect(violations.violations).toEqual([]);
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("usage");
    await editor.press("Enter");
    await showMessageDetails(page, "Reported $0.0010");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();
    await editor.fill("  Keep this exact text\n");
    await editor.press("Shift+Enter");
    await expect(editor).toHaveValue("  Keep this exact text\n\n");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "output/playwright/chat-dark.png", fullPage: true });
  } finally {
    await fixture.cleanup();
  }
});
test("keeps live updates anchored and sends selected files through the desktop file boundary", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("stream_pause");
    await editor.press("Enter");
    await expect(page.getByText("visible", { exact: true })).toBeVisible();
    const region = page.getByRole("region", { name: "Conversation", exact: true });
    // While a reply streams, the empty composer's send button becomes Stop; text turns it into Queue.
    await expect(
      page.getByRole("button", { name: "Stop the response", exact: true }),
    ).toBeVisible();
    await editor.fill("next");
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
    await editor.fill("");
    writeFileSync(path.join(fixture.dataDir, "advance-stream"), "1");
    await expect(page.getByText("synthetic-private-", { exact: false })).toHaveCount(0);
    writeFileSync(path.join(fixture.dataDir, "advance-stream"), "2");
    await expect(page.getByText("visible [redacted] done", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        region.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(80);
    const file = path.join(fixture.dataDir, "attachment.txt");
    writeFileSync(file, "Synthetic attachment");
    await page.getByLabel("Attach files").setInputFiles(file);
    await expect(page.getByRole("list", { name: "Attachments" })).toContainText("attachment.txt");
    await editor.fill("Attached fixture");
    await editor.press("Enter");
    await expect(page.getByRole("list", { name: "Attachments" })).toHaveCount(0);
    await expect(page.getByText("File: attachment.txt", { exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});
test("mounts a bounded timeline for ten thousand cached items", async () => {
  const fixture = await launch("chat", undefined, { historyItems: 10000 }),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await expect(page.getByText("Ready to work.", { exact: true })).toBeVisible();
    expect(await page.locator(".chat-virtual-row").count()).toBeLessThan(80);
    const region = page.getByRole("region", { name: "Conversation", exact: true });
    await region.hover();
    await page.mouse.wheel(0, -2000);
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await page.getByRole("button", { name: "Jump to latest" }).click();
    await expect(page.getByText("Ready to work.", { exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("stops the owned native turn and preserves unfinished visible output", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("stream_pause");
    await editor.press("Enter");
    await expect(page.getByText("visible", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      page.getByText("You requested that this turn stop.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This message ended before completion. Native history may contain more detail.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await editor.fill("usage");
    await editor.press("Enter");
    await showMessageDetails(page, "Reported $0.0010");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("retains exact drafts after a rejected command and keeps retry identity until edited", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await page.evaluate(() => {
      const original = crypto.randomUUID.bind(crypto);
      let first = true;
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: () => {
          if (first) {
            first = false;
            return "fixture:history";
          }
          return original();
        },
      });
    });
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    const draft = "  Keep this exact draft\nwith a second line";
    await editor.fill(draft);
    await editor.press("Enter");
    await expect(page.getByRole("alert")).toContainText("your draft is still here");
    await expect(editor).toHaveValue(draft);
    await editor.press("Enter");
    await expect(page.getByRole("alert")).toContainText("your draft is still here");
    await expect(editor).toHaveValue(draft);
    await expect(
      page
        .getByRole("article", { name: "Your message", exact: true })
        .filter({ hasText: "Keep this exact draft" }),
    ).toHaveCount(0);
    await editor.fill(`${draft}!`);
    await editor.press("Enter");
    await expect(editor).toHaveValue("");
    await expect(
      page
        .getByRole("article", { name: "Your message", exact: true })
        .filter({ hasText: "Keep this exact draft" }),
    ).toHaveCount(1);
  } finally {
    await fixture.cleanup();
  }
});

test("chooses workspace file mentions with the keyboard and keeps their native file attachment", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("Inspect @hello");
    await expect(page.getByRole("region", { name: "Workspace files" })).toContainText(
      "Start a native session",
    );
    await editor.press("Escape");
    await expect(page.getByRole("region", { name: "Workspace files" })).toHaveCount(0);
    await expect(editor).toHaveValue("Inspect @hello");
    await editor.fill("usage");
    await editor.press("Enter");
    await showMessageDetails(page, "Reported $0.0010");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();
    mkdirSync(path.join(fixture.dataDir, "src"));
    writeFileSync(path.join(fixture.dataDir, "src", "hello.ts"), "Synthetic source");
    await editor.fill("Inspect @hello");
    const picker = page.getByRole("region", { name: "Workspace files" });
    await expect(picker.getByRole("button", { name: "src/hello.ts", exact: true })).toBeVisible();
    await page.screenshot({ path: "output/playwright/chat-mentions.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await editor.press("ArrowDown");
    await expect(picker.getByRole("button", { name: "src/hello.ts", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Inspect @src/hello.ts ");
    await expect(page.getByRole("list", { name: "Attachments" })).toContainText("src/hello.ts");
    await editor.press("Enter");
    await expect(editor).toHaveValue("");
    await expect(page.getByText("File: hello.ts", { exact: true })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("previews bounded images and explains a failed image preflight without uncertain delivery", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    const file = path.join(fixture.dataDir, "fixture.png");
    writeFileSync(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await page.getByLabel("Attach files").setInputFiles(file);
    await expect(page.getByRole("alert")).toContainText(
      "Images are not available for this connection.",
    );
    await editor.fill("usage");
    await editor.press("Enter");
    await showMessageDetails(page, "Reported $0.0010");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();
    const large = path.join(fixture.dataDir, "large.png");
    writeFileSync(large, Buffer.alloc(512 * 1024 + 1));
    await page.getByLabel("Attach files").setInputFiles(large);
    await expect(page.getByRole("alert")).toContainText("512 KB");
    await expect(page.getByRole("list", { name: "Attachments" })).toHaveCount(0);
    await page.getByLabel("Attach files").setInputFiles(file);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const preview = page.getByRole("img", { name: "Preview of fixture.png" });
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await page.getByLabel("Attach files").setInputFiles(file);
    await expect(page.getByRole("list", { name: "Attachments" }).getByRole("listitem")).toHaveCount(
      1,
    );
    await expect
      .poll(() =>
        page
          .getByRole("region", { name: "Conversation", exact: true })
          .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
      )
      .toBeLessThan(4);
    await page.screenshot({ path: "output/playwright/chat-image.png", fullPage: true });
    await editor.fill("Image fixture");
    await editor.press("Enter");
    await expect(page.getByText("Image: fixture.png", { exact: true })).toBeVisible();
    await page.getByLabel("Attach files").setInputFiles(file);
    writeFileSync(file, "Invalid synthetic image");
    await editor.fill("Invalid image fixture");
    await editor.press("Enter");
    await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "An image could not be loaded, is unsupported, or exceeds the native input limit. This message was not sent.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByText("Delivery needs review", { exact: true })).toHaveCount(0);
    await editor.fill("usage");
    await editor.press("Enter");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toHaveCount(2);
  } finally {
    await fixture.cleanup();
  }
});

test("removes queued intent before native delivery while preserving its cancelled history", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("stream_pause");
    await editor.press("Enter");
    await expect(page.getByText("visible", { exact: true })).toBeVisible();
    await editor.fill("Do not deliver this queued fixture");
    await editor.press("Enter");
    const queue = page.getByRole("region", { name: "Queued messages" });
    await expect(queue).toContainText("Do not deliver this queued fixture");
    await page.screenshot({ path: "output/playwright/chat-queue-light.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await page.screenshot({ path: "output/playwright/chat-queue-dark.png", fullPage: true });
    await queue.getByRole("button", { name: /Remove queued message/ }).click();
    await expect(queue).toHaveCount(0);
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole("region", { name: "Conversation", exact: true })
          .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
      )
      .toBeLessThan(4);
  } finally {
    await fixture.cleanup();
  }
});
test("queues interrupt and send before stopping only the original native turn", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await expect(page.getByRole("button", { name: "Interrupt and send", exact: true })).toHaveCount(
      0,
    );
    await editor.fill("stream_pause");
    await editor.press("Enter");
    await expect(page.getByText("visible", { exact: true })).toBeVisible();
    await editor.fill("usage");
    await page.getByRole("button", { name: "Interrupt and send", exact: true }).click();
    await expect(editor).toHaveValue("");
    await expect(
      page.getByText("You requested that this turn stop.", { exact: true }),
    ).toBeVisible();
    await showMessageDetails(page, "Reported $0.0010");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Queued messages" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("discovers reported native commands and selects them without submitting until confirmed", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("/");
    await expect(page.getByRole("region", { name: "Native commands" })).toContainText(
      "No native command catalog is available",
    );
    await editor.press("Escape");
    await expect(page.getByRole("region", { name: "Native commands" })).toHaveCount(0);
    await expect(editor).toHaveValue("/");
    await editor.fill("usage");
    await editor.press("Enter");
    await showMessageDetails(page, "Reported $0.0010");
    await expect(page.getByText("Reported $0.0010", { exact: true })).toBeVisible();
    await editor.fill("/fi");
    const picker = page.getByRole("region", { name: "Native commands" });
    await expect(picker.getByRole("button", { name: /^\/fixture/ })).toBeVisible();
    await page.screenshot({ path: "output/playwright/chat-commands.png", fullPage: true });
    expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    await editor.press("ArrowDown");
    await expect(picker.getByRole("button", { name: /^\/fixture/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("/fixture ");
    await expect(page.getByText("Native fixture command handled.", { exact: true })).toHaveCount(0);
    await editor.press("Enter");
    await expect(page.getByText("Native fixture command handled.", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue("");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    await editor.fill("/fi");
    await expect(page.getByRole("region", { name: "Native commands" })).toBeVisible();
    await page.screenshot({ path: "output/playwright/chat-commands-dark.png", fullPage: true });
  } finally {
    await fixture.cleanup();
  }
});
