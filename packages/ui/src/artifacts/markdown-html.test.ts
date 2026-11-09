import { expect, it } from "vitest";
import { artifactMarkdownHtml } from "./markdown-html.js";

it("renders headings and tables without active HTML, links or remote images", () => {
  const html = artifactMarkdownHtml(
    "# A document\n\n| A | B |\n|---|---|\n| one | two |\n\n[remote](https://example.invalid)\n\n![alt](https://example.invalid/image)\n\n<script>window.probe=true</script>",
  );
  expect(html).toContain("<h1>A document</h1>");
  expect(html).toContain("<table>");
  expect(html).toContain("Image: alt");
  expect(html).not.toMatch(/<script|<img|href=|src=|window.probe/);
});
