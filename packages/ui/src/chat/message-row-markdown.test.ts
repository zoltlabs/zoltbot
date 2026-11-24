import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageRow } from "./MessageRow.js";

const report = "**Mobile**\n- `a023e6aa` Restores a missing profile\n- Builds: 2.8.5";

function render(item: Record<string, unknown>, source?: { label: string }) {
  return renderToStaticMarkup(createElement(MessageRow, { item, name: "Chief", source }));
}

describe("agent messages render as Markdown", () => {
  it("formats what the main agent sends you on its own", () => {
    const html = render({
      id: "n1",
      kind: "note",
      body: { code: "chief_notify", text: report },
    });
    expect(html).toContain("chat-markdown");
    expect(html).toContain("<strong>Mobile</strong>");
    expect(html).toContain("<li>");
    expect(html).toContain("<code>a023e6aa</code>");
    expect(html).not.toContain("**Mobile**");
  });

  it("formats a message another chat sent", () => {
    const html = render(
      {
        id: "u1",
        kind: "user",
        body: { origin: "agent", input: [{ type: "text", text: report }] },
      },
      { label: "From Planner" },
    );
    expect(html).toContain("<strong>Mobile</strong>");
  });

  it("keeps your own words as typed", () => {
    const html = render({
      id: "u2",
      kind: "user",
      body: { input: [{ type: "text", text: "**not bold**" }] },
    });
    expect(html).toContain("**not bold**");
  });
});
