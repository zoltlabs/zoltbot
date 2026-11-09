import { expect, test } from "vitest";
import { macOnlyMethods, parseRequest } from "./index.js";

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
