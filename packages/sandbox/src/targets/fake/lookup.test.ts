import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createFakeTarget } from "./index.js";

it("finds only matching live/sleeping resources without waking them or returning environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-lookup-"));
  const target = createFakeTarget({ root });
  try {
    const value = randomBytes(32).toString("base64url"),
      labels = { org: "org", task: "task", operation: "operation" };
    const mine = await target.create({ labels, env: { TOKEN: value } });
    const other = await target.create({ labels: { ...labels, org: "other" } });
    labels.org = "changed";
    await target.sleep(mine);
    const found = await target.find({ org: "org", task: "task" });
    expect(found).toEqual([mine]);
    expect((await target.status(mine)).state).toBe("sleeping");
    expect(JSON.stringify(found).includes(value)).toBe(false);
    expect(await target.find({ org: "other", operation: "operation" })).toEqual([other]);
    await expect(target.find({})).rejects.toMatchObject({ code: "invalid" });
    await target.destroy(mine);
    expect(await target.find({ org: "org" })).toEqual([]);
  } finally {
    await target.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
