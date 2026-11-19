// @vitest-environment node
import { expect, it } from "vitest";
import type { Snapshot } from "./daemon-client";
import { toMessages } from "./mapping";
import { switchDialogFor, timeOfDay, toAccountView, toOrders } from "./models-service";

const at = "2026-11-19T10:00:00.000Z";
const resets = "2026-11-19T15:40:00.000Z";

it("names added accounts with their tool and reports limits", () => {
  const definitions = [{ id: "claude", displayName: "Claude" }];
  const work = toAccountView(
    {
      id: "work",
      label: "Work",
      definitionId: "claude",
      provider: "claude",
      isDefault: false,
      login: "signed_in",
      limit: { resetsAt: resets, observedAt: at },
      inUse: 1,
    },
    definitions,
  );
  expect(work).toMatchObject({
    name: "Claude · Work",
    atLimit: true,
    limitResetsAt: resets,
    login: "signed_in",
    inUse: 1,
  });
  const own = toAccountView(
    { id: "default:claude", label: "Claude", definitionId: "claude", isDefault: true },
    definitions,
  );
  expect(own).toMatchObject({ name: "Claude", atLimit: false, login: "unknown" });
});

it("keeps role orders that follow employees as null", () => {
  expect(toOrders({ employee: [{ accountId: "a" }], manager: null, ceo: [] })).toEqual({
    employee: [{ accountId: "a" }],
    manager: null,
    ceo: [],
  });
});

it("maps switch notes to system notices with the reset time", () => {
  const snapshot: Snapshot = { seq: 1, entities: {}, counters: {} };
  const messages = toMessages(snapshot, "t", [
    {
      id: "n1",
      threadId: "t",
      seq: 1,
      kind: "note",
      createdAt: at,
      body: {
        code: "model_switch",
        change: "switched",
        from: "Claude · Work",
        to: "Claude · Personal",
        until: resets,
        text: "Claude · Work hit its limit. Continuing on Claude · Personal.",
      },
    },
    { id: "n2", threadId: "t", seq: 2, kind: "note", createdAt: at, body: { text: "other" } },
  ]);
  expect(messages).toEqual([
    expect.objectContaining({
      id: "n1",
      source: "system",
      itemType: "modelSwitch",
      text: `Claude · Work hit its limit. Continuing on Claude · Personal until ${timeOfDay(resets)}.`,
    }),
  ]);
});

it("reads the switch dialog from a backup interaction only", () => {
  expect(
    switchDialogFor({
      context: {
        toolInput: {
          backupSwitch: {
            from: "Claude · Personal",
            to: "Codex",
            provider: "Codex",
            until: resets,
            project: "Acme app",
          },
        },
      },
    }),
  ).toEqual({
    from: "Claude · Personal",
    to: "Codex",
    provider: "Codex",
    until: timeOfDay(resets),
    project: "Acme app",
  });
  expect(switchDialogFor({ context: { toolInput: { command: "ls" } } })).toBeUndefined();
});
