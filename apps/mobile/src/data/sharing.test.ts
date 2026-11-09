import { describe, expect, it } from "vitest";
import {
  draftDestination,
  type SharedDraft,
  sharedDraftInput,
  shareRecipients,
} from "./sharing.js";
import type { Snapshot } from "./transport.js";

const snapshot: Snapshot = {
  seq: 1,
  counters: {},
  entities: {
    agent: [
      { id: "chief", name: "Main bot" },
      { id: "manager", name: "Research" },
      { id: "hidden", hidden: true },
    ],
    project: [
      { id: "project", name: "Zolt", roots: [] },
      { id: "archived-project", archived: true },
    ],
    subproject: [
      { id: "direction", projectId: "project", name: "App", label: "App" },
      { id: "archived-direction", archived: true },
    ],
    thread: [
      {
        id: "manager",
        kind: "manager",
        agentId: "manager",
        projectId: "project",
        node: { type: "subproject", id: "direction" },
      },
      { id: "main", kind: "main", agentId: "chief" },
      { id: "side", kind: "side", agentId: "chief" },
      { id: "task", kind: "task", agentId: "chief" },
      { id: "archived", kind: "manager", agentId: "chief", archived: true },
      { id: "hidden", kind: "main", agentId: "hidden" },
      { id: "missing", kind: "main", agentId: "missing" },
      { id: "old-project", kind: "manager", agentId: "chief", projectId: "archived-project" },
      {
        id: "old-direction",
        kind: "manager",
        agentId: "chief",
        node: { type: "subproject", id: "archived-direction" },
      },
    ],
  },
};
const draft: SharedDraft = {
  version: 1,
  id: "draft",
  createdAt: "2026-11-04T00:00:00Z",
  macId: "mac-a",
  recipientId: JSON.stringify(["mac-a", "main"]),
  text: " Read this https://example.com ",
  images: [],
};

describe("share destinations", () => {
  it("includes active main and manager conversations in stable order", () => {
    const recipients = shareRecipients(snapshot, "mac-a");
    expect(recipients.map((recipient) => recipient.threadId)).toEqual(["main", "manager"]);
    expect(recipients[0]?.name).toBe("Main bot");
    expect(recipients[1]?.name).toContain("Zolt");
    expect(shareRecipients(snapshot, "")).toEqual([]);
  });
  it("scopes identities and routing to the original Mac", () => {
    const current = shareRecipients(snapshot, "mac-a");
    const other = shareRecipients(snapshot, "mac-b");
    expect(current[0]?.id).not.toBe(other[0]?.id);
    expect(draftDestination(draft, current)?.threadId).toBe("main");
    expect(draftDestination(draft, other)).toBeUndefined();
    expect(draftDestination(draft, other, other[0]?.id)).toBeUndefined();
    expect(draftDestination(draft, current, "deleted")).toBeUndefined();
    expect(draftDestination(draft, current, current[1]?.id)?.threadId).toBe("manager");
  });
  it("does not let separator characters create identity collisions", () => {
    const first = shareRecipients(
      {
        ...snapshot,
        entities: { ...snapshot.entities, thread: [{ id: "b:c", kind: "main", agentId: "chief" }] },
      },
      "a",
    );
    const second = shareRecipients(
      {
        ...snapshot,
        entities: { ...snapshot.entities, thread: [{ id: "c", kind: "main", agentId: "chief" }] },
      },
      "a:b",
    );
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });
});

describe("shared message input", () => {
  it("keeps links as text and photos inline, never iPhone file paths", () => {
    expect(sharedDraftInput(draft)).toEqual([
      { type: "text", text: "Read this https://example.com" },
    ]);
    expect(
      sharedDraftInput({
        ...draft,
        text: "",
        images: [{ base64: "abc=", mimeType: "image/jpeg" }],
      }),
    ).toEqual([{ type: "image", base64: "abc=", mimeType: "image/jpeg" }]);
  });
  it("keeps the largest share inside the sealed relay frame budget", () => {
    const input = sharedDraftInput({
      ...draft,
      text: "x".repeat(16_000),
      images: Array.from({ length: 5 }, () => ({
        base64: "a".repeat(80_000),
        mimeType: "image/jpeg" as const,
      })),
    });
    // Ciphertext/base64 envelope plus protocol metadata, with generous overhead.
    expect(Math.ceil((JSON.stringify(input).length * 4) / 3) + 16_384).toBeLessThan(1_048_576);
  });
  it("rejects empty messages and oversized UTF-8 text or photo sets", () => {
    expect(() => sharedDraftInput(draft, " ")).toThrow("Add a message");
    expect(() => sharedDraftInput(draft, "😀".repeat(4_001))).toThrow("16,000");
    expect(() =>
      sharedDraftInput({
        ...draft,
        images: Array.from({ length: 6 }, () => ({ base64: "a", mimeType: "image/jpeg" as const })),
      }),
    ).toThrow("size limit");
    expect(() =>
      sharedDraftInput({
        ...draft,
        images: [{ base64: "a".repeat(80_001), mimeType: "image/jpeg" }],
      }),
    ).toThrow("size limit");
  });
});
