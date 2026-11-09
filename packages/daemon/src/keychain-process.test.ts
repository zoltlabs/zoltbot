import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { keychainProcess } from "./keychain-process.js";

it("passes private values only on stdin and isolates helper environment and diagnostics", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/keychain-process-"));
  vi.stubEnv("ZOLTBOT_KEYCHAIN_PRIVATE_SENTINEL", "synthetic-private-parent-value");
  try {
    const file = path.join(root, "helper.mjs");
    writeFileSync(
      file,
      `let input=''; for await (const chunk of process.stdin) input+=chunk; const request=JSON.parse(input); if (process.argv.length!==2 || process.env.ZOLTBOT_KEYCHAIN_PRIVATE_SENTINEL || process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS) process.exit(1); process.stderr.write('synthetic-private-diagnostic'); process.stdout.write(JSON.stringify({ok:true,value:request.value}));`,
    );
    const transport = keychainProcess({ command: process.execPath, args: [file], cwd: root });
    expect(
      await transport({ op: "put", account: "fixture", value: "synthetic-private-value" }),
    ).toEqual({ ok: true, value: "synthetic-private-value" });
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  "hang",
  "overflow",
  "malformed",
  "exit",
])("bounds %s helpers and exposes only a generic error", async (mode) => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/keychain-failure-"));
  try {
    const file = path.join(root, "helper.mjs");
    writeFileSync(
      file,
      mode === "hang"
        ? "setInterval(()=>{},1000)"
        : mode === "overflow"
          ? "process.stdout.write('x'.repeat(65537)); setInterval(()=>{},1000)"
          : mode === "malformed"
            ? "process.stdout.write('synthetic-private-malformed')"
            : "process.stderr.write('synthetic-private-error'); process.exit(1)",
    );
    const transport = keychainProcess({
      command: process.execPath,
      args: [file],
      cwd: root,
      timeoutMs: 200,
    });
    await expect(transport({ op: "get", account: "fixture" })).rejects.toThrow(
      /^keychain_unavailable$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
