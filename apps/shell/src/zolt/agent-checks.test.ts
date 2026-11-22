// @vitest-environment node
import { describe, expect, it } from "vitest";
import { agentChecks, providerStatuses } from "./agent-checks";

const definitions = [
  {
    id: "claude",
    displayName: "Claude Code",
    binaryNames: ["claude"],
    auth: { loginCommand: ["auth", "login"] },
    install: { docsUrl: "https://example.com/install", command: "npm install -g example" },
  },
  { id: "codex", displayName: "Codex", binaryNames: ["codex"] },
  { id: "pi", displayName: "Pi", binaryNames: ["pi"] },
  { id: "old", displayName: "Old", binaryNames: ["old"] },
  { id: "new", displayName: "New", binaryNames: ["new"] },
];

const report = {
  checks: [
    {
      kind: "agent",
      definitionId: "claude",
      install: { selected: { path: "/bin/claude", state: "working", version: "2.1.0" } },
      login: { state: "signed_out" },
    },
    {
      kind: "agent",
      definitionId: "codex",
      install: { selected: { path: "/bin/codex", state: "working", version: "0.144.1" } },
      login: { state: "signed_in" },
    },
    { kind: "agent", definitionId: "pi", install: { candidates: [] }, login: { state: "unknown" } },
    {
      kind: "agent",
      definitionId: "old",
      install: { selected: { path: "/bin/old", state: "working", support: "unsupported" } },
      login: { state: "unknown" },
    },
    { kind: "global", id: "disk", state: "available" },
  ],
};

describe("agent checks", () => {
  it("reports each daemon agent with its install and sign-in state", () => {
    const statuses = providerStatuses(definitions, agentChecks(report), true);
    expect(statuses.map(({ id, state }) => [id, state])).toEqual([
      ["claude", "sign-in-required"],
      ["codex", "available"],
      ["pi", "not-installed"],
      ["old", "outdated"],
      ["new", "checking"],
    ]);
    expect(statuses[0]).toMatchObject({
      name: "Claude Code",
      version: "2.1.0",
      loginCommand: "claude auth login",
      installUrl: "https://example.com/install",
      installCommand: "npm install -g example",
    });
    expect(statuses[2]?.message).toBe("Pi isn’t installed.");
  });

  it("lists checked agents that aren't stored yet from their setup hints", () => {
    const fresh = {
      checks: [
        {
          kind: "agent",
          definitionId: "claude",
          displayName: "Claude Code",
          setup: {
            binary: "claude",
            install: { docsUrl: "https://example.com/install" },
            loginCommand: ["auth", "login"],
          },
          install: { selected: { path: "/bin/claude", state: "working", version: "2.1.0" } },
          login: { state: "signed_in" },
        },
        { kind: "agent", definitionId: "goose", displayName: "Goose", install: { candidates: [] } },
      ],
    };
    const statuses = providerStatuses([], agentChecks(fresh), true);
    expect(statuses.map(({ id, state }) => [id, state])).toEqual([
      ["claude", "available"],
      ["goose", "not-installed"],
    ]);
    expect(statuses[0]).toMatchObject({
      name: "Claude Code",
      installUrl: "https://example.com/install",
      loginCommand: "claude auth login",
    });
  });

  it("reads as checking before the report and not started while offline", () => {
    expect(providerStatuses(definitions, undefined, true)[0]?.state).toBe("checking");
    expect(providerStatuses(definitions, agentChecks(report), false)[1]?.state).toBe("not-started");
    expect(providerStatuses(definitions, "failed", true)[1]?.state).toBe("error");
  });
});
