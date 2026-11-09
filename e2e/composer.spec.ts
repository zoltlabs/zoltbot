import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const url = "/composer-preview.html";
const editor = (page: Page) => page.getByRole("textbox", { name: "Message Builder" });
const calls = (page: Page) =>
  page.evaluate(() => window.composerFixture.calls.filter((call) => call.method === "turn.send"));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4S8AAAAASUVORK5CYII=",
  "base64",
);
const image = { name: "screen.png", mimeType: "image/png", buffer: png };
test.beforeEach(async ({ page, baseURL }) => {
  await page.goto(
    new URL(url, baseURL ?? `http://127.0.0.1:${process.env.ZOLTBOT_E2E_PORT ?? 5187}`).href,
  );
});

test("recovers independent conversation drafts, attachments and output across navigation and reload; clears only on confirmed send", async ({
  page,
}) => {
  await editor(page).fill("Exact **draft**\n日本語");
  await page.getByRole("combobox", { name: "Output", exact: true }).selectOption("document");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(image);
  await expect(page.getByText("Image ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(editor(page)).toHaveValue("");
  await editor(page).fill("Conversation B");
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(editor(page)).toHaveValue("Exact **draft**\n日本語");
  await page.reload();
  await expect(editor(page)).toHaveValue("Exact **draft**\n日本語");
  await expect(page.getByRole("combobox", { name: "Output", exact: true })).toHaveValue("document");
  await expect(page.getByRole("img", { name: "Preview of screen.png" })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(editor(page)).toHaveValue("");
  expect((await calls(page))[0]?.params).toMatchObject({
    threadId: "composer-a",
    outputMode: "document",
    input: [
      { type: "text", text: "Exact **draft**\n日本語" },
      { type: "image", base64: png.toString("base64"), mimeType: "image/png" },
    ],
  });
  await page.reload();
  await expect(editor(page)).toHaveValue("");
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(editor(page)).toHaveValue("Conversation B");
});

test("failed sends retain the payload and idempotency key through reload and retry", async ({
  page,
}) => {
  await editor(page).fill("Retry me");
  await page.evaluate(() => {
    window.composerFixture.fail = true;
  });
  await editor(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  const first = (await calls(page))[0];
  await expect(editor(page)).toHaveValue("Retry me");
  await page.reload();
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("");
  expect((await calls(page))[0]).toEqual(first);
});

test("image preparation failure blocks send, retries the original file, and recovers interrupted images as actionable errors", async ({
  page,
}) => {
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    let failed = false;
    FileReader.prototype.readAsDataURL = function (file) {
      if (!failed) {
        failed = true;
        setTimeout(() => this.dispatchEvent(new ProgressEvent("error")), 20);
      } else original.call(this, file);
    };
  });
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(image);
  await expect(page.getByRole("button", { name: "Retry screen.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry screen.png" }).click();
  await expect(page.getByText("Image ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove screen.png" }).click();
  await page.evaluate(() => {
    FileReader.prototype.readAsDataURL = () => {};
  });
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(image);
  await expect(page.getByText("Preparing…", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Preparation was interrupted. Attach this file again."),
  ).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Retry screen.png" }).click();
  await (await chooser).setFiles(image);
  await expect(page.getByText("Image ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Attachments" }).getByRole("listitem")).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("list", { name: "Attachments" })).toHaveCount(0);
});

test("native file references deduplicate and capability loss blocks restored images", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.zoltDesktop = {
      connection: async () => ({ url: "ws://synthetic.invalid", token: "synthetic" }),
      onConnectionChanged: () => () => {},
      filePath: (file) => `/synthetic/${file.name}`,
    };
  });
  const file = {
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("Synthetic notes"),
  };
  await page.getByLabel("Attach files", { exact: true }).setInputFiles([file, image]);
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(file);
  await expect(page.getByRole("list", { name: "Attachments" }).getByRole("listitem")).toHaveCount(
    2,
  );
  await page.getByRole("button", { name: "Toggle images" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove screen.png" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await calls(page))[0]?.params).toMatchObject({
    input: [{ type: "file", path: "/synthetic/notes.md" }],
  });
});

