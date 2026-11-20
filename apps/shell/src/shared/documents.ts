/**
 * Documents: Markdown files in a project's folder that the person writes in and reviews with
 * agents. Main reads and writes the files; comments, review baselines and saved versions live in
 * the shell's own data folder, never in the repository.
 */

/** How git sees a file, or null when it is unchanged or the folder isn't a git repository. */
export type DocumentGitState = "modified" | "added" | "untracked" | "deleted" | "renamed";

export interface DocumentFile {
  /** Relative to the project folder, with forward slashes. */
  path: string;
  name: string;
  /** The folder part of `path`, empty at the top. */
  folder: string;
  size: number;
  modifiedAt: string;
  git: DocumentGitState | null;
  /** Comments not yet resolved: drafts, sent and addressed. */
  openComments: number;
  /** An agent's changes wait for the person's review. */
  reviewing: boolean;
}

export interface DocumentsGit {
  branch: string | null;
  defaultBranch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed Markdown files, the ones a commit here would include. */
  changed: number;
  /** Where to open a pull request for this branch, when the remote is on GitHub. */
  pullRequestUrl: string | null;
}

export interface DocumentsOverview {
  projectId: string;
  projectName: string;
  /** The project's folder; null when the project has none. */
  root: string | null;
  files: DocumentFile[];
  /** More files exist than the list holds. */
  truncated: boolean;
  /** Null when the folder isn't a git repository or git isn't installed. */
  git: DocumentsGit | null;
}

/** Where a comment points: the quoted text and a little context on each side. */
export interface DocumentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export const COMMENT_STATES = ["draft", "sent", "addressed", "resolved"] as const;
export type DocumentCommentState = (typeof COMMENT_STATES)[number];

