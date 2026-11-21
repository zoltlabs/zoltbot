import { chatStatusKey } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { workingStatus } from "./status";

it("shows the agent's status while its turn runs, else the running tool's line", () => {
  const snapshot = {
    seq: 1,
    counters: {},
    entities: {
      turn: [{ id: "t", threadId: "chat", status: "running" }],
      item: [
        {
          id: "i",
          threadId: "chat",
          turnId: "t",
          kind: "tool",
          body: { kind: "search", status: "running" },
        },
      ],
      settings: [] as Record<string, unknown>[],
    },
  };
  expect(workingStatus(snapshot, "chat")).toBe("Searching");
  snapshot.entities.settings.push({
    key: chatStatusKey("chat"),
    value: { turnId: "t", text: "Reading the invoices", at: "" },
  });
  expect(workingStatus(snapshot, "chat")).toBe("Reading the invoices");
  expect(workingStatus(snapshot, "other")).toBeUndefined();
});
