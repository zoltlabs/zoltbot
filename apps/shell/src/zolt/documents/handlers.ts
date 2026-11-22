import { MAX_QUOTE } from "../../shared/document-anchors";
import {
  COMMENT_STATES,
  DOCUMENT_CHANNELS,
  DOCUMENT_LIMITS,
  type DocumentAnchor,
  type DocumentCommentState,
  type DocumentRef,
} from "../../shared/documents";
import { isObject, requireString } from "../parsers";
import type { artifactDocuments } from "./artifacts";
import { documentPath } from "./files";
import type { DocumentsService } from "./service";

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  if (!isObject(value)) throw new Error("Invalid documents request.");
  return value as Row;
}

function ref(value: unknown): DocumentRef {
  const input = row(value);
  return { projectId: requireString(input.projectId, "projectId"), path: documentPath(input.path) };
}

function textField(value: unknown, field: string, limit: number, required = true): string {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  if (required && !value.trim()) throw new Error(`Write a ${field} first.`);
  if (value.length > limit) throw new Error(`Keep the ${field} under ${limit} characters.`);
  return value;
}

function documentText(value: unknown): string {
  if (typeof value !== "string") throw new Error("The document's text is missing.");
  if (value.length > DOCUMENT_LIMITS.bytes) throw new Error("The document is too large.");
  return value;
}

function hashOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return value;
  throw new Error("Invalid document version.");
}

function anchor(value: unknown): DocumentAnchor {
  const input = row(value);
  const quote = textField(input.quote, "quote", MAX_QUOTE);
  const context = (part: unknown) => (typeof part === "string" ? part.slice(0, 64) : "");
  return { quote, prefix: context(input.prefix), suffix: context(input.suffix) };
}

function versionId(value: unknown): string {
  const id = requireString(value, "versionId");
  if (id !== "head" && !/^commit:[a-f0-9]{7,64}$/.test(id) && !/^[\w-]{8,64}$/.test(id))
    throw new Error("Invalid version.");
  return id;
}

/** The renderer's document calls, checked before the service acts on them. */
export function documentHandlers(
  service: DocumentsService,
  artifacts: ReturnType<typeof artifactDocuments>,
): Record<string, (input: unknown) => unknown> {
  const artifactRef = (value: unknown) => {
    const input = row(value);
    return {
      artifactId: requireString(input.artifactId, "artifactId"),
      versionId: requireString(input.versionId, "versionId"),
    };
  };
  return {
    [DOCUMENT_CHANNELS.artifactVersions]: (id) =>
      artifacts.versions(requireString(id, "artifactId")),
    [DOCUMENT_CHANNELS.artifactText]: (input) => artifacts.text(artifactRef(input)),
    [DOCUMENT_CHANNELS.artifactSave]: (input) =>
      artifacts.save({ ...artifactRef(input), path: documentPath(row(input).path) }),
    [DOCUMENT_CHANNELS.documentsList]: (projectId) =>
      service.list(requireString(projectId, "projectId")),
    [DOCUMENT_CHANNELS.documentsOpen]: (input) => service.open(ref(input)),
    [DOCUMENT_CHANNELS.documentsStat]: (input) => service.stat(ref(input)),
    [DOCUMENT_CHANNELS.documentsSave]: (input) => {
      const value = row(input);
      return service.save({
        ...ref(value),
        text: documentText(value.text),
        baseHash: hashOrNull(value.baseHash),
      });
    },
    [DOCUMENT_CHANNELS.documentsCreate]: (input) => {
      const value = row(input);
      return service.create({
        ...ref(value),
        ...(value.text === undefined ? {} : { text: documentText(value.text) }),
      });
    },
    [DOCUMENT_CHANNELS.documentsAddComment]: (input) => {
      const value = row(input);
      return service.addComment({
        ...ref(value),
        anchor: anchor(value.anchor),
        body: textField(value.body, "comment", DOCUMENT_LIMITS.comment),
      });
    },
    [DOCUMENT_CHANNELS.documentsUpdateComment]: (input) => {
      const value = row(input);
      const state = value.state;
      if (state !== undefined && !COMMENT_STATES.includes(state as DocumentCommentState))
        throw new Error("Invalid comment state.");
      return service.updateComment({
        ...ref(value),
        id: requireString(value.id, "id"),
        ...(value.body === undefined
          ? {}
          : { body: textField(value.body, "comment", DOCUMENT_LIMITS.comment) }),
        ...(state === undefined ? {} : { state: state as DocumentCommentState }),
      });
    },
    [DOCUMENT_CHANNELS.documentsDeleteComment]: (input) => {
      const value = row(input);
      return service.deleteComment({ ...ref(value), id: requireString(value.id, "id") });
    },
    [DOCUMENT_CHANNELS.documentsSendComments]: (input) => {
      const value = row(input);
      const ids = value.commentIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 100 ||
        !ids.every((id) => typeof id === "string")
      )
        throw new Error("Choose at least one comment to send.");
      return service.sendComments({
        ...ref(value),
        botId: requireString(value.botId, "botId"),
        commentIds: ids as string[],
        note: textField(value.note ?? "", "note", DOCUMENT_LIMITS.note, false),
      });
    },
    [DOCUMENT_CHANNELS.documentsStartReview]: (input) => {
      const value = row(input);
      return service.startReview({ ...ref(value), versionId: versionId(value.versionId) });
    },
    [DOCUMENT_CHANNELS.documentsSetBaseline]: (input) => {
      const value = row(input);
      return service.setBaseline({ ...ref(value), text: documentText(value.text) });
    },
    [DOCUMENT_CHANNELS.documentsEndReview]: (input) => service.endReview(ref(input)),
    [DOCUMENT_CHANNELS.documentsHistory]: (input) => service.history(ref(input)),
    [DOCUMENT_CHANNELS.documentsVersionText]: (input) => {
      const value = row(input);
      return service.versionText({ ...ref(value), versionId: versionId(value.versionId) });
    },
    [DOCUMENT_CHANNELS.documentsRestore]: (input) => {
      const value = row(input);
      return service.restore({
        ...ref(value),
        versionId: versionId(value.versionId),
        baseHash: hashOrNull(value.baseHash),
      });
    },
    [DOCUMENT_CHANNELS.documentsCommit]: (input) => {
      const value = row(input);
      const paths = value.paths;
      if (!Array.isArray(paths) || !paths.length || paths.length > 200)
        throw new Error("Choose at least one file to commit.");
      const branch =
        value.branch === null || value.branch === undefined || value.branch === ""
          ? null
          : textField(value.branch, "branch name", 200);
      return service.commit({
        projectId: requireString(value.projectId, "projectId"),
        paths: paths.map((path) => documentPath(path)),
        message: textField(value.message, "commit message", DOCUMENT_LIMITS.commitMessage),
        branch: branch?.trim() ?? null,
        push: value.push === true,
      });
    },
    [DOCUMENT_CHANNELS.documentsPush]: (projectId) =>
      service.push(requireString(projectId, "projectId")),
  };
}
