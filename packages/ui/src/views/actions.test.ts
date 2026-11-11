import { parse, ViewRecordSchema } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import snapshotFixture from "../../../view-api/src/fixtures/snapshot.json" with { type: "json" };
import { viewActions } from "./actions.js";

function fixture() {
  const snapshot = structuredClone(snapshotFixture);
  const record = parse(ViewRecordSchema, {
    id: "example",
    name: "Example",
    source: "user",
    version: "1.0.0",
    api: 1,
    entry: "index.html",
    slots: ["page"],
    bundleHash: "hash",
    requested: ["read", "act", "approve"],
    granted: ["read"],
    enabled: true,
    overridesBuiltin: false,
  });
  const call = vi.fn(async () => ({ ok: true })),
    confirm = vi.fn(async () => true),
    open = vi.fn();
  return {
    snapshot,
    record,
    call,
    confirm,
    open,
    run: viewActions({ record: () => record, snapshot: () => snapshot, call, confirm, open }),
  };
}
it.each([
  "chats.send",
  "chats.interrupt",
  "requests.answer",
])("denies %s without its grant in the host", async (method) => {
  const f = fixture();
  await expect(f.run(method, {})).rejects.toMatchObject({ code: "not_granted" });
  expect(f.call).not.toHaveBeenCalled();
  expect(f.confirm).not.toHaveBeenCalled();
});
it("waits for the host's own widening confirmation and declines without answering", async () => {
  const f = fixture();
  f.record.granted.push("approve");
  const request = f.snapshot.entities.interaction[0];
  if (!request) throw Error("fixture");
  request.items[0]?.choices.push({ id: "allow_session" });
  let finish: (value: boolean) => void = () => {};
  f.confirm.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const work = f.run("requests.answer", {
    requestId: request.id,
    version: request.version,
    choiceId: "allow_session",
  });
  expect(f.call).not.toHaveBeenCalled();
  finish(false);
  await expect(work).rejects.toMatchObject({ code: "declined" });
  expect(f.call).not.toHaveBeenCalled();
});
it("rechecks request versions and grants after host confirmation", async () => {
  const f = fixture();
  f.record.granted.push("approve");
  const request = f.snapshot.entities.interaction[0];
  if (!request) throw Error("fixture");
  request.items[0]?.choices.push({ id: "allow_session" });
  f.confirm.mockImplementation(async () => {
    request.version++;
    return true;
  });
  await expect(
    f.run("requests.answer", {
      requestId: request.id,
      version: request.version,
      choiceId: "allow_session",
    }),
  ).rejects.toMatchObject({ code: "stale" });
  expect(f.call).not.toHaveBeenCalled();
});
it("scopes storage calls to the host's view id and unwraps the internal result", async () => {
  const f = fixture();
  f.call.mockResolvedValue({ value: { groups: ["chat"] } } as unknown as { ok: boolean });
  expect(await f.run("storage.get", {})).toEqual({ groups: ["chat"] });
  expect(f.call).toHaveBeenCalledWith("view.state.get", { id: "example" }, expect.any(String));
  await f.run("storage.set", { value: { layout: {} } });
  expect(f.call).toHaveBeenLastCalledWith(
    "view.state.set",
    { id: "example", value: { layout: {} } },
    expect.any(String),
  );
  f.record.granted = [];
  await expect(f.run("storage.get", {})).rejects.toMatchObject({ code: "not_granted" });
  await expect(f.run("storage.set", { value: {} })).rejects.toMatchObject({ code: "not_granted" });
});
