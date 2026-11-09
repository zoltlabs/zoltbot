import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { expect, it } from "vitest";
import { CodexRpc } from "./rpc.js";
import { CodexSchemas } from "./schema.js";

const schema = JSON.parse(readFileSync("fixtures/codex/0.164.0/protocol.schema.json", "utf8"));
function connection(scenario = "codex-account") {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("tools/fakes/src/fake-codex.ts"),
      path.resolve(`tools/fakes/scenarios/${scenario}.yaml`),
    ],
    {
      env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", TMPDIR: path.resolve(".cache/tmp") },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return {
    input: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    output: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    closed,
    async close() {
      child.kill("SIGTERM");
      await closed;
    },
  };
}
it("performs the required handshake before account detection without exposing account data", async () => {
  const rpc = new CodexRpc(connection(), new CodexSchemas(schema), 1500);
  try {
    const result = await rpc.initialize(false);
    expect(result.account).toMatchObject({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(result.providerVersion).toBe("fake-codex");
  } finally {
    await rpc.close();
  }
});
it("bounds a hung request and closes the transport", async () => {
  const rpc = new CodexRpc(connection(), new CodexSchemas(schema), 1000);
  await rpc.initialize(false);
  try {
    await expect(rpc.request("config/read", { includeLayers: false })).rejects.toThrow(
      "request_timeout",
    );
  } finally {
    await rpc.close();
  }
});

it("retries an explicit overload response with a bounded backoff", async () => {
  const rpc = new CodexRpc(connection("codex-overload"), new CodexSchemas(schema), 1500, 5);
  try {
    await rpc.initialize(false);
    await expect(
      rpc.request("thread/name/set", { threadId: "t", name: "Renamed" }),
    ).resolves.toEqual({});
  } finally {
    await rpc.close();
  }
});
