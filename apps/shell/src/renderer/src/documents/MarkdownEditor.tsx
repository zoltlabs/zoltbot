import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import {
  type CommentRange,
  editorExtensions,
  insertLink,
  setCommentRanges,
  toggleLinePrefix,
  toggleWrap,
} from "./editor-setup";

export type FormatAction = "bold" | "italic" | "heading" | "quote" | "list" | "link";

export interface EditorHandle {
  format: (action: FormatAction) => void;
  select: (from: number, to: number) => void;
  focus: () => void;
  /** Where `pos` is drawn, relative to the editor's box; null when it's scrolled out of view. */
  coordsAt: (pos: number) => { top: number; left: number; bottom: number } | null;
}

interface MarkdownEditorProps {
  text: string;
  /** Changes when the editor must take `text` as its new content. */
  loadCount: number;
  comments: CommentRange[];
  activeComment: string | null;
  onChange: (text: string) => void;
  onSelection: (from: number, to: number) => void;
  onCommentClick: (id: string) => void;
  onSave: () => void;
  onComment: () => void;
  onScroll?: () => void;
  ref: (handle: EditorHandle) => void;
}

/** The Markdown source editor: plain text with Markdown marks styled, wrapped like prose. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  const format = (action: FormatAction) => {
    if (!view) return;
    if (action === "bold") toggleWrap(view, "**");
    else if (action === "italic") toggleWrap(view, "*");
    else if (action === "heading") toggleLinePrefix(view, "## ");
    else if (action === "quote") toggleLinePrefix(view, "> ");
    else if (action === "list") toggleLinePrefix(view, "- ");
    else insertLink(view);
  };

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.text,
        extensions: editorExtensions({
          onChange: (value) => props.onChange(value),
          onSelection: (from, to) => props.onSelection(from, to),
          onCommentClick: (id) => props.onCommentClick(id),
          onScroll: () => props.onScroll?.(),
          extraKeys: [
            {
              key: "Mod-s",
              run: () => {
                props.onSave();
                return true;
              },
              preventDefault: true,
            },
            { key: "Mod-b", run: (target) => toggleWrap(target, "**") },
            { key: "Mod-i", run: (target) => toggleWrap(target, "*") },
            { key: "Mod-k", run: (target) => insertLink(target) },
            {
              key: "Mod-Alt-m",
              run: () => {
                props.onComment();
                return true;
              },
              preventDefault: true,
            },
          ],
        }),
      }),
    });
    props.ref({
      format,
      focus: () => view?.focus(),
      coordsAt(pos) {
        const point = view?.coordsAtPos(Math.min(pos, view.state.doc.length));
        const box = host?.getBoundingClientRect();
        if (!point || !box || point.bottom < box.top || point.top > box.bottom) return null;
        return {
          top: point.top - box.top,
          bottom: point.bottom - box.top,
          left: point.left - box.left,
        };
      },
      select(from, to) {
        if (!view) return;
        const length = view.state.doc.length;
        view.dispatch({
          selection: EditorSelection.range(Math.min(from, length), Math.min(to, length)),
          effects: EditorView.scrollIntoView(Math.min(from, length), { y: "center" }),
        });
        view.focus();
      },
    });
    onCleanup(() => view?.destroy());
  });

  createEffect(
    on(
      () => props.loadCount,
      () => {
        if (!view || view.state.doc.toString() === props.text) return;
        const selection = view.state.selection.main;
        const length = props.text.length;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: props.text },
          selection: EditorSelection.range(
            Math.min(selection.anchor, length),
            Math.min(selection.head, length),
          ),
        });
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const ranges = props.comments;
    const active = props.activeComment;
    view?.dispatch({ effects: setCommentRanges.of({ ranges, active }) });
  });

  return <div ref={host} class="doc-editor" />;
}
