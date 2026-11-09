import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { runtimeApi } from "../../../packages/daemon/src/runtime-api.js";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

async function until(check: () => boolean) {
  for (let tries = 0; tries < 300; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("session_controls_timeout");
}

it("projects titles, modes and background tasks from a native child and drives session controls", async () => {
  const test = await runtimeFixture();
  const calls: string[] = [];
  test.store.dispatch("retire-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "failed" },
      { commandId: "retire-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open(request) {
            const session = await new ReferenceSession({
              identity: { agentId: "profile", threadId: "thread" },
              mode: request.mode,
              cwd: test.root,
              permissionProfile: "read_only",
              hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
            }).open();
            for (const name of ["setMode", "stopBackground", "rewindFiles"] as const) {
              const original = session[name].bind(session) as (...args: unknown[]) => unknown;
              Object.assign(session, {
                [name]: (...args: unknown[]) => {
                  calls.push(`${name}:${args.join(",")}`);
                  return original(...args);
                },
              });
            }
            return session;
          },
        };
      },
    },
  });
  const api = runtimeApi({ store: test.store, manager, publish() {} });
  const call = async (method: string, params: Record<string, unknown>, commandId?: string) =>
    (await api(method, params, commandId)) as Record<string, unknown>;
  const snapshot = () => test.store.snapshot();
  try {
    await call(
      "turn.send",
      { threadId: "thread", input: [{ type: "text", text: "background" }], mode: "queue" },
      "send:background",
    );
    await until(() => snapshot().turn?.some((row) => row.status === "completed") === true);
    const session = snapshot().session?.find((row) => row.state === "ready");
    if (!session) throw new Error("fixture_session_missing");
    const id = String(session.id);
    const tools = snapshot().item?.filter((row) => row.kind === "tool") ?? [];
    const shell = tools.find((row) => (row.body as Record<string, unknown>).name === "Bash");
    expect(shell?.body).toMatchObject({ title: "npm run dev", status: "ok" });
    expect(
      tools.find((row) => (row.body as Record<string, unknown>).name === "AskUserQuestion")?.body,
    ).toMatchObject({ title: "Which port?", interactive: true });
    expect(session.background).toEqual([
      expect.objectContaining({ id: "bg-1", state: "running", toolItemId: shell?.id }),
    ]);

    expect(await call("session.setMode", { id, mode: "plan" }, "mode:plan")).toEqual({ ok: true });
    expect(await call("session.setMode", { id, mode: "plan" }, "mode:plan")).toEqual({ ok: true });
    await expect(call("session.setMode", { id, mode: "default" }, "mode:plan")).rejects.toThrow(
      "command_receipt_conflict",
    );
    await expect(call("session.setMode", { id, mode: "auto" }, "mode:auto")).rejects.toThrow(
      "unsupported_mode",
    );
    await expect(
      call("session.setMode", { id, mode: "bypassPermissions" }, "device:phone:mode"),
    ).rejects.toThrow("mac_only");
    expect(snapshot().session?.find((row) => row.id === id)?.mode).toBe("plan");
    // Widening needs the human's explicit confirmation (I13).
    await expect(
      call("session.setMode", { id, mode: "bypassPermissions" }, "mode:unconfirmed"),
    ).rejects.toThrow("confirmation_required");
    expect(
      await call(
        "session.setMode",
        { id, mode: "bypassPermissions", confirmed: true },
        "mode:bypass",
      ),
    ).toEqual({ ok: true });
    await until(
      () => snapshot().session?.find((row) => row.id === id)?.mode === "bypassPermissions",
    );
    expect(
      snapshot()
        .audit?.filter((row) => row.action === "session.setMode")
        .map((row) => row.detail as Record<string, unknown>)
        .map((detail) => `${detail.mode}:${detail.widensPermission}:${detail.confirmed}`)
        .sort(),
    ).toEqual(["bypassPermissions:true:true", "plan:false:false"]);
    await expect(
      call("session.setMode", { id: "other", mode: "plan" }, "mode:other"),
    ).rejects.toThrow("runtime_session_unavailable");

    // The stop arrives between turns, so the stopped state is projected without a running turn.
    expect(await call("session.stopBackground", { id, taskId: "bg-1" }, "stop:bg")).toEqual({
      ok: true,
    });
    await until(
      () =>
        (
          snapshot().session?.find((row) => row.id === id)?.background as
            | { state: string }[]
            | undefined
        )?.[0]?.state === "stopped",
    );
    await expect(
      call("session.stopBackground", { id, taskId: "bg-1" }, "stop:again"),
    ).rejects.toThrow("background_task_unavailable");

    const turnId = String(snapshot().turn?.[0]?.id);
    const preview = { canRewind: true, files: ["safe.txt"], insertions: 1, deletions: 2 };
    expect(await call("session.rewind", { id, turnId, dryRun: true, confirmed: false })).toEqual(
      preview,
    );
    await expect(
      call("session.rewind", { id, turnId, dryRun: false, confirmed: false }, "rewind:no"),
    ).rejects.toThrow("confirmation_required");
    await expect(
      call("session.rewind", { id, turnId: "missing", dryRun: true, confirmed: false }),
    ).rejects.toThrow("rewind_turn_unavailable");
    const rewind = { id, turnId, dryRun: false, confirmed: true };
    expect(await call("session.rewind", rewind, "rewind:yes")).toEqual(preview);
    expect(await call("session.rewind", rewind, "rewind:yes")).toEqual(preview);
    expect(snapshot().audit?.find((row) => row.action === "session.rewind")).toMatchObject({
      actor: { kind: "human" },
      target: turnId,
      detail: { files: ["safe.txt"], confirmed: true, sessionId: id },
    });
    // Each command reached the provider once; replays used the stored outcome.
    expect(calls).toEqual([
      "setMode:plan",
      "setMode:bypassPermissions",
      "stopBackground:bg-1",
      "rewindFiles:t1,true",
      "rewindFiles:t1,true",
      "rewindFiles:t1,false",
    ]);
  } finally {
    await manager.close();
    test.close();
  }
});
