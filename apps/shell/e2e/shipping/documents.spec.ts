import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, shellSession } from "../harness";

const CHAPTER = [
  "# The storm",
  "",
  "The rain fell like a curtain over the harbour.",
  "",
  "She waited by the door until the lamps went out.",
  "",
].join("\n");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });

/** A book in a git repository with a remote, the way a writer keeps one on GitHub. */
function book() {
  const folder = mkdtempSync(join(tmpdir(), "zoltbot-book-"));
  const origin = mkdtempSync(join(tmpdir(), "zoltbot-origin-"));
  git(origin, "init", "--bare", "-q", "-b", "main");
  git(folder, "init", "-q", "-b", "main");
  git(folder, "config", "user.name", "Writer");
  git(folder, "config", "user.email", "writer@example.test");
  mkdirSync(join(folder, "chapters"));
  writeFileSync(join(folder, "chapters", "01-harbour.md"), "# The harbour\n\nIt was calm.\n");
  writeFileSync(join(folder, "chapters", "03-storm.md"), CHAPTER);
  writeFileSync(join(folder, "README.md"), "# A book\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "First draft");
  git(folder, "remote", "add", "origin", origin);
  git(folder, "push", "-q", "-u", "origin", "main");
  return { folder, origin };
}

/** Selects `phrase` in the editor the way a mouse drag would. */
async function selectText(page: Page, phrase: string) {
  await page.evaluate((target) => {
    const content = document.querySelector(".cm-content");
    if (!content) throw new Error("No editor");
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(target) ?? -1;
      if (index < 0) continue;
      (content as HTMLElement).focus();
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + target.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`"${target}" isn't in the editor`);
  }, phrase);
}

const shots = (name: string) => `../../output/playwright/shell/documents-${name}.png`;

