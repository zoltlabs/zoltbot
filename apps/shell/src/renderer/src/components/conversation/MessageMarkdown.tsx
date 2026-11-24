import type { Nodes, Parents, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { createMemo, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { BotProfile } from "../../data";
import { MessageLink, RichMessageText } from "./Transcript";

interface Context {
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  /** Inside a link, text stays plain so a bare address isn't linked twice. */
  inLink?: boolean;
}

/**
 * An agent's message as formatted text. Raw HTML is left out and images show their description,
 * so a message can't load anything; links open through the app, and @agent tags stay buttons.
 */
export function MessageMarkdown(props: Context & { body: string }) {
  const tree = createMemo(() =>
    fromMarkdown(props.body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
  );
  return <div class="message-copy message-markdown">{children(tree(), props)}</div>;
}

function children(node: Parents, context: Context): JSX.Element {
  return <For each={node.children as RootContent[]}>{(child) => render(child, context)}</For>;
}

function render(node: Nodes, context: Context): JSX.Element {
  switch (node.type) {
    case "paragraph":
      return <p>{children(node, context)}</p>;
    case "heading":
      return (
        <Dynamic component={`h${Math.min(node.depth + 2, 6)}`}>{children(node, context)}</Dynamic>
      );
    case "thematicBreak":
      return <hr />;
    case "blockquote":
      return <blockquote>{children(node, context)}</blockquote>;
    case "list":
      return node.ordered ? (
        <ol start={node.start ?? undefined}>{children(node, context)}</ol>
      ) : (
        <ul>{children(node, context)}</ul>
      );
    case "listItem":
      return (
        <li>
          {typeof node.checked === "boolean" ? (
            <input type="checkbox" checked={node.checked} disabled />
          ) : null}
          {node.spread ? (
            children(node, context)
          ) : (
            <For each={node.children}>
              {(child) =>
                child.type === "paragraph" ? children(child, context) : render(child, context)
              }
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
      return <em>{children(node, context)}</em>;
    case "strong":
      return <strong>{children(node, context)}</strong>;
    case "delete":
      return <del>{children(node, context)}</del>;
    case "link":
      return /^(https?:|mailto:)/i.test(node.url) ? (
        <MessageLink url={node.url} onOpenLink={context.onOpenLink}>
          {children(node, { ...context, inLink: true })}
        </MessageLink>
      ) : (
        children(node, context)
      );
    case "image":
      return <span>[{node.alt || "Image"}]</span>;
    case "break":
      return <br />;
    case "text":
      if (context.inLink) return node.value;
      return (
        <RichMessageText
          body={node.value}
          bots={context.bots}
          onSelectAgent={context.onSelectAgent}
          onOpenLink={context.onOpenLink}
        />
      );
    case "table":
      return (
        <div class="message-markdown-table">
          <table>
            <tbody>
              <For each={node.children}>
                {(row, index) => (
                  <tr>
                    <For each={row.children}>
                      {(cell) => (
                        <Show when={index() === 0} fallback={<td>{children(cell, context)}</td>}>
                          <th scope="col">{children(cell, context)}</th>
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
    case "html":
      return node.value;
    default:
      return "children" in node ? children(node as Parents, context) : null;
  }
}
