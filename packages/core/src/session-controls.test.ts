import { expect, it } from "vitest";
import { applyEvents } from "./projectors.js";
import {
  checkFilesRewind,
  requestBackgroundStop,
  requestFilesRewind,
  requestSessionMode,
  settleSessionMode,
  widensPermission,
} from "./session-controls.js";

const at = "2026-11-05T12:00:00.000Z";
const human = { commandId: "human", at, actor: { kind: "human" as const, id: "local-owner" } };
const system = { commandId: "system", at, actor: { kind: "system" as const, id: "runtime" } };
const state = {
  thread: [{ id: "thread", agentId: "profile" }],
  session: [
    {
      id: "session",
      threadId: "thread",
      provider: "reference",
      cwd: "/work/repo",
      startedAt: at,
      state: "ready",
      mode: "default",
      capabilities: {
        modes: ["default", "plan", "acceptEdits", "bypassPermissions"],
        safeModes: ["default", "plan", "acceptEdits"],
        rewind: true,
        backgroundTasks: true,
      },
      background: [{ id: "dev", kind: "shell", description: "npm run dev", state: "running" }],
    },
  ],
  turn: [{ id: "turn", threadId: "thread", sessionId: "session", status: "completed" }],
};

it("audits every mode change, flags widening, and rejects unadvertised modes or agents", () => {
  const safe = ["default", "plan", "acceptEdits"];
  expect(widensPermission("plan", safe)).toBe(false);
  expect(widensPermission("bypassPermissions", safe)).toBe(true);
  expect(widensPermission("auto", safe)).toBe(true);
  // Without a safe list every mode widens.
  expect(widensPermission("plan", undefined)).toBe(true);
  expect(() => requestSessionMode(state, "session", "bypassPermissions", human)).toThrow(
    "confirmation_required",
  );
  const unlisted = {
    ...state,
    session: state.session.map((row) => ({
      ...row,
      capabilities: { ...row.capabilities, safeModes: undefined },
    })),
  };
  expect(() => requestSessionMode(unlisted, "session", "plan", human)).toThrow(
    "confirmation_required",
  );
  const widened = requestSessionMode(state, "session", "bypassPermissions", human, true);
  expect(widened.result).toEqual({
    kind: "set_mode",
    sessionId: "session",
    mode: "bypassPermissions",
    widens: true,
  });
  expect(applyEvents(state, widened.events).audit?.[0]).toMatchObject({
    id: "audit:human",
    actor: human.actor,
    action: "session.setMode",
    target: "session",
    detail: {
      mode: "bypassPermissions",
      previous: "default",
      widensPermission: true,
      confirmed: true,
    },
  });
  expect(requestSessionMode(state, "session", "plan", human).result).toMatchObject({
    widens: false,
  });
  expect(() => requestSessionMode(state, "session", "auto", human)).toThrow("unsupported_mode");
  expect(() =>
    requestSessionMode(state, "session", "plan", {
      ...human,
      actor: { kind: "agent", id: "profile" },
    }),
  ).toThrow("human_mode_change_required");
  const closed = { ...state, session: state.session.map((row) => ({ ...row, state: "closed" })) };
  expect(() => requestSessionMode(closed, "session", "plan", human)).toThrow(
    "runtime_session_unavailable",
  );
  const settled = applyEvents(state, settleSessionMode(state, "session", "plan", system).events);
  expect(settled.session?.[0]?.mode).toBe("plan");
  expect(settleSessionMode(settled, "session", "plan", system).events).toEqual([]);
});

it("audits background stops only for running tasks on capable sessions", () => {
  const outcome = requestBackgroundStop(state, "session", "dev", human);
  expect(applyEvents(state, outcome.events).audit?.[0]).toMatchObject({
    action: "session.stopBackground",
    target: "dev",
  });
  expect(() => requestBackgroundStop(state, "session", "missing", human)).toThrow(
    "background_task_unavailable",
  );
  const incapable = {
    ...state,
    session: state.session.map((row) => ({ ...row, capabilities: { modes: [] } })),
  };
  expect(() => requestBackgroundStop(incapable, "session", "dev", human)).toThrow(
    "unsupported_background_tasks",
  );
});

it("requires confirmation, an idle session, and a turn of the same thread to rewind files", () => {
  const input = { sessionId: "session", turnId: "turn", confirmed: true, files: ["src/a.ts"] };
  const outcome = requestFilesRewind(state, input, human);
  expect(applyEvents(state, outcome.events).audit?.[0]).toMatchObject({
    actor: human.actor,
    action: "session.rewind",
    target: "turn",
    detail: { files: ["src/a.ts"], confirmed: true, sessionId: "session" },
  });
  expect(() => requestFilesRewind(state, { ...input, confirmed: false }, human)).toThrow(
    "confirmation_required",
  );
  expect(() => requestFilesRewind(state, { ...input, turnId: "other" }, human)).toThrow(
    "rewind_turn_unavailable",
  );
  const foreign = {
    ...state,
    turn: [{ id: "turn", threadId: "elsewhere", sessionId: "x", status: "completed" }],
  };
  expect(() => checkFilesRewind(foreign, "session", "turn")).toThrow("rewind_turn_unavailable");
  const busy = {
    ...state,
    turn: [
      ...state.turn,
      { id: "live", threadId: "thread", sessionId: "session", status: "running" },
    ],
  };
  expect(() => checkFilesRewind(busy, "session", "turn")).toThrow("rewind_requires_idle");
  const incapable = {
    ...state,
    session: state.session.map((row) => ({ ...row, capabilities: { modes: [] } })),
  };
  expect(() => checkFilesRewind(incapable, "session", "turn")).toThrow("unsupported_rewind");
});
