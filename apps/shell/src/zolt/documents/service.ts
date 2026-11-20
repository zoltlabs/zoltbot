import { randomUUID } from "node:crypto";
import { stat as statFile } from "node:fs/promises";
import { basename, posix } from "node:path";
import { locateAnchor } from "../../shared/document-anchors";
import {
  type AddCommentInput,
  type CommitDocumentsInput,
  type CommitResult,
  type CreateDocumentInput,
  DOCUMENT_CONFLICT,
  type DocumentComment,
  type DocumentRef,
  type DocumentStat,
  type DocumentsOverview,
  type DocumentVersion,
  type OpenDocument,
  type RestoreVersionInput,
  type SaveDocumentInput,
  type SendCommentsInput,
  type SetBaselineInput,
  type UpdateCommentInput,
  type VersionTextInput,
} from "../../shared/documents";
import type { SendMessageInput } from "../../shared/ipc";
import type { DaemonClient } from "../daemon-client";
import { text as asText } from "../mapping";
import { listDocuments, readDocument, resolveInRoot, writeDocument } from "./files";
import { committedText, fileLog, git, gitStatus, gitSummary, gitTop, textAtCommit } from "./git";
import { commentsMessage } from "./message";
import { type DocumentState, DocumentStore } from "./store";

export interface DocumentChat {
  send: (input: SendMessageInput) => Promise<unknown>;
  /** The chat's name, or null when it doesn't exist. */
  name: (botId: string) => string | null;
}

/**
 * Reads and writes a project's Markdown files for the Documents page, and keeps comments, review
 * baselines and earlier versions in the shell's data folder.
 */
export class DocumentsService {
  private readonly store: DocumentStore;

  constructor(
    private readonly client: DaemonClient,
    dataPath: string,
    private readonly chat: DocumentChat,
  ) {
    this.store = new DocumentStore(dataPath);
  }

  /** The project and its first folder; documents live in that folder. */
  private project(projectId: string): { name: string; root: string | null } {
    const row = this.client.rows("project").find((project) => project.id === projectId);
    if (!row || row.archived === true) throw new Error("That project isn't available.");
    const roots = Array.isArray(row.roots) ? (row.roots as Array<{ path?: unknown }>) : [];
    const root = roots.map((entry) => asText(entry?.path)).find(Boolean) ?? null;
    return { name: asText(row.name) || "Project", root };
  }

  private root(projectId: string): string {
    const { root } = this.project(projectId);
    if (!root) throw new Error("This project has no folder. Documents live in a project's folder.");
    return root;
  }

  async list(projectId: string): Promise<DocumentsOverview> {
    const { name, root } = this.project(projectId);
    if (!root)
      return { projectId, projectName: name, root: null, files: [], truncated: false, git: null };
    try {
      await statFile(root);
    } catch {
      throw new Error("The project's folder isn't on this Mac anymore.");
    }
    const [{ files, truncated }, top] = await Promise.all([listDocuments(root), gitTop(root)]);
    const states = top ? await gitStatus(root).catch(() => new Map()) : new Map();
    const stored = await this.store.readMany(
      projectId,
      files.map((file) => file.path),
    );
    const rows = files.map((file) => {
      const state = stored.get(file.path);
      return {
        path: file.path,
        name: basename(file.path),
        folder: posix.dirname(file.path) === "." ? "" : posix.dirname(file.path),
        size: file.size,
        modifiedAt: file.modifiedAt,
        git: states.get(file.path) ?? null,
        openComments: state?.comments.filter((comment) => comment.state !== "resolved").length ?? 0,
        reviewing: Boolean(state?.review),
      };
    });
    const changed = rows.filter((row) => row.git).length;
    return {
      projectId,
      projectName: name,
      root,
      files: rows,
      truncated,
      git: top ? await gitSummary(root, changed) : null,
    };
  }

  /**
   * Reads the file and notices changes made outside the editor: the earlier text becomes a
   * version, the new text another, and sent comments whose passage changed count as addressed.
   */
  private async sync(ref: DocumentRef, state: DocumentState) {
    const file = await resolveInRoot(this.root(ref.projectId), ref.path);
    const disk = await readDocument(file);
    if (state.knownHash !== disk.hash) {
      if (state.knownHash) {
        try {
          const previous = await this.store.getText(ref.projectId, state.knownHash);
          await this.store.addVersion(ref.projectId, state, previous, "saved", "You");
        } catch {}
        await this.store.addVersion(
          ref.projectId,
          state,
          disk.text,
          "outside",
          state.review?.botName ?? "Outside Zoltbot",
        );
        if (state.review) state.review.changedAt = new Date().toISOString();
        const now = new Date().toISOString();
        for (const comment of state.comments)
          if (comment.state === "sent" && !locateAnchor(disk.text, comment.anchor)) {
            comment.state = "addressed";
            comment.updatedAt = now;
          }
      }
      state.knownHash = await this.store.putText(ref.projectId, disk.text);
    }
    return { file, ...disk };
  }

