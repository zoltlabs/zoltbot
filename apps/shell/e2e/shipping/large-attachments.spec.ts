import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { serveAttachments } from "../attachment-route";
import { chooseFiles } from "../bridge";
import { axeViolations, shellSession } from "../harness";

/** A stored ZIP holding the named files, each `size` bytes once unpacked. */
function zip(files: { name: string; size: number }[]) {
  const central: Buffer[] = [];
  for (const file of files) {
    const name = Buffer.from(file.name);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(file.size, 24);
    entry.writeUInt16LE(name.length, 28);
    central.push(entry, name);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  return Buffer.concat([directory, end]);
}

test("a ZIP is listed, not unpacked, and a file over 100 MB isn't attached", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  const dir = await mkdtemp(join(tmpdir(), "large-attachments-"));
  try {
    const archive = join(dir, "site.zip");
    await writeFile(
      archive,
      zip([
        { name: "index.html", size: 2048 },
        { name: "assets/app.js", size: 3 * 1024 * 1024 },
      ]),
    );
    // Sparse, so the test writes almost nothing to disk.
    const huge = join(dir, "recording.mov");
    await writeFile(huge, "");
    await truncate(huge, 100 * 1024 * 1024 + 1);
    const bot = await shell.service.createBot({ profileId: "profile", title: "Bundles" });
    await shell.open(page);
    await serveAttachments(page, shell.service);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Bundles/ })
      .click();

    chooseFiles([huge]);
    await page.getByRole("button", { name: "Attach a file" }).click();
    await page.getByRole("menuitem", { name: "Attach files" }).click();
    await expect(
      page.getByText("recording.mov is over 100 MB, so it wasn't attached."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove recording.mov" })).toHaveCount(0);

    await shell.rpc.call(
      "turn.send",
      {
        threadId: bot.id,
        input: [
          { type: "text", text: "The site" },
          { type: "file", path: archive },
        ],
        mode: "queue",
      },
      "send-zip",
    );
    const card = page.getByRole("button", { name: "Preview site.zip" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0, {
      timeout: 15_000,
    });
    await card.click();
    const dialog = page.getByRole("dialog", { name: "site.zip" });
    const list = dialog.getByRole("region", { name: "site.zip" });
    await expect(list.getByRole("cell", { name: "assets/app.js" })).toBeVisible();
    await expect(list.getByRole("cell", { name: "3.0 MB" })).toBeVisible();
    await expect(dialog.getByText("2 files, 3.0 MB unpacked")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(card).toBeFocused();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
