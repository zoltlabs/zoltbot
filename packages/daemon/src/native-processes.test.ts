import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { Redactor } from "./logging.js";
import { NativeProcesses } from "./native-processes.js";

it("runs scoped native transports and redacts frames while retaining protocol bytes", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/native-processes-"));
  const host = new NativeProcesses(root);
  const redactor = new Redactor(["synthetic-private-value"]);
  try {
    const transport = host.connect(
      {
        command: process.execPath,
        args: ["-e", 'process.stdin.on("data", d => process.stdout.write(d))'],
        cwd: root,
        env: { HOME: root },
      },
      redactor,
    );
    const writer = transport.output.getWriter();
    const reader = transport.input.getReader();
    await writer.write(new TextEncoder().encode('{"text":"synthetic-private-value"}\n'));
    const result = await reader.read();
    expect(new TextDecoder().decode(result.value)).toContain("synthetic-private-value");
    await host.close();
    await transport.closed;
    expect((await reader.read()).done).toBe(true);
    const logs = readdirSync(root)
      .map((name) => readFileSync(path.join(root, name), "utf8"))
      .join("");
    expect(logs).toContain("[redacted]");
    expect(logs).not.toContain("synthetic-private-value");
    expect(() =>
      host.connect({ command: process.execPath, args: [], cwd: root, env: {} }, redactor),
    ).toThrow("native_processes_closed");
    await host.close();
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("retires a naturally exited connection without supervising a replacement process", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/native-process-exit-"));
  const host = new NativeProcesses(root);
  try {
    const witness = path.join(root, "starts");
    const transport = host.connect(
      {
        command: process.execPath,
        args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(witness)}, "start\\n")`],
        cwd: root,
        env: { HOME: root },
      },
      new Redactor(),
    );
    await transport.closed;
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(readFileSync(witness, "utf8")).toBe("start\n");
    await transport.close();
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
