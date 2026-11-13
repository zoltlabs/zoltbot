import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runConformance, scenarios } from "../../conformance/index.js";
import { createFakeTarget } from "./index.js";

const target = createFakeTarget({ root: ".cache/tests/sandbox-fake" });
afterAll(() => target.dispose());

describe("fake execution target", () => {
  it.each(scenarios)("passes conformance: %s", (scenario) => runConformance(target, scenario));
});
it("ends processes when sleepKeepsProcesses is false and wakes with the same files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake-sleep-without-processes-"));
  const target = createFakeTarget({ root, capabilities: { sleepKeepsProcesses: false } });
  try {
    const ref = await target.create();
    await target.files.write(ref, "saved", "preserved");
    const process = await target.exec(ref, ["/bin/sh", "-c", "printf ready; sleep 60"]);
    const output = process[Symbol.asyncIterator]();
    expect((await output.next()).value?.data).toBe("ready");
    await target.sleep(ref);
    expect((await process.exit).code).toBeNull();
    expect((await target.status(ref)).state).toBe("sleeping");
    await target.wake(ref);
    expect(new TextDecoder().decode(await target.files.read(ref, "saved"))).toBe("preserved");
    const fresh = await target.exec(ref, ["/bin/sh", "-c", "printf restarted"]);
    let text = "";
    for await (const chunk of fresh) text += chunk.data;
    expect(text).toBe("restarted");
    expect((await fresh.exit).code).toBe(0);
  } finally {
    await target.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("retries termination when a process group misses the first kill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake-sleep-retry-")),
    target = createFakeTarget({ root, capabilities: { sleepKeepsProcesses: false } }),
    kill = process.kill.bind(process);
  let pid: number | undefined,
    child: Awaited<ReturnType<typeof target.exec>> | undefined,
    restore: (() => void) | undefined;
  try {
    const ref = await target.create();
    child = await target.exec(ref, ["/bin/sh", "-c", "printf '%s' $$; exec sleep 60"]);
    const output = child[Symbol.asyncIterator]();
    pid = Number((await output.next()).value?.data);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    let missed = false;
    const spy = vi.spyOn(process, "kill").mockImplementation((selected, signal) => {
      if (selected === -(pid ?? 0) && signal === "SIGKILL" && !missed) {
        missed = true;
        return true;
      }
      return kill(selected, signal);
    });
    restore = () => spy.mockRestore();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        target.sleep(ref),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("owned_process_did_not_stop")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(missed).toBe(true);
    expect((await child.exit).code).toBeNull();
    expect((await target.status(ref)).state).toBe("sleeping");
  } finally {
    restore?.();
    await child?.kill();
    await child?.exit;
    await target.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses processless sleep when termination cannot be confirmed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fake-sleep-refusal-")),
    target = createFakeTarget({ root, capabilities: { sleepKeepsProcesses: false } }),
    kill = process.kill.bind(process);
  let child: Awaited<ReturnType<typeof target.exec>> | undefined, restore: (() => void) | undefined;
  try {
    const ref = await target.create();
    child = await target.exec(ref, ["/bin/sh", "-c", "printf '%s' $$; exec sleep 60"]);
    const pid = Number((await child[Symbol.asyncIterator]().next()).value?.data);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const spy = vi.spyOn(process, "kill").mockImplementation((selected, signal) => {
      if (selected === -pid && signal === "SIGKILL") return true;
      return kill(selected, signal);
    });
    restore = () => spy.mockRestore();
    await expect(target.sleep(ref)).rejects.toThrow("Fake processes did not stop");
    expect((await target.status(ref)).state).toBe("running");
  } finally {
    restore?.();
    await child?.kill();
    await child?.exit;
    await target.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
