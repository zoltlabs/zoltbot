import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { expect, test } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { documentReviews } from "./document-reviews.js";
import { taskRunner } from "./task-runner.js";

const owner = { kind: "human", id: "owner" } as const;

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "zoltbot-doc-review-")));
  const book = path.join(home, "book");
  await mkdir(path.join(book, "chapters"), { recursive: true });
  await writeFile(path.join(book, "chapters", "one.md"), "It was a dark night.\n");
  await writeFile(path.join(home, "outside.md"), "Not in the project.\n");
  const f = await runtimeFixture();
  f.store.dispatch("project:book", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "project",
        value: {
          id: "book",
          name: "Book",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [{ path: book, label: "Book" }],
          hierarchyDepth: 1,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      },
      { commandId: "project:book", at, actor: owner },
    ),
  );
  const documents = documentReviews(path.join(home, "data"));
  const runner = taskRunner({
    store: f.store,
    documents,
    publish() {},
    checkPublic: async () => () => {},
  });
  const create = (document: { path: string; file: string; before: string }, id = document.path) =>
    runner.api(
      "task.create",
      {
        title: "Edit one.md",
        brief: "Tighten the opening.",
        profileId: "profile",
        node: { type: "project", id: "book" },
        workspaceMode: "shared",
        document,
      },
      `create:${id}`,
    ) as Promise<{ id: string; document?: { path: string } }>;
  return {
    book,
    home,
    documents,
    create,
    async close() {
      runner.close();
      f.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("a document task keeps the text from before and shows the file as it is now", async () => {
  const { book, documents, create, close } = await fixture();
  try {
    const file = path.join(book, "chapters", "one.md");
    const task = await create({ path: "chapters/one.md", file, before: "It was a dark night.\n" });
    expect(task.document).toEqual({ path: "chapters/one.md" });

    await writeFile(file, "It was a dark and stormy night.\n");
    expect(await documents.changes(task.id)).toEqual({
      path: "chapters/one.md",
      before: "It was a dark night.\n",
      after: "It was a dark and stormy night.\n",
    });

    await rm(file);
    expect((await documents.changes(task.id)).after).toBeNull();
  } finally {
    await close();
  }
});

test("a document task refuses files outside the project or with the wrong path", async () => {
  const { book, home, create, close } = await fixture();
  try {
    await expect(
      create({ path: "outside.md", file: path.join(home, "outside.md"), before: "" }),
    ).rejects.toThrow("document_outside_project");
    await expect(
      create(
        { path: "two.md", file: path.join(book, "chapters", "one.md"), before: "" },
        "wrong-path",
      ),
    ).rejects.toThrow("document_outside_project");
  } finally {
    await close();
  }
});

test("a task without a document has no document changes", async () => {
  const { documents, close } = await fixture();
  try {
    await expect(documents.changes("task-missing")).rejects.toThrow("not_found");
  } finally {
    await close();
  }
});
