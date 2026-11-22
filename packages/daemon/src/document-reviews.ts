// A document task edits one Markdown file in a project folder. The daemon keeps the file's text
// from before the agent started, so the Mac and the phone can both show what the agent changed.
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DomainState } from "@zoltbot/core";
import { ProjectSchema, parse, TASK_DOCUMENT_MAX_TEXT } from "@zoltbot/protocol";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

interface DocumentReview {
  path: string;
  file: string;
  before: string;
}

export interface DocumentChanges {
  path: string;
  before: string;
  /** Null when the file is gone or too large to show. */
  after: string | null;
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function documentReviews(dataDir: string) {
  const folder = path.join(dataDir, "document-reviews");
  const fileOf = (taskId: string) => path.join(folder, `${taskId.replace(/[^\w.-]/g, "_")}.json`);

  return {
    /**
     * Checks that `file` is a Markdown file inside one of the projects' folders and returns its
     * real path. Throws `document_outside_project` otherwise.
     */
    async check(state: DomainState, input: { path: string; file: string }): Promise<string> {
      if (!MARKDOWN.test(input.file) || !path.isAbsolute(input.file))
        throw new Error("document_outside_project");
      const real = await realpath(input.file).catch(() => {
        throw new Error("document_outside_project");
      });
      const roots = await Promise.all(
        (state.project ?? []).flatMap((row) =>
          parse(ProjectSchema, row).roots.map((root) => realpath(root.path).catch(() => null)),
        ),
      );
      const root = roots.find((value): value is string => !!value && inside(value, real));
      if (!root || path.relative(root, real).split(path.sep).join("/") !== input.path)
        throw new Error("document_outside_project");
      return real;
    },

    async save(taskId: string, review: DocumentReview): Promise<void> {
      await mkdir(folder, { recursive: true });
      const target = fileOf(taskId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(review), { mode: 0o600 });
      await rename(temporary, target);
    },

    async changes(taskId: string): Promise<DocumentChanges> {
      const raw = await readFile(fileOf(taskId), "utf8").catch(() => {
        throw new Error("not_found: this task has no document");
      });
      const review = JSON.parse(raw) as DocumentReview;
      const after = await readFile(review.file, "utf8").catch(() => null);
      return {
        path: review.path,
        before: review.before,
        after: after !== null && after.length <= TASK_DOCUMENT_MAX_TEXT ? after : null,
      };
    },
  };
}

export type DocumentReviews = ReturnType<typeof documentReviews>;
