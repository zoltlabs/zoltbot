import type { Nodes, Parents, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { createMemo, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../i18n";

/**
 * The document as a reader sees it. Raw HTML is left out and images show their description, so a
 * document can't load anything; links show their address on hover and don't navigate.
 */
export function MarkdownPreview(props: { text: string; label: string }) {
  const tree = createMemo(() =>
    fromMarkdown(props.text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
  );
  return (
    <article class="doc-preview" aria-label={props.label}>
      {children(tree())}
    </article>
  );
}

function children(node: Parents): JSX.Element {
  return <For each={node.children as RootContent[]}>{(child) => render(child)}</For>;
}

function render(node: Nodes): JSX.Element {
  switch (node.type) {
    case "paragraph":
      return <p>{children(node)}</p>;
    case "heading":
      return <Dynamic component={`h${Math.min(node.depth + 1, 6)}`}>{children(node)}</Dynamic>;
    case "thematicBreak":
      return <hr />;
    case "blockquote":
      return <blockquote>{children(node)}</blockquote>;
    case "list":
      return node.ordered ? (
        <ol start={node.start ?? undefined}>{children(node)}</ol>
      ) : (
        <ul>{children(node)}</ul>
      );
    case "listItem":
      return (
        <li>
          {typeof node.checked === "boolean" ? (
            <input
              type="checkbox"
              checked={node.checked}
              disabled
              aria-label={
                node.checked ? t("documents.preview.done") : t("documents.preview.notDone")
              }
            />
          ) : null}
          {node.spread ? (
            children(node)
          ) : (
            <For each={node.children}>
              {(child) => (child.type === "paragraph" ? children(child) : render(child))}
            </For>
          )}
        </li>
      );
    case "code":
      return (
        <pre>
          <code>{node.value}</code>
        </pre>
      );
    case "inlineCode":
      return <code>{node.value}</code>;
    case "emphasis":
      return <em>{children(node)}</em>;
    case "strong":
      return <strong>{children(node)}</strong>;
    case "delete":
      return <del>{children(node)}</del>;
    case "link":
      return (
        <span class="doc-preview-link" title={node.url}>
          {children(node)}
        </span>
      );
    case "image":
      return <span class="doc-preview-image">[{node.alt || t("documents.preview.image")}]</span>;
    case "break":
      return <br />;
    case "text":
      return node.value;
    case "table":
      return (
        <div class="doc-preview-table">
          <table>
            <tbody>
              <For each={node.children}>
                {(row, index) => (
                  <tr>
                    <For each={row.children}>
                      {(cell) => (
                        <Show when={index() === 0} fallback={<td>{children(cell)}</td>}>
                          <th scope="col">{children(cell)}</th>
                        </Show>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      );
    case "footnoteReference":
      return <sup>[{node.label ?? node.identifier}]</sup>;
    case "footnoteDefinition":
      return (
        <div class="doc-preview-footnote">
          <sup>[{node.label ?? node.identifier}]</sup> {children(node)}
        </div>
      );
    default:
      return "children" in node ? children(node as Parents) : null;
  }
}
