import { expect, it } from "vitest";
import { executionResult, resultLinks, webResultUrl } from "./result-data.js";

it("shows explicit structured and MCP resource results without turning logs into links", () => {
  expect(
    resultLinks({
      output: {
        content: [
          { type: "text", text: "https://example.invalid/log" },
          { type: "resource_link", uri: "https://example.invalid/doc", name: "Docs" },
        ],
        structuredContent: {
          results: [
            {
              url: "https://example.invalid/issue",
              title: "Issue",
              description: "Session restore",
            },
            { url: "https://example.invalid/doc", title: "Documentation" },
          ],
        },
      },
    }),
  ).toEqual([
    { url: "https://example.invalid/doc", label: "Documentation", description: "" },
    { url: "https://example.invalid/issue", label: "Issue", description: "Session restore" },
  ]);
});
it("rejects credentials, local files and executable URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@example.invalid/",
    "https://example.invalid/a b",
    null,
  ])
    expect(webResultUrl(value)).toBeUndefined();
  expect(resultLinks({ output: "[Log](https://example.invalid)" })).toEqual([]);
});
it("reports only explicit numeric exit codes and strips terminal escapes", () => {
  expect(executionResult({ output: { exitCode: 2, stdout: "failure" } }).exitCode).toBe(2);
  expect(executionResult({ output: "\u001b[31mExit code 0\u001b[0m" })).toEqual({
    output: "Exit code 0",
    exitCode: undefined,
  });
  expect(executionResult({ output: { exitCode: "0" } }).exitCode).toBeUndefined();
});
