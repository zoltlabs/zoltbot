import { expect, it } from "vitest";
import { importKind, importPreview, selectedImportIds } from "./import-data.js";

it("keeps duplicate names separate by source identity and never guesses a project folder", () => {
  const preview = importPreview({
    previewId: "preview",
    items: [
      {
        id: "one",
        kind: "project",
        source: "claude",
        name: "Same name",
        nativePath: "/fixture/history",
      },
      { id: "two", kind: "project", source: "git", name: "Same name", path: "/fixture/repo" },
    ],
  });
  expect(preview.items.map(importKind)).toEqual(["Project hint", "Project"]);
  expect(selectedImportIds(preview, new Set(["two"]))).toEqual(["two"]);
  expect(() => selectedImportIds(preview, new Set(["missing"]))).toThrow("unknown_import_item");
});
it("rejects malformed and duplicate preview identities before applying metadata", () => {
  const item = { id: "same", kind: "session", source: "codex", name: "Session" };
  expect(() => importPreview({ previewId: "preview", items: [item, item] })).toThrow(
    "invalid_import_preview",
  );
  expect(() => importPreview({ items: [] })).toThrow("invalid_import_preview");
});
