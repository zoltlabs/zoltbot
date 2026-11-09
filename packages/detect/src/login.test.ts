import { expect, it } from "vitest";
import { checkLogin } from "./login.js";

const run = async () => ({
  code: 0,
  stdout: JSON.stringify({
    loggedIn: true,
    email: "private@example.com",
    orgName: "private org",
    subscriptionType: "max",
    apiKey: "private",
  }),
  stderr: "",
});
it("returns only parsed login state and gives configured keys precedence", async () => {
  expect(
    await checkLogin({
      adapter: "claude",
      command: "claude",
      args: ["auth", "status"],
      cwd: ".",
      runner: run,
    }),
  ).toEqual({ state: "signed_in", plan: "Max plan" });
  expect(
    await checkLogin({
      adapter: "claude",
      command: "claude",
      args: [],
      cwd: ".",
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ loggedIn: true, subscriptionType: "private@example.com" }),
        stderr: "",
      }),
    }),
  ).toEqual({ state: "signed_in" });
  expect(
    await checkLogin({
      adapter: "codex",
      command: "codex",
      args: ["login", "status"],
      cwd: ".",
      runner: async () => ({ code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" }),
    }),
  ).toEqual({ state: "signed_in", plan: "ChatGPT" });
  expect(
    await checkLogin({
      adapter: "claude",
      command: "claude",
      args: [],
      cwd: ".",
      apiKeyConfigured: true,
      runner: async () => {
        throw new Error("must not run");
      },
    }),
  ).toEqual({ state: "api_key_configured" });
});
it("never infers login from auth methods or process success alone", async () => {
  for (const stdout of ["", "{}", JSON.stringify({ authMethods: [{ id: "oauth" }] })]) {
    expect(
      await checkLogin({
        adapter: "acp",
        command: "agent",
        args: [],
        cwd: ".",
        runner: async () => ({ code: 0, stdout, stderr: "" }),
      }),
    ).toEqual({ state: "unknown" });
  }
  expect(
    await checkLogin({
      adapter: "claude",
      command: "claude",
      args: [],
      cwd: ".",
      runner: async () => ({
        code: 1,
        stdout: '{"loggedIn":false}',
        stderr: "private detail",
      }),
    }),
  ).toEqual({ state: "signed_out" });
});
it("parses Cursor status output without returning account details", async () => {
  const spinner =
    " Starting login process...\n\n\u001b[2K\u001b[1A\u001b[2K\u001b[GChecking authentication status...\n\u001b[2K\u001b[G\n";
  const check = (stdout: string) =>
    checkLogin({
      adapter: "cursor",
      command: "cursor-agent",
      args: ["status"],
      cwd: ".",
      runner: async () => ({ code: 0, stdout, stderr: "" }),
    });
  expect(await check(`${spinner} ✓ Logged in as private@example.com\n`)).toEqual({
    state: "signed_in",
  });
  expect(await check(`${spinner} Not logged in\n`)).toEqual({
    state: "signed_out",
  });
  expect(await check(spinner)).toEqual({ state: "unknown" });
});
