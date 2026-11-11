import { describe, expect, it } from "vitest";
import { parseViewManifest } from "./manifest.js";

const valid = {
  manifest: 1,
  id: "example",
  name: "Example",
  version: "1.0.0",
  api: 1,
  entry: "index.html",
  slots: ["page"],
  permissions: ["read"],
};
const parse = (value: unknown) => parseViewManifest(value, "example");
describe("view manifest", () => {
  it("accepts all optional fields and ignores unknown fields", () => {
    expect(
      parse({
        ...valid,
        description: "Example view",
        icon: "icons/map.svg",
        author: "Zolt Labs",
        license: "Apache-2.0",
        shortcuts: [{ id: "alert", keys: "Space", label: "Next alert" }],
        basedOn: { id: "example", version: "1.2.3-beta.1+build.2", bundleHash: "a".repeat(64) },
        future: true,
      }),
    ).toMatchObject(valid);
    expect(parse({ ...valid, permissions: ["read", "act", "approve"] }).permissions).toHaveLength(
      3,
    );
    expect(parse({ ...valid, icon: "icon.png", shortcuts: [] }).icon).toBe("icon.png");
  });
  for (const field of Object.keys(valid))
    it(`requires ${field}`, () => {
      const value: Record<string, unknown> = { ...valid };
      delete value[field];
      expect(() => parse(value)).toThrow();
    });
  it.each([
    ["manifest", 2],
    ["api", 2],
    ["id", "A"],
    ["id", "a"],
    ["id", "a".repeat(41)],
    ["id", "a_b"],
    ["name", ""],
    ["name", "a".repeat(41)],
    ["description", "a".repeat(201)],
    ["version", "1"],
    ["version", "01.2.3"],
    ["version", "1.2.3-01"],
    ["version", "v1.2.3"],
    ["entry", "index.js"],
    ["entry", "../index.html"],
    ["entry", "/index.html"],
    ["entry", "a/./index.html"],
    ["entry", "a//index.html"],
    ["entry", "a\\index.html"],
    ["entry", "_host/index.html"],
    ["entry", "a%20b.html"],
    ["entry", "a\u0000.html"],
    ["icon", "icon.jpg"],
    ["icon", "../icon.svg"],
    ["slots", []],
    ["slots", ["home"]],
    ["slots", ["page", "page"]],
    ["permissions", []],
    ["permissions", ["act"]],
    ["permissions", ["read", "network"]],
    ["permissions", ["read", "read"]],
    ["author", "a".repeat(81)],
    ["license", "a".repeat(81)],
    [
      "shortcuts",
      Array.from({ length: 31 }, (_, i) => ({ id: `key-${i}`, keys: "Space", label: "Next" })),
    ],
    ["shortcuts", [{ id: "bad id", keys: "Space", label: "Next" }]],
    ["shortcuts", [{ id: "next", keys: "", label: "Next" }]],
    ["shortcuts", [{ id: "next", keys: "Space", label: "" }]],
    ["basedOn", { id: "example", version: "1.0.0", bundleHash: "bad" }],
  ])("rejects invalid %s: %j", (field, value) =>
    expect(() => parse({ ...valid, [field as string]: value })).toThrow());
  it("checks folder identity and unique shortcut ids", () => {
    expect(() => parseViewManifest(valid, "other")).toThrow("view_id_must_match_folder");
    const shortcut = { id: "next", keys: "Space", label: "Next" };
    expect(() => parse({ ...valid, shortcuts: [shortcut, shortcut] })).toThrow(
      "view_duplicate_shortcut",
    );
  });
  it("accepts boundary lengths", () => {
    expect(() =>
      parseViewManifest(
        {
          ...valid,
          id: "a".repeat(40),
          name: "a".repeat(40),
          description: "a".repeat(200),
          author: "a".repeat(80),
          license: "a".repeat(80),
        },
        "a".repeat(40),
      ),
    ).not.toThrow();
  });
});
