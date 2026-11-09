import { expect, it } from "vitest";
import { type AdoptionHost, NativeAdoption } from "./native-adoption.js";

function fixture() {
  const calls: string[] = [];
  const host: AdoptionHost = {
    inspect: async () => ({ state: "clear", pids: [] }),
    open: async (mode) => {
      calls.push(mode);
      return {
        nativeId: mode === "fork" ? "forked" : "original",
        close: async () => {
          calls.push("close");
        },
      };
    },
    commit: async () => {
      calls.push("commit");
      return { threadId: "thread" };
    },
  };
  return {
    host,
    calls,
    request: {
      provider: "codex",
      nativeId: "original",
      agentId: "profile",
      choice: "adopt" as const,
      confirmed: true,
    },
  };
}
it("requires consent and never attaches when ownership is busy or unknown", async () => {
  const test = fixture();
  const adoption = new NativeAdoption(test.host);
  await expect(adoption.run({ ...test.request, confirmed: false })).rejects.toThrow(
    "adoption_confirmation_required",
  );
  for (const state of ["busy", "unknown"] as const) {
    test.host.inspect = async () => ({ state, pids: [], recommendation: "fork" });
    expect(await adoption.run(test.request)).toMatchObject({
      state: "blocked",
      recommendation: "fork",
      options: ["fork", "wait"],
    });
  }
  expect(test.calls).toEqual([]);
});
it("opens a clear session before committing its link and closes it when commit fails", async () => {
  const test = fixture();
  const adoption = new NativeAdoption(test.host);
  expect(await adoption.run(test.request)).toEqual({
    state: "adopted",
    nativeId: "original",
    threadId: "thread",
  });
  expect(test.calls).toEqual(["resume", "commit"]);
  test.host.commit = async () => {
    throw new Error("storage_failed");
  };
  await expect(adoption.run(test.request)).rejects.toThrow("storage_failed");
  expect(test.calls.at(-1)).toBe("close");
});
it("waits without opening and allows only a distinct explicit fork", async () => {
  const test = fixture();
  test.host.inspect = async () => ({ state: "busy", pids: [99], recommendation: "fork" });
  const adoption = new NativeAdoption(test.host);
  expect(await adoption.run({ ...test.request, choice: "wait" })).toEqual({ state: "waiting" });
  expect(test.calls).toEqual([]);
  expect(await adoption.run({ ...test.request, choice: "fork" })).toMatchObject({
    state: "adopted",
    nativeId: "forked",
  });
  test.host.open = async () => ({
    nativeId: "original",
    close: async () => {
      test.calls.push("close");
    },
  });
  await expect(adoption.run({ ...test.request, choice: "fork" })).rejects.toThrow(
    "fork_identity_unchanged",
  );
  expect(test.calls.at(-1)).toBe("close");
});
it("reserves concurrent adoption before inspection and releases a failed attempt", async () => {
  const test = fixture();
  let finish = (_value: { state: "clear"; pids: number[] }) => {};
  test.host.inspect = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const adoption = new NativeAdoption(test.host);
  const first = adoption.run(test.request);
  await expect(adoption.run(test.request)).rejects.toThrow("native_adoption_in_progress");
  finish({ state: "clear", pids: [] });
  await first;
  test.host.inspect = async () => {
    throw new Error("inspection_failed");
  };
  await expect(adoption.run(test.request)).rejects.toThrow("inspection_failed");
  test.host.inspect = async () => ({ state: "clear", pids: [] });
  expect(await adoption.run(test.request)).toMatchObject({ state: "adopted" });
});
