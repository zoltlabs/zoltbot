import { expect, it } from "vitest";
import { artifactMarkdownHtml } from "./artifact-markdown";

it("renders headings, lists, code and tables", () => {
  const html = artifactMarkdownHtml(
    [
      "# Title",
      "## Section *one*",
      "",
      "- first",
      "- **second**",
      "",
      "3. three",
      "4. four",
      "",
      "- [x] done",
      "- [ ] open",
      "",
      "```ts",
      "const a = 1 < 2 && b;",
      "```",
      "",
      "Inline `x<y` and ~~gone~~.",
      "",
      "| Name | Count |",
      "| :--- | ----: |",
      "| a | 1 |",
      "",
      "> quoted",
    ].join("\n"),
  );
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<h2>Section <em>one</em></h2>");
  expect(html).toContain("<ul><li>first</li><li><strong>second</strong></li></ul>");
  expect(html).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
  expect(html).toContain('<input type="checkbox" disabled checked> done');
  expect(html).toContain(
    '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; b;</code></pre>',
  );
  expect(html).toContain("<code>x&lt;y</code>");
  expect(html).toContain("<del>gone</del>");
  expect(html).toContain(
    '<table><thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Count</th></tr></thead><tbody><tr><td style="text-align:left">a</td><td style="text-align:right">1</td></tr></tbody></table>',
  );
  expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
});

it("keeps links inert and drops raw HTML and script injection", () => {
  const html = artifactMarkdownHtml(
    [
      "[docs](https://example.com/docs) and [bad](javascript:alert(1)) and <https://example.com/auto>",
      "",
      "[ref][r]",
      "",
      "[r]: javascript:alert(2)",
      "",
      "![logo](https://example.com/logo.png) ![x](javascript:alert(3))",
      "",
      "<script>alert(4)</script>",
      "",
      'Inline <img src=x onerror="alert(5)"> html.',
      "",
      '<a href="javascript:alert(6)">click</a>',
      "",
      '```"><script>alert(7)</script>',
      "x",
      "```",
    ].join("\n"),
  );
  expect(html).not.toMatch(/<script|<a\b|<img|href=|src=|onerror|javascript:/i);
  expect(html).toContain('<span class="link">docs</span>');
  expect(html).toContain('<span class="link">bad</span>');
  expect(html).toContain('<span class="link">ref</span>');
  expect(html).toContain("<span>Image: logo</span>");
  expect(html).toContain("Inline  html.");
});
