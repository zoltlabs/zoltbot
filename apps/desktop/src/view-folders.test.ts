import { expect, it } from "vitest";
import { viewFolderPath } from "./view-folders.js";

it("scopes Finder paths to checked view ids and the chosen source", () => {
  expect(viewFolderPath("/app", "/data", { id: "command-map", source: "builtin" })).toBe(
    "/app/packages/views/command-map",
  );
  expect(viewFolderPath("/app", "/data", { id: "command-map", source: "user" })).toBe(
    "/data/views/command-map",
  );
  for (const input of [
    null,
    {},
    { id: "../outside", source: "user" },
    { id: "example", source: "network" },
    { id: "/outside", source: "builtin" },
  ])
    expect(() => viewFolderPath("/app", "/data", input)).toThrow("invalid_view_folder");
});
