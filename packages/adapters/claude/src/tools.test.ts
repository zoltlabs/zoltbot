import { expect, it } from "vitest";
import { agentOutput, toolDiffs, toolKind, toolLocations, toolTitle } from "./tools.js";

it("titles tools with a provider neutral one line summary", () => {
  expect(toolTitle("Bash", { command: "npm test\nnpm run lint", description: "Test" })).toBe(
    "npm test",
  );
  expect(toolTitle("Bash", { description: "List files" })).toBe("List files");
  expect(toolTitle("Read", { file_path: "/w/a.ts" })).toBe("/w/a.ts");
  expect(toolTitle("MultiEdit", { file_path: "/w/a.ts", edits: [] })).toBe("/w/a.ts");
  expect(toolTitle("NotebookEdit", { notebook_path: "/w/n.ipynb" })).toBe("/w/n.ipynb");
  expect(toolTitle("Grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
  expect(toolTitle("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  expect(toolTitle("WebFetch", { url: "https://example.com/a" })).toBe("https://example.com/a");
  expect(toolTitle("WebSearch", { query: "vitest poll" })).toBe("vitest poll");
  expect(toolTitle("Task", { description: "Review the diff", prompt: "long" })).toBe(
    "Review the diff",
  );
  expect(toolTitle("Agent", { description: "Explore" })).toBe("Explore");
  expect(toolTitle("TodoWrite", { todos: [] })).toBe("Update to-do list");
  expect(toolTitle("mcp__server__tool", {})).toBeUndefined();
  expect(toolTitle("Bash", { command: "x".repeat(400) })?.length).toBe(300);
});
it("maps kinds, including subagents and MultiEdit", () => {
  expect(
    ["Bash", "Read", "MultiEdit", "Grep", "WebFetch", "Task", "Agent", "Other"].map(toolKind),
  ).toEqual(["execute", "read", "edit", "search", "fetch", "agent", "agent", "other"]);
});
it("reports file locations with the read offset as a line", () => {
  expect(toolLocations("Read", { file_path: "/w/a.ts", offset: 40 })).toEqual([
    { path: "/w/a.ts", line: 40 },
  ]);
  expect(toolLocations("Edit", { file_path: "/w/a.ts", offset: 40 })).toEqual([
    { path: "/w/a.ts" },
  ]);
  expect(toolLocations("Bash", { command: "ls" })).toBeUndefined();
});
it("builds one diff per MultiEdit edit and never returns a partial change", () => {
  expect(
    toolDiffs("MultiEdit", {
      file_path: "/w/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d", replace_all: true },
      ],
    }),
  ).toEqual([
    { path: "/w/a.ts", before: "a", after: "b" },
    { path: "/w/a.ts", before: "c", after: "d" },
  ]);
  expect(toolDiffs("Write", { file_path: "/w/a.ts", content: "x".repeat(70000) })).toBeUndefined();
  // One oversized edit or more edits than fit drops every diff, not just the offending ones.
  expect(
    toolDiffs("MultiEdit", {
      file_path: "/w/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "x".repeat(70000), new_string: "y" },
      ],
    }),
  ).toBeUndefined();
  expect(
    toolDiffs("MultiEdit", {
      file_path: "/w/a.ts",
      edits: Array.from({ length: 51 }, (_, i) => ({ old_string: `${i}`, new_string: "z" })),
    }),
  ).toBeUndefined();
  expect(toolDiffs("Edit", { file_path: "/w/a.ts", old_string: 1 })).toBeUndefined();
  expect(toolDiffs("MultiEdit", { file_path: "/w/a.ts", edits: ["bad"] })).toBeUndefined();
});
it("flattens subagent text results and keeps other content", () => {
  expect(
    agentOutput([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]),
  ).toBe("one\ntwo");
  const mixed = [{ type: "image" }];
  expect(agentOutput(mixed)).toBe(mixed);
  expect(agentOutput("plain")).toBe("plain");
});