test("write, comment, send to an agent, review its changes, look back and commit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { folder, origin } = book();
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const ceo = await shell.service.createProject(folder);
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    const projectName = ceo.projectName;
    await sidebar.getByRole("button", { name: `Documents in ${projectName}` }).click();

    const documents = page.getByRole("main", { name: "Documents" });
    await expect(
      documents.getByRole("heading", { name: `Documents · ${projectName}` }),
    ).toBeFocused();
    const files = documents.getByRole("navigation", { name: `Documents in ${projectName}` });
    await expect(files.getByRole("button", { name: /03-storm\.md/ })).toBeVisible();
    await expect(files.getByRole("button")).toHaveCount(4); // New and three files
    await expect(documents.getByText("Choose a document to start writing.")).toBeVisible();
    await expect(documents.getByRole("button", { name: "No changes to commit" })).toBeDisabled();

    // Write: typing saves on its own.
    await files.getByRole("button", { name: /03-storm\.md/ }).click();
    const editor = documents.getByRole("textbox", { name: "Document text" });
    await expect(editor).toContainText("The rain fell like a curtain");
    await expect(documents.getByRole("tab", { name: "Write", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("The sea kept its secrets.");
    await expect(documents.locator(".doc-save-state")).toHaveText("Saved");
    expect(readFileSync(join(folder, "chapters/03-storm.md"), "utf8")).toContain(
      "The sea kept its secrets.",
    );
    await expect(files.getByRole("button", { name: /03-storm\.md.*Modified/ })).toBeVisible();

    // Formatting: bold the selection with the toolbar.
    await selectText(page, "secrets");
    await documents.getByRole("button", { name: "Bold" }).click();
    await expect(editor).toContainText("**secrets**");

    // Comment on a passage.
    await selectText(page, "fell like a curtain");
    await expect(
      documents.getByRole("button", { name: "Comment", exact: true }).first(),
    ).toBeEnabled();
    await page.keyboard.press("ControlOrMeta+Alt+m");
    const comments = documents.getByRole("region", { name: "Comments" });
    await comments
      .getByRole("textbox", { name: "Comment" })
      .fill("Too familiar. Find a fresher image.");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(comments.getByText("Too familiar. Find a fresher image.")).toBeVisible();
    await expect(comments.getByText("Draft", { exact: true })).toBeVisible();
    await expect(documents.locator(".cm-comment")).toHaveText("fell like a curtain");

    // A second comment, from the toolbar button.
    await selectText(page, "until the lamps went out");
    await documents.locator(".doc-toolbar").getByRole("button", { name: "Comment" }).click();
    await comments.getByRole("textbox", { name: "Comment" }).fill("Tighten this.");
    await comments.getByRole("button", { name: "Add comment" }).click();
    await expect(comments.getByRole("listitem")).toHaveCount(2);
    await page.screenshot({ path: shots("write") });
    expect(await axeViolations(page)).toEqual([]);

    // Send both to the CEO.
    await comments.getByRole("button", { name: "Send 2 to an agent" }).click();
    const send = page.getByRole("dialog", { name: "Send comments to an agent" });
    await expect(send.getByRole("checkbox")).toHaveCount(2);
    await expect(send.getByLabel("Send to")).toHaveValue(ceo.id);
    await send.getByLabel("Note for the agent (optional)").fill("Keep the rhythm.");
    await page.screenshot({ path: shots("send") });
    expect(await axeViolations(page)).toEqual([]);
    await send.getByRole("button", { name: "Send 2 comments" }).click();
    await expect(send).toBeHidden();
    await expect(documents.getByText(`Sent to ${ceo.name}.`, { exact: false })).toBeVisible();
    await expect(comments.getByText(`Sent to ${ceo.name}`)).toHaveCount(2);
    const conversation = await shell.service.readConversation(ceo.id);
    const message = conversation.messages.find((row) => row.author === "user")?.text ?? "";
    expect(message).toContain("Please revise `chapters/03-storm.md`");
    expect(message).toContain("Too familiar. Find a fresher image.");
    expect(message).toContain("Keep the rhythm.");

    // Review waits for the agent.
    await documents.getByRole("tab", { name: "Review", exact: true }).click();
    await expect(
      documents.getByText(`Waiting for ${ceo.name} to change the document.`, { exact: false }),
    ).toBeVisible();

    // The agent edits the file in place.
    await documents.getByRole("tab", { name: "Write", exact: true }).click();
    const written = readFileSync(join(folder, "chapters/03-storm.md"), "utf8");
    writeFileSync(
      join(folder, "chapters/03-storm.md"),
      written
        .replace("fell like a curtain", "came down in sheets")
        .replace("until the lamps went out", "till the lamps died"),
    );
    const banner = documents.getByRole("status").filter({ hasText: "changed this document" });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(editor).toContainText("came down in sheets");
    await expect(comments.getByText("Addressed", { exact: true })).toHaveCount(2);
    await banner.getByRole("button", { name: "Review changes" }).click();

    const review = documents.getByRole("region", { name: `Changes by ${ceo.name}` });
    await expect(documents.getByRole("tab", { name: /Review.*2 changes/ })).toBeVisible();
    await expect(review.getByText("Change 1 of 2")).toBeVisible();
    await expect(
      review.getByText("Replaced “fell like a curtain” with “came down in sheets”"),
    ).toBeVisible();
    await page.screenshot({ path: shots("review") });
    expect(await axeViolations(page)).toEqual([]);

    // Accept the first with the button, move on with J, reject the second with R.
    await review.getByRole("button", { name: "Accept" }).click();
    await expect(review.getByText("Change 1 of 1")).toBeVisible();
    await expect(
      review.getByText("Replaced “until the lamps went out” with “till the lamps died”"),
    ).toBeVisible();
    await review.getByRole("document").focus();
    await page.keyboard.press("r");
    await expect(documents.getByText("You've reviewed every change.")).toBeVisible();
    await expect(documents.locator(".doc-save-state")).toHaveText("Saved");
    const reviewed = readFileSync(join(folder, "chapters/03-storm.md"), "utf8");
    expect(reviewed).toContain("came down in sheets");
    expect(reviewed).toContain("until the lamps went out");
    await documents.getByRole("button", { name: "Finish review" }).click();
    await expect(documents.getByText("No changes are waiting for review.")).toBeVisible();

    // History: compare the agent's version with now, and back out of restoring it.
    await documents.getByRole("tab", { name: "History", exact: true }).click();
    const versions = documents.getByRole("navigation", { name: "Versions" });
    await versions.getByRole("button", { name: new RegExp(`Changed by ${ceo.name}`) }).click();
    await expect(documents.getByRole("region", { name: /Differences between/ })).toContainText(
      "till the lamps died",
    );
    await versions.getByRole("button", { name: /First draft/ }).click();
    await documents.getByRole("button", { name: "Restore this version" }).click();
    const restore = page.getByRole("dialog", { name: "Restore this version?" });
    await expect(restore.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.screenshot({ path: shots("history") });
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(restore).toBeHidden();

    // Preview shows the chapter as a reader sees it.
    await documents.getByRole("tab", { name: "Preview", exact: true }).click();
    const preview = documents.getByRole("article", { name: "Preview of chapters/03-storm.md" });
    await expect(preview.getByRole("heading", { name: "The storm" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("secrets");

    // Commit on a new branch and push it.
    await documents.getByRole("button", { name: "Commit 1 change" }).click();
    const commit = page.getByRole("dialog", { name: "Commit changes" });
    await expect(commit.getByLabel("Commit message")).toHaveValue("Update 03-storm");
    await expect(commit.getByRole("radio", { name: "Commit to a new branch" })).toBeChecked();
    await commit.getByLabel("New branch name").fill("storm-revisions");
    await page.screenshot({ path: shots("commit") });
    expect(await axeViolations(page)).toEqual([]);
    await commit.getByRole("button", { name: "Commit and push" }).click();
    const done = page.getByRole("dialog", { name: "Committed" });
    await expect(done.getByText("to storm-revisions and pushed it.", { exact: false })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    expect(git(origin, "log", "-1", "--format=%s", "storm-revisions").trim()).toBe(
      "Update 03-storm",
    );
    await done.getByRole("button", { name: "Done" }).click();
    await expect(documents.getByRole("button", { name: "No changes to commit" })).toBeVisible();
    await expect(documents.getByText("storm-revisions")).toBeVisible();

    // A new document.
    await files.getByRole("button", { name: "New" }).click();
    await files.getByLabel("File name").fill("chapters/04-calm");
    await files.getByRole("button", { name: "Create" }).click();
    await expect(documents.getByRole("heading", { name: "chapters/04-calm.md" })).toBeVisible();
    await expect(files.getByRole("button", { name: /04-calm\.md.*New/ })).toBeVisible();

    // Narrow windows stack the panes without scrolling sideways.
    await page.setViewportSize({ width: 680, height: 820 });
    await files.getByRole("button", { name: /03-storm\.md/ }).click();
    await expect(editor).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: shots("narrow") });

    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});

test("a file changed on disk while there are unsaved edits asks which version to keep", async ({
  page,
}) => {
  const { folder } = book();
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  try {
    const ceo = await shell.service.createProject(folder);
    await shell.open(page);
    await page
      .getByRole("complementary", { name: "Bot navigation" })
      .getByRole("button", { name: `Documents in ${ceo.projectName}` })
      .click();
    const documents = page.getByRole("main", { name: "Documents" });
    await documents.getByRole("button", { name: /01-harbour\.md/ }).click();
    const editor = documents.getByRole("textbox", { name: "Document text" });
    await expect(editor).toContainText("It was calm.");
    // Hold autosave back by changing the file before the editor's first save lands.
    await page.evaluate(() => {
      const api = (window as unknown as { openbot: { documents: { save: unknown } } }).openbot
        .documents;
      const save = api.save as (input: unknown) => Promise<unknown>;
      api.save = async (input: unknown) => {
        await new Promise((done) => setTimeout(done, 3000));
        return save(input);
      };
    });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Mine.");
    writeFileSync(join(folder, "chapters/01-harbour.md"), "# The harbour\n\nTheirs.\n");
    const conflict = documents.getByRole("alert").filter({ hasText: "changed outside the editor" });
    await expect(conflict).toBeVisible({ timeout: 10_000 });
    await expect(documents.locator(".doc-save-state")).toHaveText("Not saved");
    expect(await axeViolations(page)).toEqual([]);
    await conflict.getByRole("button", { name: "Keep my version" }).click();
    await expect(documents.locator(".doc-save-state")).toHaveText("Saved", { timeout: 10_000 });
    expect(readFileSync(join(folder, "chapters/01-harbour.md"), "utf8")).toContain("Mine.");
    await documents.getByRole("tab", { name: "History", exact: true }).click();
    await expect(
      documents
        .getByRole("navigation", { name: "Versions" })
        .getByRole("button", { name: /Changed by Outside Zoltbot/ }),
    ).toBeVisible();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