  private async view(
    ref: DocumentRef,
    state: DocumentState,
    disk: { text: string } & DocumentStat,
  ): Promise<OpenDocument> {
    const root = this.root(ref.projectId);
    const top = await gitTop(root);
    const gitState = top
      ? ((await gitStatus(root).catch(() => new Map())).get(ref.path) ?? null)
      : null;
    let baseline: string | null = null;
    if (state.review) {
      try {
        baseline = await this.store.getText(ref.projectId, state.review.baselineHash);
      } catch {
        state.review = null;
      }
    }
    return {
      projectId: ref.projectId,
      path: ref.path,
      text: disk.text,
      hash: disk.hash,
      modifiedAt: disk.modifiedAt,
      comments: state.comments,
      review: state.review
        ? {
            botId: state.review.botId,
            botName: state.review.botName,
            startedAt: state.review.startedAt,
            changedAt: state.review.changedAt ?? null,
          }
        : null,
      baseline,
      git: gitState,
      committed: top ? (await committedText(root, ref.path)) !== null : false,
    };
  }

  open(ref: DocumentRef): Promise<OpenDocument> {
    return this.store.update(ref.projectId, ref.path, async (state) =>
      this.view(ref, state, await this.sync(ref, state)),
    );
  }

  stat(ref: DocumentRef): Promise<DocumentStat> {
    return this.store.update(ref.projectId, ref.path, async (state) => {
      const { hash, modifiedAt } = await this.sync(ref, state);
      return { hash, modifiedAt };
    });
  }

  save(input: SaveDocumentInput): Promise<DocumentStat> {
    return this.store.update(input.projectId, input.path, async (state) => {
      const file = await resolveInRoot(this.root(input.projectId), input.path);
      const disk = await readDocument(file);
      if (input.baseHash !== null && disk.hash !== input.baseHash) {
        // Keep what's on disk as a version before the person decides what to do about it.
        await this.sync(input, state);
        throw new Error(DOCUMENT_CONFLICT);
      }
      const written = await writeDocument(file, input.text);
      state.knownHash = await this.store.putText(input.projectId, input.text);
      await this.store.addVersion(input.projectId, state, input.text, "saved", "You");
      return written;
    });
  }

