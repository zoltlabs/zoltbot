import { batch, createSignal, onCleanup } from "solid-js";
import {
  DOCUMENT_CONFLICT,
  type DocumentAnchor,
  type DocumentComment,
  type DocumentCommentState,
  type DocumentsOverview,
  type OpenDocument,
} from "../../../shared/documents";
import { t } from "../i18n";

export type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";
export type DocumentMode = "write" | "preview" | "review" | "history";
/** Work a panel runs on the open document, showing the error if it fails. */
export type DocumentWork = () => Promise<void>;

const AUTOSAVE_MS = 800;
const POLL_MS = 2000;
const LIST_POLL_MS = 15_000;

export const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors thrown in main with where they came from.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
};

/**
 * One project's documents and the one open in the editor. The editor's text saves itself shortly
 * after typing stops; a file that changes on disk reloads when nothing is unsaved, and otherwise
 * stops autosave and asks which version to keep.
 */
export function createDocumentsStore(projectId: () => string | null) {
  const api = () => window.openbot.documents;
  const [overview, setOverview] = createSignal<DocumentsOverview | null>(null);
  const [listError, setListError] = createSignal<string | null>(null);
  const [document, setDocument] = createSignal<OpenDocument | null>(null);
  const [opening, setOpening] = createSignal<string | null>(null);
  const [openError, setOpenError] = createSignal<string | null>(null);
  const [text, setText] = createSignal("");
  /** The hash of the text the editor last loaded or saved. */
  const [baseHash, setBaseHash] = createSignal<string | null>(null);
  const [saveState, setSaveState] = createSignal<SaveState>("saved");
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<DocumentMode>("write");
  /** A new version arrived from outside while the review shows; the person may want to look. */
  const [externalChange, setExternalChange] = createSignal<string | null>(null);
  /** Bumped when the editor must replace its content with `text()`. */
  const [loadCount, setLoadCount] = createSignal(0);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | null = null;
  let polling = false;

  async function refreshList() {
    const id = projectId();
    if (!id) return;
    try {
      const next = await api().list(id);
      if (projectId() === id) {
        setOverview(next);
        setListError(null);
      }
    } catch (error) {
      if (projectId() === id) setListError(errorText(error));
    }
  }

  function load(next: OpenDocument) {
    batch(() => {
      setDocument(next);
      setText(next.text);
      setBaseHash(next.hash);
      setSaveState("saved");
      setSaveError(null);
      setLoadCount((count) => count + 1);
    });
  }

  async function open(path: string) {
    const id = projectId();
    if (!id) return;
    await flush();
    setOpening(path);
    setOpenError(null);
    try {
      const next = await api().open({ projectId: id, path });
      if (opening() !== path) return;
      batch(() => {
        load(next);
        setExternalChange(null);
        setMode(next.review?.changedAt ? "review" : "write");
      });
    } catch (error) {
      if (opening() === path) setOpenError(errorText(error));
    } finally {
      if (opening() === path) setOpening(null);
    }
  }

  function close() {
    void flush();
    batch(() => {
      setDocument(null);
      setText("");
      setBaseHash(null);
      setExternalChange(null);
    });
  }

  /** Called by the editor on every change. */
  function edit(value: string) {
    if (value === text()) return;
    setText(value);
    if (saveState() === "conflict") return;
    setSaveState("unsaved");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), AUTOSAVE_MS);
  }

  async function save(force = false): Promise<void> {
    clearTimeout(saveTimer);
    const current = document();
    if (!current) return;
    if (saving) await saving;
    if (saveState() === "saved" && !force) return;
    if (saveState() === "conflict" && !force) return;
    const value = text();
    setSaveState("saving");
    saving = (async () => {
      try {
        const result = await api().save({
          projectId: current.projectId,
          path: current.path,
          text: value,
          baseHash: force ? null : baseHash(),
        });
        if (document()?.path !== current.path) return;
        batch(() => {
          setBaseHash(result.hash);
          setDocument({ ...current, ...result, text: value });
          setSaveState(text() === value ? "saved" : "unsaved");
          setSaveError(null);
        });
        if (text() !== value) saveTimer = setTimeout(() => void save(), AUTOSAVE_MS);
      } catch (error) {
        const message = errorText(error);
        if (message.includes(DOCUMENT_CONFLICT)) setSaveState("conflict");
        else {
          setSaveState("error");
          setSaveError(message);
        }
      }
    })();
    await saving;
    saving = null;
  }

  /** Saves what's unsaved now, before the editor moves on. */
  async function flush() {
    if (saveState() === "unsaved") await save();
    else if (saving) await saving;
  }

  /** Keeps the editor's text and overwrites the file; the file's text is already a version. */
  async function keepMine() {
    await save(true);
  }

  /** Drops the editor's unsaved text and loads the file as it is on disk. */
  async function useFile() {
    const current = document();
    if (!current) return;
    load(await api().open({ projectId: current.projectId, path: current.path }));
  }

  async function poll() {
    const current = document();
    if (!current || polling || saving || globalThis.document.hidden) return;
    polling = true;
    try {
      const stat = await api().stat({ projectId: current.projectId, path: current.path });
      if (document()?.path !== current.path || stat.hash === baseHash() || saving) return;
      if (saveState() === "unsaved" || saveState() === "conflict") {
        clearTimeout(saveTimer);
        setSaveState("conflict");
        return;
      }
      const next = await api().open({ projectId: current.projectId, path: current.path });
      if (document()?.path !== current.path) return;
      load(next);
      if (next.review) setExternalChange(next.review.botName);
    } catch {
      // The next poll tries again; a file that vanished shows its error when reopened.
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => void poll(), POLL_MS);
  const listTimer = setInterval(() => void refreshList(), LIST_POLL_MS);
  const onFocus = () => {
    void poll();
    void refreshList();
  };
  window.addEventListener("focus", onFocus);
  onCleanup(() => {
    clearInterval(timer);
    clearInterval(listTimer);
    window.removeEventListener("focus", onFocus);
    void flush();
  });

  const ref = () => {
    const current = document();
    if (!current) throw new Error(t("documents.openFirst"));
    return { projectId: current.projectId, path: current.path };
  };

  const setComments = (comments: DocumentComment[]) =>
    setDocument((current) => (current ? { ...current, comments } : current));

  return {
    overview,
    listError,
    refreshList,
    document,
    opening,
    openError,
    open,
    close,
    text,
    edit,
    save,
    flush,
    saveState,
    saveError,
    keepMine,
    useFile,
    mode,
    setMode,
    loadCount,
    externalChange,
    clearExternalChange: () => setExternalChange(null),
    /** Replaces the open document with a newer view from main, such as after a review step. */
    load,
    /** Replaces the editor's text and saves it at once, as rejecting a change does. */
    async replace(value: string) {
      batch(() => {
        setText(value);
        setLoadCount((count) => count + 1);
        setSaveState("unsaved");
      });
      await save();
    },
    async create(path: string) {
      const id = projectId();
      if (!id) return;
      await flush();
      const next = await api().create({ projectId: id, path });
      load(next);
      setMode("write");
      await refreshList();
    },
    async addComment(anchor: DocumentAnchor, body: string) {
      setComments(await api().addComment({ ...ref(), anchor, body }));
    },
    async updateComment(id: string, change: { body?: string; state?: DocumentCommentState }) {
      setComments(await api().updateComment({ ...ref(), id, ...change }));
    },
    async deleteComment(id: string) {
      setComments(await api().deleteComment({ ...ref(), id }));
    },
    async sendComments(botId: string, commentIds: string[], note: string) {
      await flush();
      load(await api().sendComments({ ...ref(), botId, commentIds, note }));
      void refreshList();
    },
  };
}

export type DocumentsStore = ReturnType<typeof createDocumentsStore>;
