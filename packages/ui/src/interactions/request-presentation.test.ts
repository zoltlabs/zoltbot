import type { Interaction } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { permissionExpansion, selectedRequest } from "./request-presentation.js";

it("keeps the current request through reorder and version updates, then advances after resolution", () => {
  const requests = [
    { id: "new", version: 1 },
    { id: "drafting", version: 2 },
  ];
  expect(selectedRequest(requests, "drafting")).toBe(requests[1]);
  expect(selectedRequest(requests, "resolved")).toBe(requests[0]);
  expect(selectedRequest([], "drafting")).toBeUndefined();
});
it("reviews broad permission without adding a step to ordinary approval", () => {
  const request = {
    items: [{ choices: [{ id: "allow_session", label: "Read project files" }] }],
  } as unknown as Interaction;
  expect(permissionExpansion(request, "allow_once")).toBeUndefined();
  expect(permissionExpansion(request, "allow_session")?.description).toContain(
    "Read project files",
  );
  expect(permissionExpansion(request, "allow_accept_edits")?.description).toContain(
    "without individual approval",
  );
});
