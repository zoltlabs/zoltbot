import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startDaemon } from "../api.js";

it("owns a separate cloud host lifetime without providing the Local store or runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-cloud-daemon-"));
  let starts = 0,
    closes = 0;
  const daemon = await startDaemon({
    dataDir: root,
    cloudRunner(input) {
      starts++;
      expect(Object.keys(input).sort()).toEqual(["dataDir", "status"]);
      expect(input.dataDir).toBe(path.join(root, "cloud"));
      return {
        async close() {
          closes++;
        },
      };
    },
  });
  try {
    expect(starts).toBe(1);
    expect(closes).toBe(0);
    await Promise.all([daemon.close(), daemon.close()]);
    expect(closes).toBe(1);
    const reopened = await startDaemon({ dataDir: root });
    await reopened.close();
    expect(starts).toBe(1);
    expect(closes).toBe(1);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
