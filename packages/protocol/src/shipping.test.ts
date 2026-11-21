import { expect, test } from "vitest";
import { githubAppInstallUrl, macOnlyMethods, parseRequest } from "./index.js";

test("GitHub mutations stay Mac-only and schema validation rejects malformed feedback", () => {
  for (const method of [
    "shipping.publish",
    "shipping.link",
    "shipping.feedback",
    "shipping.merge",
    "shipping.cancelFeedback",
  ])
    expect(macOnlyMethods).toContain(method);
  expect(macOnlyMethods).not.toContain("shipping.get");
  expect(() =>
    parseRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "shipping.feedbackPreview",
      params: { id: "task", selected: [], note: "" },
    }),
  ).toThrow();
});

test("the GitHub App install link sits under the build's cloud origin, if there is one", () => {
  expect(githubAppInstallUrl("https://cloud.example.test")).toBe(
    "https://cloud.example.test/api/github/install",
  );
  expect(githubAppInstallUrl("http://127.0.0.1:8080")).toBe(
    "http://127.0.0.1:8080/api/github/install",
  );
  for (const origin of [undefined, "", "http://cloud.example.test", "not a url", "javascript:x"])
    expect(githubAppInstallUrl(origin)).toBeUndefined();
});
