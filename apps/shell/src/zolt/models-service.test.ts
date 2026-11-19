// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { DaemonClient, Snapshot } from "./daemon-client";
import { toMessages } from "./mapping";
import { modelHandlers } from "./model-handlers";
import {
  modelsService,
  runningLimitFrom,
  switchDialogFor,
  timeOfDay,
  toAccountView,
  toOrders,
} from "./models-service";
import type { ZoltService } from "./zolt-service";

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

it("reads the running-task limit and falls back to 2", () => {
  expect(runningLimitFrom([{ key: "tasks.runningLimit", value: 5 }])).toBe(5);
  expect(runningLimitFrom([])).toBe(2);
  for (const value of [0, 21, 2.5, "3"])
    expect(runningLimitFrom([{ key: "tasks.runningLimit", value }])).toBe(2);
});

it("saves the running-task limit through settings.set", async () => {
  const call = vi.fn().mockResolvedValue({ ok: true });
  const client = { call, rows: () => [{ key: "tasks.runningLimit", value: 4 }] };
  const service = modelsService(client as unknown as DaemonClient);
  expect(await service.runningLimit()).toBe(4);
  expect(await service.setRunningLimit(6)).toBe(6);
  expect(call).toHaveBeenCalledWith(
    "settings.set",
    { key: "tasks.runningLimit", value: 6 },
    expect.any(String),
  );
});

it("refuses running-task limits outside 1 to 20 before reaching the daemon", () => {
  const setRunningLimit = vi.fn();
  const handlers = modelHandlers({ accounts: { setRunningLimit } } as unknown as ZoltService);
  for (const value of [0, 21, 1.5, "3"])
    expect(() => handlers["models:set-running-limit"]?.(value)).toThrow("Choose 1 to 20 tasks.");
  handlers["models:set-running-limit"]?.(20);
  expect(setRunningLimit).toHaveBeenCalledWith(20);
});
