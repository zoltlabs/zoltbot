import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { Logger, Redactor } from "./logging.js";
import { Supervisor } from "./supervisor.js";
import { supervisedTransport } from "./transport.js";

it("bridges supervised stdio, filters inherited environment, and redacts bounded frames", async () => {
  mkdirSync(".cache/test-tmp", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/test-tmp/transport-"));
  const frameFile = path.join(dir, "frames.jsonl");
  const supervisor = new Supervisor(
    {
      command: process.execPath,
      args: [
        "-e",
        'process.stdin.on("data", d => { process.stdout.write(d); process.stdout.write(JSON.stringify({ leaked: process.env.ZOLTBOT_UNLISTED_SECRET ?? false }) + "\\n"); });',
      ],
      cwd: dir,
      env: { HOME: dir },
      frameFile,
      frameLimitBytes: 2048,
      killGraceMs: 30,
    },
    new Logger(path.join(dir, "log.jsonl"), new Redactor(["seeded-secret"])),
  );
  process.env.ZOLTBOT_UNLISTED_SECRET = "must-not-inherit";
  const transport = supervisedTransport(supervisor);
  const writer = transport.output.getWriter();
  const reader = transport.input.getReader();
  try {
    await writer.write(new TextEncoder().encode('{"token":"seeded-secret","n":1}\n'));
    let output = "";
    while (!output.includes('"leaked":false')) {
      const result = await reader.read();
      if (result.done) throw new Error("early exit");
      output += new TextDecoder().decode(result.value);
    }
    expect(output).toContain("seeded-secret");
    const frames = readFileSync(frameFile, "utf8");
    expect(frames).not.toContain("seeded-secret");
    expect(frames.length).toBeLessThanOrEqual(2048);
  } finally {
    delete process.env.ZOLTBOT_UNLISTED_SECRET;
    reader.releaseLock();
    writer.releaseLock();
    await transport.close();
    await transport.closed;
    expect(supervisor.status).toBe("closed");
    rmSync(dir, { recursive: true, force: true });
  }
});
