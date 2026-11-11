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

it("verifies WOFF2 header length, table count and compressed data bounds", () => {
  const bytes = Buffer.alloc(49);
  bytes.write("wOF2");
  bytes.writeUInt32BE(bytes.length, 8);
  bytes.writeUInt16BE(1, 12);
  bytes.writeUInt32BE(1, 20);
  expect(verifiedType("font.woff2", bytes)).toBe("font/woff2");
  for (const offset of [0, 8, 12, 14, 20]) {
    const broken = Buffer.from(bytes);
    broken.writeUInt32BE(0xffffffff, offset);
    expect(() => verifiedType("font.woff2", broken)).toThrow();
  }
});
