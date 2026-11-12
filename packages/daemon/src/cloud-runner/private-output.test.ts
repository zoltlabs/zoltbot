import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { privateOutput } from "./private-output.js";

it("withholds split credentials independently for stdout and stderr before serialization", () => {
  const value = randomBytes(32).toString("base64url"),
    output = privateOutput();
  output.register(value);
  const first = output.text("stdout", `before ${value.slice(0, 17)}`);
  expect(first).toBe("before ");
  expect(output.text("stderr", "separate", true)).toBe("separate");
  const visible = first + output.text("stdout", `${value.slice(17)} after`, true);
  expect(visible).toBe("before [redacted] after");
  expect(visible.includes(value)).toBe(false);
  expect(JSON.stringify(output)).toBe("{}");
});
it("releases overlapping replacements without retaining an entire stream and clears pending prefixes", () => {
  const output = privateOutput();
  output.register("aa");
  const visible = output.text("stdout", "a".repeat(100000));
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.includes("aa")).toBe(false);
  output.register("fixture-private-value");
  output.text("stderr", "fixture-private-");
  output.clear();
  expect(output.text("stderr", "next", true)).toBe("next");
});