test("Markdown selection formatting, preview, plain text and large pastes preserve exact source", async ({
  page,
}) => {
  await expect(page.getByRole("button", { name: "Bold", exact: true })).toHaveCount(0);
  await editor(page).fill("hello");
  await editor(page).selectText();
  await editor(page).press("ControlOrMeta+b");
  await expect(editor(page)).toHaveValue("**hello**");
  await editor(page).fill("hello");
  await editor(page).selectText();
  await page.getByRole("button", { name: "Formatting", exact: true }).click();
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(editor(page)).toHaveValue("**hello**");
  await page.getByText("Markdown preview", { exact: true }).click();
  await expect(page.locator(".composer-preview strong")).toHaveText("hello");
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(page.getByRole("button", { name: "Bold", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Plain text", exact: true })).toBeVisible();
  await expect(editor(page)).toHaveValue("**hello**");
  const large = "Long pasted context\n".repeat(2500);
  await editor(page).fill("");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((text) => navigator.clipboard.writeText(text), large);
  await editor(page).press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expect(page.getByText(/Large draft/)).toBeVisible();
  await page.reload();
  await expect(editor(page)).toHaveValue(large);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await calls(page))[0]?.params).toMatchObject({ input: [{ type: "text", text: large }] });
});

test("IME, repeated Enter, Shift+Enter, file and skill pickers and permission shortcut", async ({
  page,
}) => {
  await editor(page).fill("日本語");
  await editor(page).dispatchEvent("compositionstart");
  await editor(page).press("Enter");
  expect(await calls(page)).toHaveLength(0);
  await editor(page).dispatchEvent("compositionend");
  await editor(page).dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await editor(page).dispatchEvent("keydown", { key: "Enter", repeat: true });
  expect(await calls(page)).toHaveLength(0);
  await editor(page).fill("日本語");
  await editor(page).press("Shift+Enter");
  await expect(editor(page)).toHaveValue("日本語\n");
  await editor(page).press("Shift+Tab");
  await expect(page.getByText("Permission mode 1", { exact: true })).toBeVisible();
  await editor(page).fill("/zoltbot");
  await editor(page).press("End");
  await expect(page.getByRole("region", { name: "Native commands" })).toBeVisible();
  await editor(page).press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toHaveValue("/zoltbot-review ");
  await editor(page).fill("@src");
  await editor(page).press("End");
  await expect(page.getByRole("button", { name: "src/main.ts" })).toBeVisible();
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("@src/main.ts ");
  expect(await calls(page)).toHaveLength(0);
  await editor(page).press("Enter");
  expect((await calls(page))[0]?.params).toMatchObject({
    input: [
      { type: "text", text: "@src/main.ts " },
      { type: "file", path: "/synthetic/src/main.ts" },
    ],
  });
});

test("queue, steer, interrupt, stop, artifact target and offline gating retain existing send semantics", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Toggle busy" }).click();
  await editor(page).fill("Queued");
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("");
  expect((await calls(page)).at(-1)?.params).toMatchObject({ mode: "queue" });
  await editor(page).fill("Steered");
  await editor(page).press("Control+Enter");
  await expect(editor(page)).toHaveValue("");
  expect((await calls(page)).at(-1)?.params).toMatchObject({ mode: "steer" });
  await editor(page).fill("Interrupt");
  await page.getByRole("button", { name: "Interrupt and send", exact: true }).click();
  await expect(editor(page)).toHaveValue("");
  expect(await page.evaluate(() => window.composerFixture.calls.at(-1)?.method)).toBe("interrupt");
  await page.getByRole("button", { name: "Stop the response" }).click();
  await page.getByRole("button", { name: "Toggle artifact" }).click();
  await editor(page).fill("Artifact revision");
  await editor(page).press("Control+Enter");
  await expect(editor(page)).toHaveValue("");
  expect((await calls(page)).at(-1)?.params).toMatchObject({
    mode: "queue",
    artifactTarget: { artifactId: "synthetic-artifact", versionId: "synthetic-version" },
  });
  await editor(page).fill("Offline draft");
  await page.getByRole("button", { name: "Toggle connection" }).click();
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeDisabled();
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("Offline draft");
});

