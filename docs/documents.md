# Documents

The Documents page is a Markdown editor for the files in a project's folder, built for writing with agents: a book, a spec or notes kept in git. Open it from the Documents row under a project in the sidebar. The page lives in `apps/shell/src/renderer/src/documents`, and main's side in `apps/shell/src/zolt/documents`.

## How it works

- **Files.** The list shows `.md`, `.markdown` and `.mdx` files in the project's first folder, skipping hidden folders and build output, up to 2,000 files. Main reads and writes them; paths must stay inside the folder and links out of it are refused. Files over 2 MB don't open.
- **Writing.** The editor is CodeMirror with the Markdown parser from `@lezer/markdown`. It saves about a second after typing stops and with ⌘S. A save names the text it started from, so a file changed on disk meanwhile is never overwritten silently: the page asks whether to keep the editor's text or the file's, and both stay in History.
- **Comments.** A comment points at a quoted passage plus a little context on each side, so it finds its passage again after edits elsewhere. Sending comments creates a document task for the chosen agent, in the project's shared folder. Its brief holds the file's absolute path, each quote and comment, and an optional note. Comments sent while that task waits for review go back to the agent as review feedback on the same task.
- **Review.** Sending comments records the text as it is then as the review's baseline, in the shell and in the daemon. When the file changes on disk, the page reloads it and the Review tab shows the difference word by word. Accepting a change moves the baseline to the new words; rejecting one writes the old words back to the file. Finishing the review accepts the document task. You can also review everything since the last commit or since a version in History.
- **Tasks and the phone.** A document task carries the file's path (`task.document`). When it waits for review, the Documents row in the sidebar counts it and it appears in Tasks › Needs you, where choosing it opens the document. On the phone, choosing it in Tasks shows the changes word by word from `document.changes`, with Accept and Send back.
- **History.** The shell keeps a version when someone else changes the file, before comments are sent, before a restore and, at most every 10 minutes, as you save. History lists them with the file's git commits.
- **Git.** Commit and push run the `git` command in the project folder with your own configuration and credentials. A pull request opens GitHub's compare page in the browser; nothing is posted for you.
- **Artifacts.** The artifact panel can show earlier versions. For Markdown artifacts it compares a version with the one before it and saves a version into the project as a new document.

## Where data lives

Comments, review baselines and kept versions are stored in the shell's data folder (`<data folder>/shell/documents`), never in the repository. Comments stay on this Mac.

For each document task the daemon keeps the file's text from before the agent started in `<daemon data folder>/document-reviews/<task id>.json`, with the file's absolute path. `task.create` refuses a document outside the projects' folders. `document.changes` returns that text and the file as it is now, which is how the phone shows the changes.

## Known limits

- An agent must edit the file in the project's folder for its changes to appear in Review. Work an agent does in a separate task worktree arrives when that work is merged.
- Only the project's first folder is listed.
- Comments made on one Mac aren't shared with collaborators. Put shared notes in the repository instead.
- The phone reviews document tasks but can't add comments yet.
- All comments sent at once must fit in a task brief of 4,000 characters.
- The editor works on Markdown source. Preview shows the formatted document, but it can't be edited directly.

## Checks

`pnpm --filter @zoltbot/shell test` covers the diff, anchors and main's document service against a real daemon and git repository. `packages/daemon/src/document-reviews.test.ts` covers document tasks in the daemon. `pnpm test:shipping` includes `apps/shell/e2e/shipping/documents.spec.ts` and `document-artifacts.spec.ts`, which run the whole flow headless with axe in both themes.
