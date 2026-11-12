import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { MacExecution } from "./mac-exec.js";
import { type MacProcessOptions, macCommandProcess } from "./mac-exec-process.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mac-command-"));
  folders.push(root);
  const options: MacProcessOptions = {
    directory: path.join(root, "output"),
    mac: "Test Mac",
    shell: process.platform === "darwin" ? "/bin/zsh" : "/bin/sh",
    environment: { HOME: root, ZDOTDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
  };
  const input = (command: string): MacExecution => ({
    requestId: "request",
    taskId: "task",
    command,
    cwd: root,
    stdin: "",
    timeoutSeconds: 10,
  });
  const logs = () =>
    readdirSync(options.directory).map((file) => ({
      file: path.join(options.directory, file),
      frames: readFileSync(path.join(options.directory, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { chunkSeq: number; stream: string; data: string }),
    }));
  return { root, options, input, logs, execute: macCommandProcess(options) };
}
it("runs a headless uname command in an isolated shell and records its streamed output", async () => {
  const f = fixture(),
    chunks: string[] = [];
  f.options.chunk = (frame) => {
    chunks.push(frame.data);
  };
  const result = await f.execute(f.input("uname"), new AbortController().signal);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe(os.type());
  expect(chunks.join("")).toBe(result.stdout);
  expect(
    f
      .logs()[0]
      ?.frames.map((frame) => frame.data)
      .join(""),
  ).toBe(result.stdout);
  expect(statSync(f.logs()[0]?.file ?? "").mode & 0o777).toBe(0o600);
});
it("returns ordinary failure and timeout exit codes with partial output", async () => {
  const f = fixture();
  expect((await f.execute(f.input("false"), new AbortController().signal)).exitCode).toBe(1);
  const result = await f.execute(
    {
      ...f.input("printf ready; printf warning >&2; sleep 10"),
      requestId: "timeout",
      timeoutSeconds: 1,
    },
    new AbortController().signal,
  );
  expect(result.exitCode).toBe(124);
  expect(result.stdout).toBe("ready");
  expect(result.stderr).toBe("warning");
  expect(result.durationMs).toBeLessThan(3000);
});
it("caps UTF-8 result bytes while retaining all output in a durable ordered local log", async () => {
  const f = fixture();
  const source =
    "process.stdout.write('🌈'.repeat(70000)+'DONE');process.stderr.write('x'.repeat(70000)+'ERR')";
  const result = await f.execute(
    f.input(`${quote(process.execPath)} -e ${quote(source)}`),
    new AbortController().signal,
  );
  expect(result.exitCode).toBe(0);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256 * 1024);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
  expect(result.stdout.endsWith("DONE")).toBe(true);
  expect(result.stdout.includes("�")).toBe(false);
  expect(result.stderr.endsWith("ERR")).toBe(true);
  expect(result.stdoutBytes).toBe(280004);
  expect(result.stderrBytes).toBe(70003);
  const frames = f.logs()[0]?.frames ?? [];
  expect(frames.every((frame) => Buffer.byteLength(frame.data) <= 65536)).toBe(true);
  expect(frames.map((frame) => frame.chunkSeq)).toEqual(frames.map((_, i) => i + 1));
  expect(
    Buffer.byteLength(
      frames
        .filter((frame) => frame.stream === "stdout")
        .map((frame) => frame.data)
        .join(""),
    ),
  ).toBe(280004);
  expect(
    Buffer.byteLength(
      frames
        .filter((frame) => frame.stream === "stderr")
        .map((frame) => frame.data)
        .join(""),
    ),
  ).toBe(70003);
});
it("retains approved output when the delivery port fails and refuses another execution with the same log ID", async () => {
  const f = fixture();
  f.options.chunk = () => {
    throw new Error("synthetic_offline");
  };
  const marker = path.join(f.root, "marker"),
    input = f.input(`printf x >> ${quote(marker)}; printf done`);
  expect((await f.execute(input, new AbortController().signal)).stdout).toBe("done");
  await expect(f.execute(input, new AbortController().signal)).rejects.toThrow(
    /^mac_exec_unavailable$/,
  );
  expect(readFileSync(marker, "utf8")).toBe("x");
  expect(
    f
      .logs()[0]
      ?.frames.map((frame) => frame.data)
      .join(""),
  ).toBe("done");
});
it("kills its owned process group on cancellation and refuses oversized stdin before spawning", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.options.chunk = () => controller.abort();
  await expect(f.execute(f.input("printf ready; sleep 10"), controller.signal)).rejects.toThrow(
    /^mac_exec_unavailable$/,
  );
  await expect(
    f.execute(
      { ...f.input("cat"), requestId: "large", stdin: "🌈".repeat(20000) },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/^mac_exec_unavailable$/);
  expect(f.logs()).toHaveLength(1);
});
it("redacts configured credentials across output chunks before any file, result or delivery", async () => {
  const f = fixture(),
    value = randomBytes(32).toString("base64url"),
    delivered: string[] = [];
  f.options.environment.GITHUB_TOKEN = value;
  f.options.chunk = (frame) => {
    delivered.push(frame.data);
  };
  const source =
    "const k=process.env.GITHUB_TOKEN;process.stdout.write('before '+k.slice(0,13));setTimeout(()=>process.stdout.write(k.slice(13)+' after'),30)";
  const result = await f.execute(
    f.input(`${quote(process.execPath)} -e ${quote(source)}`),
    new AbortController().signal,
  );
  expect(result.stdout).toBe("before [redacted] after");
  expect(delivered.join("").includes(value)).toBe(false);
  expect(f.logs().every((entry) => !readFileSync(entry.file, "utf8").includes(value))).toBe(true);
});
it("keeps chunks bounded when redaction expands a short credential", async () => {
  const f = fixture();
  f.options.privateValues = () => ["aa"];
  const result = await f.execute(
    f.input(`${quote(process.execPath)} -e ${quote("process.stdout.write('a'.repeat(70000))")}`),
    new AbortController().signal,
  );
  expect(result.exitCode).toBe(0);
  const frames = f.logs()[0]?.frames ?? [];
  expect(frames.every((frame) => Buffer.byteLength(frame.data) <= 65536)).toBe(true);
  expect(frames.map((frame) => frame.data).join("")).toBe("[redacted]".repeat(35000));
});
