// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedMarkdownArtifact } from "../../../../../tools/fakes/src/artifact-seed";
import { compareFixture } from "../../../../../tools/fakes/src/compare-fixture";
import { anchorFor } from "../../shared/document-anchors";
import { DOCUMENT_CONFLICT } from "../../shared/documents";
import { DaemonClient } from "../daemon-client";
import { ZoltService } from "../zolt-service";
import { documentPath } from "./files";
import { pullRequestUrl } from "./git";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });

const CHAPTER = "# The storm\n\nThe rain fell like a curtain.\nShe waited by the door.\n";

async function setup() {
  // Artifact saves refuse folders reached through a symlink, such as macOS's /var.
  const book = realpathSync(mkdtempSync(join(tmpdir(), "zoltbot-book-")));
  const origin = mkdtempSync(join(tmpdir(), "zoltbot-origin-"));
  run(origin, "init", "--bare", "-q", "-b", "main");
  run(book, "init", "-q", "-b", "main");
  run(book, "config", "user.name", "Writer");
  run(book, "config", "user.email", "writer@example.test");
  mkdirSync(join(book, "chapters"));
  mkdirSync(join(book, ".hidden"));
  writeFileSync(join(book, "chapters", "03-storm.md"), CHAPTER);
  writeFileSync(join(book, "README.md"), "# Book\n");
  writeFileSync(join(book, "notes.txt"), "not markdown");
  writeFileSync(join(book, ".hidden", "secret.md"), "# hidden");
  run(book, "add", ".");
  run(book, "commit", "-q", "-m", "First draft");
  run(book, "remote", "add", "origin", origin);
  run(book, "push", "-q", "-u", "origin", "main");

  const fixture = await compareFixture();
  const client = new DaemonClient(async () => ({
    url: fixture.daemon.url,
    token: fixture.daemon.token,
  }));
  const service = new ZoltService(client, mkdtempSync(join(tmpdir(), "zoltbot-shell-")));
  cleanups.push(async () => {
    await service.stop();
    await fixture.close();
  });
  await service.initialize();
  const ceo = await service.createProject(book);
  const projectId = ceo.projectId as string;
  return { service, documents: service.documents, book, origin, projectId, ceo, fixture };
}

