import { expect, it } from "vitest";
import { artifactPath, possibleSecret, verifiedType } from "./index.js";

it("rejects traversal, absolute paths, ambiguous separators and binary text", () => {
  for (const name of ["../a", "/a", "a//b", "a\\b", "a/./b"])
    expect(() => artifactPath(name)).toThrow("invalid_artifact_path");
  expect(artifactPath("screen/index.html")).toBe("screen/index.html");
  expect(() => verifiedType("a.txt", Buffer.from([0]))).toThrow("artifact_binary_text_denied");
  expect(possibleSecret(".env", "synthetic")).toBe(true);
  expect(possibleSecret("screen.html", "<p>hello</p>")).toBe(false);
});
