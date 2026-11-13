import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { cloudHarness } from "./harness.js";

for (const provider of ["claude", "codex"] as const) {
  it(`starts the actual ${provider} worker CLI inside the fake target and delivers native events to the real Cell`, async () => {
    const harness = await cloudHarness(provider);
    const { client, project, orchestrator, target, cell } = harness;
    try {
      const task = await harness.task();
      const deadline = Date.now() + 30000;
      let finished = false;
      while (Date.now() < deadline) {
        const listed = (await client.rpc("task.list", { projectId: project.id })) as {
          items: Array<{ id: string; state: string }>;
        };
        if (
          listed.items.some(
            (row) => row.id === task.id && ["review", "completed"].includes(row.state),
          )
        ) {
          finished = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(finished, JSON.stringify(orchestrator.summaries())).toBe(true);
      const history = (await client.rpc("thread.history", {
        threadId: task.threadId,
        limit: 200,
      })) as { items: Array<{ kind: string; body?: { text?: string } }> };
      expect(
        history.items.some((item) => item.kind === "message" && item.body?.text?.includes("ok")),
      ).toBe(true);
      expect(orchestrator.summaries().filter((job) => job.state === "running")).toHaveLength(1);
      expect(cell.refusedNetwork()).toBe(0);
      await orchestrator.deleteOrg("personal");
      expect(
        await target.find({
          "zoltbot.org": createHash("sha256").update(JSON.stringify("personal")).digest("hex"),
        }),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 90000);
}
