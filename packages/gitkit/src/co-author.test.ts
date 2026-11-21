import { describe, expect, it } from "vitest";
import { agentCommitMessage, agentSlug, coAuthorTrailer, withCoAuthor } from "./co-author.js";

describe("co-author trailer", () => {
  it("names the agent on a reserved domain", () => {
    expect(coAuthorTrailer("Code reviewer")).toBe(
      "Co-Authored-By: Code reviewer <code-reviewer@agents.zoltbot.invalid>",
    );
    expect(agentSlug("Zoë  <QA> ")).toBe("zoe-qa");
    expect(agentSlug("🙂")).toBe("agent");
    expect(coAuthorTrailer("Eve <x@y.z>\nCc: me")).toBe(
      "Co-Authored-By: Eve x@y.z Cc: me <eve-x-y-z-cc-me@agents.zoltbot.invalid>",
    );
  });

  it("adds the trailer once, after a blank line or in an existing trailer block", () => {
    expect(withCoAuthor("Fix login", "Rita")).toBe(
      "Fix login\n\nCo-Authored-By: Rita <rita@agents.zoltbot.invalid>",
    );
    expect(withCoAuthor("Fix login\n\nBody.\n\nSigned-off-by: A <a@b.c>\n", "Rita")).toBe(
      "Fix login\n\nBody.\n\nSigned-off-by: A <a@b.c>\nCo-Authored-By: Rita <rita@agents.zoltbot.invalid>",
    );
    // The subject line is never treated as a trailer block.
    expect(withCoAuthor("Fix: login", "Rita")).toBe(
      "Fix: login\n\nCo-Authored-By: Rita <rita@agents.zoltbot.invalid>",
    );
  });

  it("doesn't duplicate a trailer that is already there", () => {
    const once = withCoAuthor("Fix login", "Rita");
    expect(withCoAuthor(once, "Rita")).toBe(once);
    expect(withCoAuthor("Fix\n\nco-authored-by: rita <RITA@agents.zoltbot.invalid>", "Rita")).toBe(
      "Fix\n\nco-authored-by: rita <RITA@agents.zoltbot.invalid>",
    );
  });

  it("follows the project setting: on by default, its own domain, and off leaves the message", () => {
    expect(agentCommitMessage("Fix login", "Rita", undefined)).toBe(
      "Fix login\n\nCo-Authored-By: Rita <rita@agents.zoltbot.invalid>",
    );
    expect(
      agentCommitMessage("Fix login", "Rita", {
        coAuthorLine: true,
        coAuthorDomain: "Bots.Example",
      }),
    ).toBe("Fix login\n\nCo-Authored-By: Rita <rita@bots.example>");
    // An address that isn't a plain host name falls back to the reserved domain.
    expect(agentCommitMessage("Fix login", "Rita", { coAuthorDomain: "x@evil>" })).toContain(
      "<rita@agents.zoltbot.invalid>",
    );
    expect(agentCommitMessage("Fix login", "Rita", { coAuthorLine: false })).toBe("Fix login");
    expect(agentCommitMessage("Fix login", undefined, undefined)).toBe("Fix login");
    // A blank message never turns into a trailer-only message that looks written.
    expect(withCoAuthor("  ", "Rita").startsWith("\n")).toBe(true);
    expect(coAuthorTrailer("x".repeat(200)).length).toBeLessThanOrEqual(150);
  });
});
