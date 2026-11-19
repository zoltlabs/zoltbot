import type { Nodes, Parents, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const style = `<style>
:root{color-scheme:light dark}
body{margin:0;padding:20px 24px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}
article>:first-child{margin-top:0}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.4em 0 .5em}
pre{padding:12px;border-radius:6px;overflow-x:auto;background:color-mix(in srgb,currentColor 7%,transparent)}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
:not(pre)>code{padding:.1em .3em;border-radius:4px;background:color-mix(in srgb,currentColor 9%,transparent)}
blockquote{margin:0;padding-left:12px;border-left:3px solid color-mix(in srgb,currentColor 25%,transparent);opacity:.85}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{padding:4px 10px;border:1px solid color-mix(in srgb,currentColor 20%,transparent)}
hr{border:0;border-top:1px solid color-mix(in srgb,currentColor 20%,transparent)}
.link{text-decoration:underline;text-decoration-style:dotted}
</style>`;

/**
 * Renders Markdown to static HTML for the scriptless artifact frame. Raw HTML is dropped, links
 * become plain text and images show their alt text, so nothing in the output loads or navigates.
 */
export function artifactMarkdownHtml(value: string) {
  const tree = fromMarkdown(value, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return `${style}<article>${children(tree)}</article>`;
}

function children(node: Parents, tight = false): string {
  return node.children.map((child) => render(child, tight)).join("");
}

function render(node: Nodes | RootContent, tight = false): string {
  switch (node.type) {
    case "root":
      return children(node);
    case "paragraph":
      return tight ? children(node) : `<p>${children(node)}</p>`;
    case "heading":
      return `<h${node.depth}>${children(node)}</h${node.depth}>`;
    case "thematicBreak":
      return "<hr>";
    case "blockquote":
      return `<blockquote>${children(node)}</blockquote>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start =
        node.ordered && typeof node.start === "number" && node.start !== 1
          ? ` start="${Math.trunc(node.start)}"`
          : "";
      return `<${tag}${start}>${node.children.map((item) => render(item, !node.spread)).join("")}</${tag}>`;
    }
    case "listItem": {
      const box =
        typeof node.checked === "boolean"
          ? `<input type="checkbox" disabled${node.checked ? " checked" : ""}> `
          : "";
      return `<li>${box}${children(node, tight && !node.spread)}</li>`;
    }
    case "code": {
      const lang = node.lang ? ` class="language-${escapeHtml(node.lang)}"` : "";
      return `<pre><code${lang}>${escapeHtml(node.value)}</code></pre>`;
    }
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "emphasis":
      return `<em>${children(node)}</em>`;
    case "strong":
      return `<strong>${children(node)}</strong>`;
    case "delete":
      return `<del>${children(node)}</del>`;
    case "break":
      return "<br>";
    case "text":
      return escapeHtml(node.value);
    case "link":
    case "linkReference":
      return `<span class="link">${children(node)}</span>`;
    case "image":
    case "imageReference":
      return `<span>${node.alt ? `Image: ${escapeHtml(node.alt)}` : "Image"}</span>`;
    case "table":
      return table(node);
    case "footnoteReference":
      return `<sup>${escapeHtml(node.label ?? node.identifier)}</sup>`;
    case "footnoteDefinition":
      return `<div><sup>${escapeHtml(node.label ?? node.identifier)}</sup> ${children(node, true)}</div>`;
    // Raw HTML and link definitions produce no output.
    default:
      return "";
  }
}

function table(node: Table) {
  const align = node.align ?? [];
  const rows = node.children.map((row, index) => {
    const tag = index === 0 ? "th" : "td";
    const cells = row.children.map((cell, column) => {
      const value = align[column];
      const attribute = value ? ` style="text-align:${value}"` : "";
      return `<${tag}${attribute}>${children(cell)}</${tag}>`;
    });
    return `<tr>${cells.join("")}</tr>`;
  });
  const [head, ...body] = rows;
  return `<table><thead>${head ?? ""}</thead>${body.length ? `<tbody>${body.join("")}</tbody>` : ""}</table>`;
}
