import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { BotProfile } from "../../data";
import { MessageMarkdown } from "./MessageMarkdown";

const report =
  "**Mobile**\n- `a023e6aa` Restores a missing profile\n- See [the build](https://example.com/b) with @Planner";

const planner = { id: "p1", name: "Planner" } as BotProfile;

function show(body: string, hooks: { link?: (url: string) => void; agent?: (id: string) => void }) {
  return render(() => (
    <MessageMarkdown
      body={body}
      bots={[planner]}
      onOpenLink={hooks.link ?? (() => {})}
      onSelectAgent={hooks.agent ?? (() => {})}
    />
  ));
}

describe("MessageMarkdown", () => {
  it("formats an agent's report instead of showing the marks", () => {
    const { container } = show(report, {});
    expect(container.querySelector("strong")?.textContent).toBe("Mobile");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("a023e6aa");
    expect(container.textContent).not.toContain("**");
  });

  it("opens links through the app and keeps agent tags", () => {
    const link = vi.fn();
    const agent = vi.fn();
    show(report, { link, agent });
    fireEvent.click(screen.getByRole("link", { name: /the build/ }));
    expect(link).toHaveBeenCalledWith("https://example.com/b");
    fireEvent.click(screen.getByRole("button", { name: "Open agent Planner" }));
    expect(agent).toHaveBeenCalledWith("p1");
  });

  it("shows raw HTML as text and leaves out unsafe links", () => {
    const { container } = show(
      '<img src="x" onerror="alert(1)"> and [run](javascript:alert(1))',
      {},
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("run");
  });
});
