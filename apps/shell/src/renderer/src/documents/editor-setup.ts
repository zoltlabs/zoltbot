import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  defineLanguageFacet,
  HighlightStyle,
  Language,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  EditorSelection,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { GFM, parser } from "@lezer/markdown";

/**
 * Markdown with GitHub's extensions, built from the parser alone. The full language package also
 * loads HTML, CSS and JavaScript grammars for embedded code, which prose doesn't need.
 */
const markdownLanguage = new Language(
  defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } }),
  parser.configure(GFM),
  [],
  "markdown",
);

/** A comment's place in the editor's text. */
export interface CommentRange {
  id: string;
  from: number;
  to: number;
}

export const setCommentRanges = StateEffect.define<{
  ranges: CommentRange[];
  active: string | null;
}>();

const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setCommentRanges)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      const length = transaction.state.doc.length;
      for (const range of [...effect.value.ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
        const from = Math.min(range.from, length);
        const to = Math.min(range.to, length);
        if (to <= from) continue;
        builder.add(
          from,
          to,
          Decoration.mark({
            class: range.id === effect.value.active ? "cm-comment cm-comment-active" : "cm-comment",
            attributes: { "data-comment-id": range.id },
          }),
        );
      }
      next = builder.finish();
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Markdown marks as classes, so documents.css colors them from the theme's tokens. */
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "md-heading md-h1" },
  { tag: tags.heading2, class: "md-heading md-h2" },
  { tag: tags.heading3, class: "md-heading md-h3" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: "md-heading" },
  { tag: tags.emphasis, class: "md-emphasis" },
  { tag: tags.strong, class: "md-strong" },
  { tag: tags.strikethrough, class: "md-strike" },
  { tag: [tags.link, tags.url], class: "md-link" },
  { tag: tags.quote, class: "md-quote" },
  { tag: tags.monospace, class: "md-code" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], class: "md-mark" },
  { tag: tags.list, class: "md-list" },
]);

export function editorExtensions(options: {
  onChange: (text: string) => void;
  onSelection: (from: number, to: number) => void;
  onCommentClick: (id: string) => void;
  onScroll: () => void;
  extraKeys: Parameters<typeof keymap.of>[0];
}): Extension[] {
  return [
    history(),
    drawSelection(),
    search({ top: true }),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    markdownLanguage,
    syntaxHighlighting(markdownStyle),
    placeholder("Start writing…"),
    commentField,
    keymap.of([...options.extraKeys, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.contentAttributes.of({
      "aria-label": "Document text",
      "aria-multiline": "true",
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main;
        options.onSelection(range.from, range.to);
      }
    }),
    EditorView.domEventHandlers({
      mousedown(event) {
        const mark = (event.target as HTMLElement | null)?.closest?.("[data-comment-id]");
        const id = mark?.getAttribute("data-comment-id");
        if (id) options.onCommentClick(id);
        return false;
      },
      scroll() {
        options.onScroll();
        return false;
      },
    }),
  ];
}

/** Puts `before` and `after` around the selection, or takes them away when they're there. */
export function toggleWrap(view: EditorView, before: string, after = before): boolean {
  const changes = view.state.changeByRange((range) => {
    const doc = view.state.doc;
    const outer = doc.sliceString(range.from - before.length, range.to + after.length);
    if (
      range.from >= before.length &&
      outer.startsWith(before) &&
      outer.endsWith(after) &&
      outer.length >= before.length + after.length
    ) {
      return {
        changes: [
          { from: range.from - before.length, to: range.from },
          { from: range.to, to: range.to + after.length },
        ],
        range: EditorSelection.range(range.from - before.length, range.to - before.length),
      };
    }
    return {
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    };
  });
  view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

/** Starts each selected line with `prefix`, or removes it when every line already has it. */
export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  const { state } = view;
  const lines = new Set<number>();
  for (const range of state.selection.ranges)
    for (
      let line = state.doc.lineAt(range.from).number;
      line <= state.doc.lineAt(range.to).number;
      line++
    )
      lines.add(line);
  const all = [...lines].map((number) => state.doc.line(number));
  const strip = /^(#{1,6} |> |- |\* |\d+\. )/;
  const has = all.every((line) => line.text.startsWith(prefix));
  view.dispatch({
    changes: all.map((line) => {
      const existing = strip.exec(line.text)?.[0] ?? "";
      return { from: line.from, to: line.from + existing.length, insert: has ? "" : prefix };
    }),
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

/** Turns the selection into a Markdown link and selects the address to type over. */
export function insertLink(view: EditorView): boolean {
  const range = view.state.selection.main;
  const label = view.state.sliceDoc(range.from, range.to) || "link text";
  const insert = `[${label}](https://)`;
  const urlFrom = range.from + label.length + 3;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(urlFrom, urlFrom + "https://".length),
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

/** Counts words the way a writer does: Markdown marks don't count. */
export function wordCount(text: string): number {
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#>*_`~[\]()-]/g, " ")
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu)?.length ?? 0
  );
}
