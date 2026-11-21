import { afterEach, expect, it, vi } from "vitest";
import { compareFixture } from "../../../tools/fakes/src/compare-fixture.js";
import { run } from "./cli.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** R5: the zolt command against a real daemon with fake agents. */
it("reads status and asks an agent through the running daemon", async () => {
  const fixture = await compareFixture();
  vi.stubEnv("ZOLTBOT_DATA_DIR", fixture.daemon.dataDir);
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    expect(await run(["status", "--json"])).toBe(0);
    const report = JSON.parse(lines[0] ?? "") as { chats: { id: string; title: string }[] };
    const chat = report.chats[0];
    expect(chat).toBeDefined();
    lines.length = 0;
    expect(await run(["ask", String(chat?.id), "Say hello", "--json", "--timeout", "20"])).toBe(0);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ chat: chat?.id, status: "done" });
  } finally {
    await fixture.close();
  }
}, 30_000);

it("says when Zoltbot isn't running", async () => {
  vi.stubEnv("ZOLTBOT_DATA_DIR", "/nonexistent-zoltbot-data");
  await expect(run(["status"])).rejects.toThrow("Zoltbot isn't running");
});