describe("DocumentsService", () => {
  it("lists Markdown files in the project folder with git state", async () => {
    const { documents, projectId, book } = await setup();
    writeFileSync(join(book, "chapters", "04-calm.md"), "# Calm\n");
    const overview = await documents.list(projectId);
    expect(overview.files.map((file) => file.path)).toEqual([
      "chapters/03-storm.md",
      "chapters/04-calm.md",
      "README.md",
    ]);
    expect(overview.files.find((file) => file.path === "chapters/04-calm.md")?.git).toBe(
      "untracked",
    );
    expect(overview.git).toMatchObject({ branch: "main", changed: 1, ahead: 0 });
  });

  it("saves with conflict checks and keeps the text changed on disk as a version", async () => {
    const { documents, projectId, book } = await setup();
    const ref = { projectId, path: "chapters/03-storm.md" };
    const opened = await documents.open(ref);
    expect(opened.text).toBe(CHAPTER);
    expect(opened.committed).toBe(true);
    const saved = await documents.save({
      ...ref,
      text: `${CHAPTER}More.\n`,
      baseHash: opened.hash,
    });
    expect(readFileSync(join(book, ref.path), "utf8")).toBe(`${CHAPTER}More.\n`);

    writeFileSync(join(book, ref.path), "Someone else's text.\n");
    await expect(documents.save({ ...ref, text: "Mine.\n", baseHash: saved.hash })).rejects.toThrow(
      DOCUMENT_CONFLICT,
    );
    const history = await documents.history(ref);
    expect(history.map((version) => version.kind)).toEqual(["outside", "saved", "commit"]);
    expect(await documents.versionText({ ...ref, versionId: history[1].id })).toBe(
      `${CHAPTER}More.\n`,
    );
    expect(await documents.versionText({ ...ref, versionId: "head" })).toBe(CHAPTER);
  });

  it("sends comments to a chat, notices the agent's edit and reviews it", async () => {
    const { service, documents, projectId, book, ceo } = await setup();
    const ref = { projectId, path: "chapters/03-storm.md" };
    const from = CHAPTER.indexOf("fell like a curtain");
    let comments = await documents.addComment({
      ...ref,
      anchor: anchorFor(CHAPTER, from, from + "fell like a curtain".length),
      body: "Too familiar. Find a fresher image.",
    });
    const door = CHAPTER.indexOf("door");
    comments = await documents.addComment({
      ...ref,
      anchor: anchorFor(CHAPTER, door, door + 4),
      body: "Which door?",
    });
    expect(comments.map((comment) => comment.state)).toEqual(["draft", "draft"]);

    const sent = await documents.sendComments({
      ...ref,
      botId: ceo.id,
      commentIds: comments.map((comment) => comment.id),
      note: "Keep it short.",
    });
    expect(sent.review).toMatchObject({ botId: ceo.id, changedAt: null });
    expect(sent.baseline).toBe(CHAPTER);
    expect(sent.comments.every((comment) => comment.state === "sent")).toBe(true);
    // The comments become a document task, and the daemon keeps the text from before.
    const client = (service as unknown as { client: DaemonClient }).client;
    await vi.waitFor(() =>
      expect(client.rows("task").find((row) => row.title === "Edit 03-storm.md")).toBeDefined(),
    );
    const task = client.rows("task").find((row) => row.title === "Edit 03-storm.md");
    expect(task?.document).toEqual({ path: ref.path });
    expect(task?.workspaceMode).toBe("shared");
    const brief = String(task?.brief);
    expect(brief).toContain("Please revise `chapters/03-storm.md`");
    expect(brief).toContain("1. On “fell like a curtain”:");
    expect(brief).toContain("Too familiar. Find a fresher image.");
    expect(brief).toContain(join(book, "chapters", "03-storm.md").replace(/^\/private/, ""));
    expect(await client.call("document.changes", { id: task?.id })).toMatchObject({
      path: ref.path,
      before: CHAPTER,
    });

    // The agent edits the file in place.
    const edited = CHAPTER.replace("fell like a curtain", "came down in sheets");
    writeFileSync(join(book, ref.path), edited);
    const stat = await documents.stat(ref);
    const reopened = await documents.open(ref);
    expect(reopened.hash).toBe(stat.hash);
    expect(reopened.review?.changedAt).not.toBeNull();
    expect(reopened.comments.map((comment) => comment.state)).toEqual(["addressed", "sent"]);
    const history = await documents.history(ref);
    expect(history[0]).toMatchObject({ kind: "outside", author: ceo.name });

    // Accepting moves the baseline to the agent's text; ending the review clears it.
    const accepted = await documents.setBaseline({ ...ref, text: edited });
    expect(accepted.baseline).toBe(edited);
    const ended = await documents.endReview(ref);
    expect(ended.review).toBeNull();
    const overview = await documents.list(projectId);
    expect(overview.files.find((file) => file.path === ref.path)).toMatchObject({
      git: "modified",
      openComments: 2,
      reviewing: false,
    });
  });

  it("reviews changes since the last commit and restores an earlier version", async () => {
    const { documents, projectId, book } = await setup();
    const ref = { projectId, path: "chapters/03-storm.md" };
    writeFileSync(join(book, ref.path), CHAPTER.replace("door", "window"));
    const review = await documents.startReview({ ...ref, versionId: "head" });
    expect(review.baseline).toBe(CHAPTER);
    const restored = await documents.restore({ ...ref, versionId: "head", baseHash: review.hash });
    expect(restored.text).toBe(CHAPTER);
    expect(readFileSync(join(book, ref.path), "utf8")).toBe(CHAPTER);
    const kinds = (await documents.history(ref)).map((version) => version.kind);
    expect(kinds).toContain("before-restore");
  });

  it("creates a document, commits it on a new branch and pushes", async () => {
    const { documents, projectId, book, origin } = await setup();
    await documents.create({ projectId, path: "chapters/05-after.md" });
    expect(readFileSync(join(book, "chapters/05-after.md"), "utf8")).toBe("# 05-after\n\n");
    await expect(documents.create({ projectId, path: "chapters/05-after.md" })).rejects.toThrow(
      "already exists",
    );
    const result = await documents.commit({
      projectId,
      paths: ["chapters/05-after.md"],
      message: "Add chapter 5",
      branch: "chapter-5",
      push: true,
    });
    expect(result).toMatchObject({ branch: "chapter-5", pushed: true });
    expect(run(origin, "log", "--format=%s", "-1", "chapter-5").trim()).toBe("Add chapter 5");
    const overview = await documents.list(projectId);
    expect(overview.git).toMatchObject({ branch: "chapter-5", changed: 0, ahead: 0 });
    await expect(
      documents.commit({
        projectId,
        paths: ["README.md"],
        message: "x",
        branch: "bad name",
        push: false,
      }),
    ).rejects.toThrow("Branch names");
  });

  it("refuses paths outside the folder, hidden files, links and other file types", async () => {
    const { documents, projectId, book } = await setup();
    for (const path of ["../escape.md", "/etc/passwd.md", ".hidden/secret.md", "notes.txt", ""])
      expect(() => documentPath(path)).toThrow();
    symlinkSync(join(tmpdir()), join(book, "linked"));
    await expect(documents.open({ projectId, path: "linked/x.md" })).rejects.toThrow();
  });
});

