# Documents

The Documents page is a Markdown editor for the files in a project's folder, built for writing with agents: a book, a spec or notes kept in git. Open it from the Documents row under a project in the sidebar. The page lives in `apps/shell/src/renderer/src/documents`, and main's side in `apps/shell/src/zolt/documents`.

## How it works

- **Files.** The list shows `.md`, `.markdown` and `.mdx` files in the project's first folder, skipping hidden folders and build output, up to 2,000 files. Main reads and writes them; paths must stay inside the folder and links out of it are refused. Files over 2 MB don't open.
- **Writing.** The editor is CodeMirror with the Markdown parser from `@lezer/markdown`. It saves about a second after typing stops and with ⌘S. A save names the text it started from, so a file changed on disk meanwhile is never overwritten silently: the page asks whether to keep the editor's text or the file's, and both stay in History.
- **Comments.** A comment points at a quoted passage plus a little context on each side, so it finds its passage again after edits elsewhere. Sending comments posts one message to the chosen chat with the file's absolute path, each quote and comment, and an optional note.
- **Review.** Sending comments records the text as it is then as the review's baseline. When the file changes on disk, the page reloads it and the Review tab shows the difference word by word. Accepting a change moves the baseline to the new words; rejecting one writes the old words back to the file. You can also review everything since the last commit or since a version in History.
- **History.** The shell keeps a version when someone else changes the file, before comments are sent, before a restore and, at most every 10 minutes, as you save. History lists them with the file's git commits.
- **Git.** Commit and push run the `git` command in the project folder with your own configuration and credentials. A pull request opens GitHub's compare page in the browser; nothing is posted for you.
- **Artifacts.** The artifact panel can show earlier versions. For Markdown artifacts it compares a version with the one before it and saves a version into the project as a new document.

## Where data lives

Comments, review baselines and kept versions are stored in the shell's data folder (`<data folder>/shell/documents`), never in the repository and never in the daemon. They stay on this Mac and don't reach the phone.

## Known limits

- An agent must edit the file in the project's folder for its changes to appear in Review. Work an agent does in a separate task worktree arrives when that work is merged.
- Only the project's first folder is listed.
- Comments made on one Mac aren't shared with collaborators. Put shared notes in the repository instead.
- The editor works on Markdown source. Preview shows the formatted document, but it can't be edited directly.

## Checks

`pnpm --filter @zoltbot/shell test` covers the diff, anchors and main's document service against a real daemon and git repository. `pnpm test:shipping` includes `apps/shell/e2e/shipping/documents.spec.ts` and `document-artifacts.spec.ts`, which run the whole flow headless with axe in both themes.
