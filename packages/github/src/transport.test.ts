import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ghTransport } from "./transport.js";

test("GitHub subprocess is noninteractive, pinned to github.com, bounded, cancellable, and sanitizes errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zoltbot-gh-"));
  const program = `#!${process.execPath}\nlet input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{
    if(process.env.ZOLTBOT_TEST_GH==='denied'){process.stderr.write('HTTP 403 private-fake-secret');process.exit(1);}
    if(process.env.ZOLTBOT_TEST_GH==='rate'){process.stdout.write('HTTP/2 429 Too Many Requests\\r\\nRetry-After: 120\\r\\n\\r\\n{}');process.stderr.write('HTTP 429');process.exit(1);}
    if(process.env.ZOLTBOT_TEST_GH==='hang'){setInterval(()=>{},1000);return;}
    if(process.env.ZOLTBOT_TEST_GH==='invalid'){process.stdout.write('invalid-secret');return;}
    process.stdout.write(JSON.stringify({args:process.argv.slice(2),body:input,host:process.env.GH_HOST,debug:process.env.GH_DEBUG,prompt:process.env.GH_PROMPT_DISABLED}));
  });`;
  await writeFile(path.join(directory, "gh"), program, { mode: 0o755 });
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("GH_HOST", "untrusted.example");
  vi.stubEnv("GH_DEBUG", "api");
  try {
    const body = { query: "query{viewer{login}}" };
    expect(await ghTransport("graphql", "POST", body)).toEqual({
      args: [
        "api",
        "--hostname",
        "github.com",
        "--include",
        "--method",
        "POST",
        "--input",
        "-",
        "graphql",
      ],
      body: JSON.stringify(body),
      prompt: "1",
    });
    vi.stubEnv("ZOLTBOT_TEST_GH", "denied");
    await expect(ghTransport("/user")).rejects.toThrow(/^github_access_denied$/);
    vi.stubEnv("ZOLTBOT_TEST_GH", "rate");
    await expect(ghTransport("/user")).rejects.toMatchObject({
      message: "github_rate_limited",
      retryAfterMs: 120000,
    });
    vi.stubEnv("ZOLTBOT_TEST_GH", "invalid");
    await expect(ghTransport("/user")).rejects.toThrow(/^github_response_invalid$/);
    vi.stubEnv("ZOLTBOT_TEST_GH", "hang");
    const abort = new AbortController();
    const request = ghTransport("/user", "GET", undefined, abort.signal);
    const timer = setTimeout(() => abort.abort(), 100);
    await expect(request).rejects.toThrow(/^github_request_cancelled$/);
    clearTimeout(timer);
    await expect(ghTransport("https://untrusted.example/user")).rejects.toThrow(
      "github_endpoint_invalid",
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
