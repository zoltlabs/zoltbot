import { describe, expect, it } from "vitest";
import { chooseAgent } from "./agent-choice";

const agent = (id: string, definitionId = id, kind = "profile") => ({ id, definitionId, kind });
const cursor = agent("cursor-profile", "cursor");
const codex = agent("codex-profile", "codex");
const claude = agent("claude-profile", "claude");
const chief = agent("chief", "claude", "chief_of_staff");

describe("chooseAgent", () => {
  it("prefers Claude Code, then Codex, over agents listed first", () => {
    expect(chooseAgent([cursor, codex, claude])?.id).toBe("claude-profile");
    expect(chooseAgent([cursor, codex])?.id).toBe("codex-profile");
  });

  it("uses the chosen agent, then the project's default", () => {
    expect(chooseAgent([cursor, claude], { profileId: "cursor-profile" })?.id).toBe(
      "cursor-profile",
    );
    expect(chooseAgent([cursor, claude], { defaultAgentId: "cursor-profile" })?.id).toBe(
      "cursor-profile",
    );
  });

  it("skips the chief of staff unless nothing else is left", () => {
    expect(chooseAgent([chief, cursor])?.id).toBe("cursor-profile");
    expect(chooseAgent([chief])?.id).toBe("chief");
    expect(chooseAgent([])).toBeUndefined();
  });
});