  async create(input: CreateDocumentInput): Promise<OpenDocument> {
    const file = await resolveInRoot(this.root(input.projectId), input.path, false);
    try {
      await statFile(file);
      throw new Error("A file with that name already exists.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const title = basename(input.path).replace(/\.(md|markdown|mdx)$/i, "");
    await writeDocument(file, input.text ?? `# ${title}\n\n`);
    return this.open(input);
  }

  addComment(input: AddCommentInput): Promise<DocumentComment[]> {
    return this.store.update(input.projectId, input.path, (state) => {
      const now = new Date().toISOString();
      state.comments.push({
        id: randomUUID(),
        anchor: input.anchor,
        body: input.body.trim(),
        state: "draft",
        sentTo: null,
        sentAt: null,
        createdAt: now,
        updatedAt: now,
      });
      if (state.comments.length > 500) throw new Error("Resolve some comments before adding more.");
      return state.comments;
    });
  }

  updateComment(input: UpdateCommentInput): Promise<DocumentComment[]> {
    return this.store.update(input.projectId, input.path, (state) => {
      const comment = state.comments.find((row) => row.id === input.id);
      if (!comment) throw new Error("That comment isn't there anymore.");
      if (input.body !== undefined) comment.body = input.body.trim();
      if (input.state) comment.state = input.state;
      comment.updatedAt = new Date().toISOString();
      return state.comments;
    });
  }

  deleteComment(input: DocumentRef & { id: string }): Promise<DocumentComment[]> {
    return this.store.update(input.projectId, input.path, (state) => {
      state.comments = state.comments.filter((row) => row.id !== input.id);
      return state.comments;
    });
  }

  async sendComments(input: SendCommentsInput): Promise<OpenDocument> {
    const name = this.chat.name(input.botId);
    if (!name) throw new Error("That chat isn't available.");
    const root = this.root(input.projectId);
    const file = await resolveInRoot(root, input.path);
    const state = await this.store.read(input.projectId, input.path);
    const comments = input.commentIds
      .map((id) => state.comments.find((comment) => comment.id === id))
      .filter((comment): comment is DocumentComment => Boolean(comment))
      .filter((comment) => comment.state !== "resolved");
    if (!comments.length) throw new Error("Choose at least one comment to send.");
    await this.chat.send({
      botId: input.botId,
      text: commentsMessage({ path: input.path, absolutePath: file, comments, note: input.note }),
    });
    return this.store.update(input.projectId, input.path, async (current) => {
      const disk = await this.sync(input, current);
      const now = new Date().toISOString();
      for (const comment of current.comments)
        if (input.commentIds.includes(comment.id) && comment.state !== "resolved") {
          comment.state = "sent";
          comment.sentTo = { botId: input.botId, name };
          comment.sentAt = now;
          comment.updatedAt = now;
        }
      await this.store.addVersion(input.projectId, current, disk.text, "before-send", "You");
      // A review already under way keeps its baseline, so earlier changes stay pending.
      if (!current.review)
        current.review = {
          botId: input.botId,
          botName: name,
          startedAt: now,
          changedAt: null,
          baselineHash: await this.store.putText(input.projectId, disk.text),
        };
      else {
        current.review.botId = input.botId;
        current.review.botName = name;
      }
      return this.view(input, current, disk);
    });
  }

  startReview(input: VersionTextInput): Promise<OpenDocument> {
    return this.store.update(input.projectId, input.path, async (state) => {
      const disk = await this.sync(input, state);
      const text = await this.versionTextFor(input, state);
      const label =
        input.versionId === "head"
          ? "the last commit"
          : input.versionId.startsWith("commit:")
            ? "a commit"
            : "an earlier version";
      state.review = {
        botId: null,
        botName: `Changes since ${label}`,
        startedAt: new Date().toISOString(),
        changedAt: new Date().toISOString(),
        baselineHash: await this.store.putText(input.projectId, text),
      };
      return this.view(input, state, disk);
    });
  }

  setBaseline(input: SetBaselineInput): Promise<OpenDocument> {
    return this.store.update(input.projectId, input.path, async (state) => {
      const disk = await this.sync(input, state);
      if (!state.review) throw new Error("This document has no changes to review.");
      state.review.baselineHash = await this.store.putText(input.projectId, input.text);
      return this.view(input, state, disk);
    });
  }

  endReview(ref: DocumentRef): Promise<OpenDocument> {
    return this.store.update(ref.projectId, ref.path, async (state) => {
      const disk = await this.sync(ref, state);
      state.review = null;
      return this.view(ref, state, disk);
    });
  }

  async history(ref: DocumentRef): Promise<DocumentVersion[]> {
    const root = this.root(ref.projectId);
    const state = await this.store.read(ref.projectId, ref.path);
    const local: DocumentVersion[] = state.versions.map((version) => ({
      id: version.id,
      kind: version.kind,
      author: version.author,
      message: "",
      at: version.at,
    }));
    const commits: DocumentVersion[] = (await fileLog(root, ref.path)).map((commit) => ({
      id: `commit:${commit.sha}`,
      kind: "commit",
      author: commit.author,
      message: commit.message,
      at: commit.at,
    }));
    return [...local, ...commits].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  private async versionTextFor(input: VersionTextInput, state: DocumentState): Promise<string> {
    const root = this.root(input.projectId);
    if (input.versionId === "head") {
      const text = await committedText(root, input.path);
      if (text === null) throw new Error("This file hasn't been committed yet.");
      return text;
    }
    if (input.versionId.startsWith("commit:"))
      return textAtCommit(root, input.versionId.slice(7), input.path);
    const version = state.versions.find((row) => row.id === input.versionId);
    if (!version) throw new Error("That version isn't available anymore.");
    return this.store.getText(input.projectId, version.hash);
  }

  async versionText(input: VersionTextInput): Promise<string> {
    return this.versionTextFor(input, await this.store.read(input.projectId, input.path));
  }

  restore(input: RestoreVersionInput): Promise<OpenDocument> {
    return this.store.update(input.projectId, input.path, async (state) => {
      const disk = await this.sync(input, state);
      if (input.baseHash !== null && disk.hash !== input.baseHash)
        throw new Error(DOCUMENT_CONFLICT);
      const text = await this.versionTextFor(input, state);
      await this.store.addVersion(input.projectId, state, disk.text, "before-restore", "You");
      const written = await writeDocument(disk.file, text);
      state.knownHash = await this.store.putText(input.projectId, text);
      await this.store.addVersion(input.projectId, state, text, "saved", "You");
      return this.view(input, state, { text, ...written });
    });
  }

  async commit(input: CommitDocumentsInput): Promise<CommitResult> {
    const root = this.root(input.projectId);
    if (!(await gitTop(root))) throw new Error("The project folder isn't a git repository.");
    for (const path of input.paths) await resolveInRoot(root, path, false);
    if (input.branch) {
      await git(root, ["check-ref-format", "--branch", input.branch]).catch(() => {
        throw new Error("Branch names can't contain spaces or characters like ~ ^ : ? * [");
      });
      await git(root, ["switch", "-c", input.branch]);
    }
    await git(root, ["add", "--", ...input.paths]);
    await git(root, ["commit", "-m", input.message, "--", ...input.paths]);
    const commit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    if (!input.push) {
      const summary = await gitSummary(root, 0);
      return {
        commit,
        branch: summary?.branch ?? null,
        pushed: false,
        pullRequestUrl: summary?.pullRequestUrl ?? null,
      };
    }
    return { ...(await this.push(input.projectId)), commit };
  }

  async push(projectId: string): Promise<CommitResult> {
    const root = this.root(projectId);
    await git(root, ["push", "-u", "origin", "HEAD"], 90_000).catch((error: Error) => {
      throw new Error(`Couldn't push: ${error.message.split("\n").slice(-3).join(" ")}`);
    });
    const summary = await gitSummary(root, 0);
    const commit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    return {
      commit,
      branch: summary?.branch ?? null,
      pushed: true,
      pullRequestUrl: summary?.pullRequestUrl ?? null,
    };
  }
}
