import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { serveAttachments } from "../attachment-route";
import { axeViolations, shellSession } from "../harness";

test("sent files stay on the message and open in a preview by kind", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  const dir = await mkdtemp(join(tmpdir(), "file-previews-"));
  try {
    const csv = join(dir, "sales.csv");
    const md = join(dir, "plan.md");
    const svg = join(dir, "logo.svg");
    await writeFile(
      csv,
      ["region,units", ...Array.from({ length: 600 }, (_, i) => `r${i},${i}`)].join("\n"),
    );
    await writeFile(md, "# Launch plan\n\n- Freeze pricing\n");
    await writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#5b52e8"/></svg>',
    );
    const bot = await shell.service.createBot({ profileId: "profile", title: "Files" });
    await shell.open(page);
    await serveAttachments(page, shell.service);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Files/ })
      .click();
    await shell.rpc.call(
      "turn.send",
      {
        threadId: bot.id,
        input: [
          { type: "text", text: "Here are the files" },
          { type: "file", path: csv },
          { type: "file", path: md },
          { type: "file", path: svg },
        ],
        mode: "queue",
      },
      "send-files",
    );
    const csvCard = page.getByRole("button", { name: "Preview sales.csv" });
    await expect(csvCard).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0, {
      timeout: 15_000,
    });

    await csvCard.click();
    const dialog = page.getByRole("dialog", { name: "sales.csv" });
    const table = dialog.getByRole("region", { name: "sales.csv" });
    await expect(table.getByRole("columnheader", { name: "region" })).toBeVisible();
    await expect(dialog.getByText("First 500 of 600 rows")).toBeVisible();
    await expect(table.locator("tbody tr")).toHaveCount(500);
    // The header stays in view while the rows scroll under it.
    await table.evaluate((element) => {
      element.scrollTop = 4000;
    });
    await expect(table.getByRole("columnheader", { name: "region" })).toBeInViewport();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(csvCard).toBeFocused();

    await page.getByRole("button", { name: "Preview plan.md" }).click();
    const frame = page.frameLocator('iframe[title="plan.md"]');
    await expect(frame.getByRole("heading", { name: "Launch plan" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Preview logo.svg" }).click();
    const picture = page.getByRole("dialog", { name: "logo.svg" }).getByRole("img", {
      name: "logo.svg",
    });
    await expect(picture).toBeVisible();
    expect(await picture.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(40);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