describe("pullRequestUrl", () => {
  it("points at GitHub's compare page for a branch", () => {
    expect(pullRequestUrl("git@github.com:acme/book.git", "draft-2", "main")).toBe(
      "https://github.com/acme/book/compare/draft-2?expand=1",
    );
    expect(pullRequestUrl("https://github.com/acme/book", "draft-2", "main")).toBe(
      "https://github.com/acme/book/compare/draft-2?expand=1",
    );
    expect(pullRequestUrl("https://github.com/acme/book.git", "main", "main")).toBeNull();
    expect(pullRequestUrl("https://gitlab.com/acme/book.git", "draft", "main")).toBeNull();
  });
});

describe("artifact documents", () => {
  it("lists versions, reads each as Markdown and saves one into the project", async () => {
    const { service, projectId, book, fixture } = await setup();
    const [first, second] = await seedMarkdownArtifact(fixture.daemon.store, {
      projectId,
      workspace: book,
      title: "Book outline",
      texts: ["# Outline\n\nPart one.\n", "# Outline\n\nPart one, revised.\n"],
    });
    expect(second.artifactId).toBe(first.artifactId);
    const versions = await service.artifactTexts.versions(first.artifactId);
    expect(versions).toMatchObject({ projectId, markdown: true });
    expect(versions.versions.map((version) => version.number)).toEqual([2, 1]);
    expect(await service.artifactTexts.text(first)).toBe("# Outline\n\nPart one.\n");
    expect(await service.artifactTexts.text(second)).toBe("# Outline\n\nPart one, revised.\n");

    const saved = await service.artifactTexts.save({ ...second, path: "notes/outline.md" });
    expect(saved).toEqual({ projectId, path: "notes/outline.md" });
    expect(readFileSync(join(book, "notes/outline.md"), "utf8")).toBe(
      "# Outline\n\nPart one, revised.\n",
    );
    await expect(
      service.artifactTexts.save({ ...second, path: "notes/outline.md" }),
    ).rejects.toThrow("already exists");
  });
});
