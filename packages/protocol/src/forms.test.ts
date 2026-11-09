import { expect, it } from "vitest";
import { checkFlatForm } from "./forms.js";

const schema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    count: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["fast", "safe"] },
  },
  required: ["name", "mode"],
  additionalProperties: false,
};
it("validates supported flat forms without coercing values or applying defaults", () => {
  const value = { name: "Work", mode: "safe", enabled: true, count: 2 };
  expect(checkFlatForm(schema, value)).toBe(true);
  expect(checkFlatForm(schema, { name: "Work", mode: "safe" })).toBe(true);
  expect(value).toEqual({ name: "Work", mode: "safe", enabled: true, count: 2 });
});
it("rejects missing fields, extra fields, invalid enums, bounds, and mismatched types", () => {
  for (const value of [
    { mode: "safe" },
    { name: "", mode: "safe" },
    { name: "Work", mode: "other" },
    { name: "Work", mode: "safe", count: 0 },
    { name: "Work", mode: "safe", count: 1.5 },
    { name: "Work", mode: "safe", enabled: "true" },
    { name: "Work", mode: "safe", extra: "hidden" },
  ])
    expect(checkFlatForm(schema, value)).toBe(false);
});
it("refuses unsupported constraints rather than silently ignoring them", () => {
  for (const value of [
    { $ref: "https://example.invalid/schema" },
    { type: "string", pattern: "(a+)+$" },
    { type: "object", properties: { nested: { type: "object" } } },
    { type: "object", properties: {}, additionalProperties: true },
    { type: ["string"] },
    { type: "string", title: { invalid: true } },
  ])
    expect(() => checkFlatForm(value, {})).toThrow("unsupported_form_schema");
});
it("supports primitive form items and enum only schemas", () => {
  expect(checkFlatForm({ type: "string", maxLength: 4 }, "code")).toBe(true);
  expect(checkFlatForm({ type: "number", exclusiveMinimum: 0 }, 0)).toBe(false);
  expect(checkFlatForm({ enum: ["first", "second"] }, "second")).toBe(true);
  expect(checkFlatForm({ type: "boolean", default: true }, undefined)).toBe(false);
});