test("a delayed send cannot erase a newer draft after navigating away and back", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.composerFixture.hold = true;
  });
  await editor(page).fill("Sending");
  await editor(page).press("Enter");
  await expect(editor(page)).toBeDisabled();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await editor(page).fill("Newer work");
  await page.evaluate(() => {
    window.composerFixture.resolve?.();
  });
  await page.reload();
  await expect(editor(page)).toHaveValue("Newer work");
});

test("Quick Chat handoff appends without overwriting a recovered draft and does not send", async ({
  page,
}) => {
  await editor(page).fill("Existing draft");
  await page.getByRole("button", { name: "Handoff", exact: true }).click();
  await expect(editor(page)).toHaveValue("Existing draft\n\nQuick Chat handoff");
  await page.reload();
  await expect(editor(page)).toHaveValue("Existing draft\n\nQuick Chat handoff");
  expect(await calls(page)).toHaveLength(0);
});

for (const theme of ["dark", "light"])
  test(`composer is accessible and responsive in ${theme}`, async ({ page }) => {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await editor(page).fill("# Review changes\n\n- Keep the draft\n- Run tests");
    await page.getByRole("button", { name: "Formatting", exact: true }).click();
    await page.getByText("Markdown preview", { exact: true }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `output/playwright/composer-${theme}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `output/playwright/composer-${theme}-mobile.png`,
      fullPage: true,
    });
  });

test("pasted images enter the attachment pipeline and invalid file choices keep the draft", async ({
  page,
}) => {
  await editor(page).fill("Keep this");
  await editor(page).evaluate(
    (element, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    },
    [...png],
  );
  await expect(page.getByText("Image ready", { exact: true })).toBeVisible();
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "unsupported.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("synthetic"),
  });
  await expect(page.getByRole("alert")).toContainText("PNG, JPEG, GIF or WebP");
  await page.getByLabel("Attach files", { exact: true }).setInputFiles({
    name: "large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(512 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText("512 KB");
  await expect(editor(page)).toHaveValue("Keep this");
  await expect(page.getByRole("list", { name: "Attachments" }).getByRole("listitem")).toHaveCount(
    1,
  );
});

test("storage failure is visible and does not prevent editing or sending", async ({ page }) => {
  await editor(page).fill("Previously saved");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("synthetic quota", "QuotaExceededError");
    };
  });
  await editor(page).fill("In memory");
  await expect(page.getByText(/This draft is kept in this window only/)).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(editor(page)).toHaveValue("");
  expect((await calls(page))[0]?.params).toMatchObject({
    input: [{ type: "text", text: "In memory" }],
  });
});

test("dictation still inserts into the source editor and Escape restores the durable draft", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let listener:
      | ((event: {
          sessionId: string;
          kind: "partial" | "final" | "stopped";
          text?: string;
        }) => void)
      | undefined;
    const status = async () => ({
      available: true,
      onDevice: true,
      locale: "en-US",
      microphone: "authorized" as const,
      speech: "authorized" as const,
    });
    window.zoltDesktop = {
      connection: async () => ({ url: "ws://synthetic.invalid", token: "synthetic" }),
      onConnectionChanged: () => () => {},
      dictation: {
        status,
        requestPermission: status,
        onEvent: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        start: async () => {
          setTimeout(
            () =>
              listener?.({
                sessionId: "synthetic-dictation",
                kind: "partial",
                text: "spoken words",
              }),
            25,
          );
          return { sessionId: "synthetic-dictation" };
        },
        writeAudio: () => {},
        cancel: async () => {},
        stop: async () => {
          listener?.({ sessionId: "synthetic-dictation", kind: "final", text: "final words" });
          listener?.({ sessionId: "synthetic-dictation", kind: "stopped" });
        },
      },
    };
  });
  await page.reload();
  await editor(page).fill("Prefix:");
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(editor(page)).toHaveValue("Prefix: spoken words");
  await editor(page).press("Escape");
  await expect(editor(page)).toHaveValue("Prefix:");
  await page.reload();
  await expect(editor(page)).toHaveValue("Prefix:");
  await editor(page).press("End");
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(editor(page)).toHaveValue("Prefix: spoken words");
  await page.getByRole("button", { name: "Finish dictation", exact: true }).click();
  await expect(editor(page)).toHaveValue("Prefix: final words");
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("");
  expect((await calls(page))[0]?.params).toMatchObject({
    input: [{ type: "text", text: "Prefix: final words" }],
  });
});
