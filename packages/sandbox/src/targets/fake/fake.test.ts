import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
