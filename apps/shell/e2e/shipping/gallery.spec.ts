import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { serveAttachments } from "../attachment-route";
import { axeViolations, shellSession } from "../harness";

// 1×1 PNGs in three colors, so each picture is a different file.
const PNG = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOIDnoBAAKhAZa4oNmsAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN4UREEAAP+AbPvdKhfAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIOtEDAAMWAaf+ZS0xAAAAAElFTkSuQmCC",
];

test("pictures in a chat open in one viewer that moves by keyboard", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  const dir = await mkdtemp(join(tmpdir(), "gallery-"));
  try {
    const paths = await Promise.all(
      ["first.png", "second.png", "third.png"].map(async (name, i) => {
        const path = join(dir, name);
        await writeFile(path, Buffer.from(PNG[i] as string, "base64"));
        return path;
      }),
    );
    const notes = join(dir, "notes.csv");
    await writeFile(notes, "a,b\n1,2\n");
    const bot = await shell.service.createBot({ profileId: "profile", title: "Pictures" });
    await shell.open(page);
    await serveAttachments(page, shell.service);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: /^Pictures/ })
      .click();
    // Two messages, so the viewer gathers pictures from the whole chat, not one message.
    for (const [key, input] of [
      [
        "one",
        [
          { type: "file", path: paths[0] },
          { type: "file", path: notes },
        ],
      ],
      [
        "two",
        [
          { type: "file", path: paths[1] },
          { type: "file", path: paths[2] },
        ],
      ],
    ] as const) {
      await shell.rpc.call(
        "turn.send",
        { threadId: bot.id, input: [{ type: "text", text: key }, ...input], mode: "queue" },
        `send-${key}`,
      );
      await expect(page.getByRole("button", { name: "Stop agent" })).toHaveCount(0, {
        timeout: 15_000,
      });
    }

    const second = page.getByRole("button", { name: "Preview second.png" });
    await expect(second).toBeVisible({ timeout: 15_000 });
    await second.click();
    const viewer = page.getByRole("dialog", { name: "second.png" });
    await expect(viewer.getByText("2 of 3", { exact: true })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: "third.png" })).toBeVisible();
    await expect(page.getByRole("dialog").getByText("3 of 3", { exact: true })).toBeVisible();
    // The end arrow stays focusable, so focus never drops out of the viewer.
    await expect(page.getByRole("button", { name: "Next picture" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const first = page.getByRole("dialog", { name: "first.png" });
    await expect(first.getByRole("img", { name: "first.png" })).toBeVisible();

    // Zoom by keyboard; while zoomed, arrows scroll instead of moving.
    await page.keyboard.press("=");
    await expect(first.getByRole("button", { name: "Fit to window" })).toHaveText("200%");
    await page.keyboard.press("ArrowRight");
    await expect(first).toBeVisible();
    await page.keyboard.press("0");
    await expect(first.getByRole("button", { name: "Actual size" })).toHaveText("100%");

    await first.getByRole("button", { name: "Copy" }).click();
    await expect(page.getByText("Copied picture")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(second).toBeFocused();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
