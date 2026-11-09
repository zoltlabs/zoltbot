import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { sessionCommands } from "./session-commands.js";
import type { SessionManager } from "./session-manager.js";

it("records failed native mode and stop calls so a retry never repeats or hides them", async () => {
  const test = await runtimeFixture();
  const store = test.store;
  store.dispatch("capable", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "session",
        id: "session",
        changes: {
          capabilities: {
            modes: ["default", "plan", "auto"],
            safeModes: ["default", "plan"],
            backgroundTasks: true,
          },
          background: [{ id: "bg", kind: "shell", description: "dev", state: "running" }],
        },
      },
      { commandId: "capable", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  let attempts = 0;
  const native = {
    async setMode() {
      attempts++;
      throw new Error("provider_refused");
    },
  };
  const manager = {
    live(sessionId: string) {
      if (sessionId !== "session") throw new Error("runtime_session_unavailable");
      return { threadId: "thread", native, worker: { nativeTurnId: () => undefined } };
    },
    track: <T>(work: Promise<T>) => work,
  } as unknown as SessionManager;
  const published: unknown[] = [];
  const api = sessionCommands({ store, manager, publish: (events) => published.push(...events) });
  try {
    await expect(api("session.setMode", { id: "session", mode: "plan" }, "mode")).rejects.toThrow(
      "mode_change_failed",
    );
    await expect(api("session.setMode", { id: "session", mode: "plan" }, "mode")).rejects.toThrow(
      "mode_change_failed",
    );
    expect(attempts).toBe(1);
    expect(store.snapshot().audit?.[0]).toMatchObject({ action: "session.setMode" });
    expect(store.snapshot().session?.[0]?.mode).toBeUndefined();
    expect(published.length).toBeGreaterThan(0);
    // The adapter advertises background tasks but has no stop method.
    await expect(
      api("session.stopBackground", { id: "session", taskId: "bg" }, "stop"),
    ).rejects.toThrow("unsupported_background_tasks");
    expect(() => api("session.setMode", { id: "session", mode: "plan" })).toThrow(
      "command_id_required",
    );
    expect(api("session.unknown", {}, "x")).toBeUndefined();
    // Widening uses the session's safeModes: unconfirmed and phone requests are refused
    // before the provider is called.
    await expect(api("session.setMode", { id: "session", mode: "auto" }, "auto")).rejects.toThrow(
      "confirmation_required",
    );
    await expect(
      api("session.setMode", { id: "session", mode: "auto", confirmed: true }, "device:p:auto"),
    ).rejects.toThrow("mac_only");
    expect(attempts).toBe(1);
  } finally {
    test.close();
  }
});

it("changes model and effort only to what the session offers, once per command id", async () => {
  const test = await runtimeFixture();
  const store = test.store;
  const system = (commandId: string) => ({
    commandId,
    at,
    actor: { kind: "system", id: "runtime" } as const,
  });
  store.dispatch("capable", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "session",
        id: "session",
        changes: {
          model: "sonnet",
          capabilities: {
            models: {
              selectable: true,
              list: [
                { id: "sonnet", name: "Sonnet" },
                { id: "opus", name: "Opus" },
              ],
            },
            effort: ["low", "high"],
          },
        },
      },
      system("capable"),
    ),
  );
  const calls: [string, string | undefined][] = [];
  const native = {
    async setModel(model: string, effort?: string) {
      calls.push([model, effort]);
    },
  };
  const manager = {
    live: () => ({ threadId: "thread", native, worker: { nativeTurnId: () => undefined } }),
    track: <T>(work: Promise<T>) => work,
  } as unknown as SessionManager;
  const api = sessionCommands({ store, manager, publish: () => undefined });
  const session = () => store.snapshot().session?.find((row) => row.id === "session");
  try {
    await expect(
      api("session.setModel", { id: "session", model: "gpt", cacheWarningAccepted: true }, "a"),
    ).rejects.toThrow("unsupported_model");
    await expect(
      api("session.setEffort", { id: "session", effort: "max", cacheWarningAccepted: true }, "b"),
    ).rejects.toThrow("unsupported_effort");
    expect(calls).toEqual([]);

    await api(
      "session.setModel",
      { id: "session", model: "opus", effort: "high", cacheWarningAccepted: false },
      "c",
    );
    // A retry with the same id answers from the receipt and never calls the provider again.
    await api(
      "session.setModel",
      { id: "session", model: "opus", effort: "high", cacheWarningAccepted: false },
      "c",
    );
    expect(calls).toEqual([["opus", "high"]]);
    expect(session()).toMatchObject({ model: "opus", effort: "high" });
    expect(store.snapshot().audit?.at(-1)).toMatchObject({
      action: "session.setModel",
      detail: { model: "opus", effort: "high", previousModel: "sonnet" },
    });

    // Effort alone keeps the model; no effort returns to the model's default.
    await api(
      "session.setEffort",
      { id: "session", effort: "low", cacheWarningAccepted: true },
      "d",
    );
    expect(session()).toMatchObject({ model: "opus", effort: "low" });
    await api(
      "session.setModel",
      { id: "session", model: "sonnet", cacheWarningAccepted: true },
      "e",
    );
    expect(session()?.effort).toBeUndefined();

    // Once the session has run a turn, a change drops the prompt cache: the caller must say so.
    test.queue("first", "Hello");
    store.dispatch("turn", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "turn",
          value: {
            id: "t1",
            threadId: "thread",
            sessionId: "session",
            status: "running",
            origin: "human",
            startedAt: at,
          },
        },
        system("turn"),
      ),
    );
    await expect(
      api("session.setModel", { id: "session", model: "opus", cacheWarningAccepted: false }, "f"),
    ).rejects.toThrow("cache_warning_required");
  } finally {
    test.close();
  }
});
