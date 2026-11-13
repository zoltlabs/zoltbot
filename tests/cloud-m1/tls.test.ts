import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { loopbackTls } from "./tls.js";

it("trusts the harness's ephemeral loopback certificate in an isolated child with TLS verification enabled", async () => {
  const tls = await loopbackTls();
  const server = tls.server((_request, response) => response.end("loopback"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `try { const response = await fetch(${JSON.stringify(url)}); process.exitCode = response.ok && await response.text() === "loopback" ? 0 : 2; } catch { process.exitCode = 3; }`,
        ],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...tls.childEnvironment() },
          stdio: "ignore",
        },
      );
      child.once("error", () => reject(new Error("fixture_child_failed")));
      child.once("exit", resolve);
    });
    expect(code).toBe(0);
    expect(JSON.stringify(tls)).toBe("{}");
    expect(tls.childEnvironment().NODE_OPTIONS.includes("NODE_TLS_REJECT_UNAUTHORIZED")).toBe(
      false,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