export interface DocumentComment {
  id: string;
  anchor: DocumentAnchor;
  body: string;
  state: DocumentCommentState;
  /** The chat the comment went to. */
  sentTo: { botId: string; name: string } | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Changes the person hasn't accepted or rejected yet, measured from `baseline`. */
export interface DocumentReview {
  botId: string | null;
  botName: string;
  startedAt: string;
  /** When the file last changed outside the editor during the review; null until it does. */
  changedAt: string | null;
}

export interface DocumentStat {
  hash: string;
  modifiedAt: string;
}

export interface OpenDocument extends DocumentStat {
  projectId: string;
  path: string;
  text: string;
  comments: DocumentComment[];
  review: DocumentReview | null;
  /** The text the review compares against; null without a review. */
  baseline: string | null;
  /** Git's state for this file. */
  git: DocumentGitState | null;
  /** The file is in a git repository and has a committed version. */
  committed: boolean;
}

export type DocumentVersionKind = "saved" | "outside" | "before-send" | "before-restore" | "commit";

export interface DocumentVersion {
  /** A local version id, or `commit:<sha>` for a git commit. */
  id: string;
  kind: DocumentVersionKind;
  /** "You", an agent's name, or the commit's author. */
  author: string;
  /** The commit message; empty for local versions. */
  message: string;
  at: string;
}

export interface DocumentRef {
  projectId: string;
  path: string;
}

export interface SaveDocumentInput extends DocumentRef {
  text: string;
  /** The hash the editor loaded; a different file on disk is a conflict. Null overwrites. */
  baseHash: string | null;
}

export interface CreateDocumentInput extends DocumentRef {
  text?: string;
}

export interface AddCommentInput extends DocumentRef {
  anchor: DocumentAnchor;
  body: string;
}

export interface UpdateCommentInput extends DocumentRef {
  id: string;
  body?: string;
  state?: DocumentCommentState;
}

export interface SendCommentsInput extends DocumentRef {
  botId: string;
  commentIds: string[];
  note: string;
}

export interface SetBaselineInput extends DocumentRef {
  text: string;
}

export interface VersionTextInput extends DocumentRef {
  /** A version id from `history`, or "head" for the last commit. */
  versionId: string;
}

export interface RestoreVersionInput extends VersionTextInput {
  baseHash: string | null;
}

export interface CommitDocumentsInput {
  projectId: string;
  paths: string[];
  message: string;
  /** Create and switch to this branch first; null stays on the current one. */
  branch: string | null;
  push: boolean;
}

export interface CommitResult {
  commit: string;
  branch: string | null;
  pushed: boolean;
  pullRequestUrl: string | null;
}

/** One saved version of an agent's artifact. */
export interface ArtifactVersionView {
  versionId: string;
  number: number;
  /** Null when the version's files aren't on this Mac. */
  manifestHash: string | null;
  /** The profile that made it, when known. */
  by: string | null;
  createdAt: string;
}

export interface ArtifactVersions {
  projectId: string | null;
  /** The version's entry file is Markdown, so it can be compared as text and saved as a document. */
  markdown: boolean;
  /** Newest first. */
  versions: ArtifactVersionView[];
}

export interface ArtifactRef {
  artifactId: string;
  versionId: string;
}

export interface SaveArtifactInput extends ArtifactRef {
  /** Where to save it in the project's folder. */
  path: string;
}

/** The message main throws when the file changed since the editor loaded it. */
export const DOCUMENT_CONFLICT = "document_changed_on_disk";

export const DOCUMENT_EXTENSIONS = [".md", ".markdown", ".mdx"] as const;

export const DOCUMENT_LIMITS = {
  /** Largest file the editor opens. */
  bytes: 2 * 1024 * 1024,
  files: 2000,
  comment: 2000,
  note: 4000,
  commitMessage: 2000,
  versions: 60,
} as const;

export const DOCUMENT_CHANNELS = {
  documentsList: "documents:list",
  documentsOpen: "documents:open",
  documentsStat: "documents:stat",
  documentsSave: "documents:save",
  documentsCreate: "documents:create",
  documentsAddComment: "documents:add-comment",
  documentsUpdateComment: "documents:update-comment",
  documentsDeleteComment: "documents:delete-comment",
  documentsSendComments: "documents:send-comments",
  documentsSetBaseline: "documents:set-baseline",
  documentsEndReview: "documents:end-review",
  documentsStartReview: "documents:start-review",
  documentsHistory: "documents:history",
  documentsVersionText: "documents:version-text",
  documentsRestore: "documents:restore",
  documentsCommit: "documents:commit",
  documentsPush: "documents:push",
  artifactVersions: "artifact:versions",
  artifactText: "artifact:text",
  artifactSave: "artifact:save-document",
} as const;

export interface DocumentsDesktopApi {
  list: (projectId: string) => Promise<DocumentsOverview>;
  open: (input: DocumentRef) => Promise<OpenDocument>;
  /**
   * The file's current hash. When it changed outside the editor, main keeps the earlier text as
   * a version and marks comments on passages that changed as addressed.
   */
  stat: (input: DocumentRef) => Promise<DocumentStat>;
  save: (input: SaveDocumentInput) => Promise<DocumentStat>;
  create: (input: CreateDocumentInput) => Promise<OpenDocument>;
  addComment: (input: AddCommentInput) => Promise<DocumentComment[]>;
  updateComment: (input: UpdateCommentInput) => Promise<DocumentComment[]>;
  deleteComment: (input: DocumentRef & { id: string }) => Promise<DocumentComment[]>;
  /** Sends comments to a chat and starts a review measured from the text as it is now. */
  sendComments: (input: SendCommentsInput) => Promise<OpenDocument>;
  /** Starts a review of changes since the last commit, or since a saved version. */
  startReview: (input: VersionTextInput) => Promise<OpenDocument>;
  /** Moves the review's baseline, which is how accepting a change works. */
  setBaseline: (input: SetBaselineInput) => Promise<OpenDocument>;
  endReview: (input: DocumentRef) => Promise<OpenDocument>;
  history: (input: DocumentRef) => Promise<DocumentVersion[]>;
  versionText: (input: VersionTextInput) => Promise<string>;
  /** Writes an earlier version to the file, keeping the current text as a version first. */
  restore: (input: RestoreVersionInput) => Promise<OpenDocument>;
  commit: (input: CommitDocumentsInput) => Promise<CommitResult>;
  push: (projectId: string) => Promise<CommitResult>;
  /** An artifact's versions, newest first. */
  artifactVersions: (artifactId: string) => Promise<ArtifactVersions>;
  /** The Markdown text of one version of an artifact. */
  artifactText: (input: ArtifactRef) => Promise<string>;
  /** Writes a Markdown artifact's version into its project's folder as a new document. */
  saveArtifact: (input: SaveArtifactInput) => Promise<DocumentRef>;
}
