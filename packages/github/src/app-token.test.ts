import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  installationTokenRequest,
  parseInstallationToken,
} from "../../cloud-contracts/src/github-app.js";
import { botTransport, installationTokens } from "./app-token.js";
import { ghTransport } from "./transport.js";

const TOKEN = `ghs_${"a".repeat(36)}`;
/** A fake cloud that exchanges the app key for installation tokens, as GitHub would. */
function fakeCloud(installed: Record<string, number>, clock: { now: number }) {
  const calls: unknown[] = [];
  const request = vi.fn(async (repo: string, installationId?: number) => {
    calls.push(installationTokenRequest(repo, installationId));
    const id = installed[repo];
    if (!id) return parseInstallationToken({ installed: false });
    return parseInstallationToken(
      {
        installed: true,
        installationId: id,
        token: TOKEN,
        expiresAt: new Date(clock.now + 60 * 60 * 1000).toISOString(),
      },
      clock.now,
    );
  });
  return { request, calls };
}

describe("GitHub App installation tokens (I8)", () => {
  it("exchanges once per hour per repository and remembers the installation", async () => {
    const clock = { now: Date.parse("2026-11-21T12:00:00Z") };
    const cloud = fakeCloud({ "acme/shop": 42 }, clock);
    const tokens = installationTokens({ request: cloud.request, now: () => clock.now });
    expect(await tokens.token("acme/shop")).toBe(TOKEN);
    expect(await tokens.token("Acme/Shop")).toBe(TOKEN);
    expect(cloud.request).toHaveBeenCalledTimes(1);
    clock.now += 56 * 60 * 1000; // inside the five-minute margin
    await tokens.token("acme/shop");
    expect(cloud.calls.at(-1)).toEqual({ repo: "acme/shop", installationId: 42 });
  });

  it("falls back to the owner when the app isn't installed or the cloud fails", async () => {
    const clock = { now: 0 };
    const cloud = fakeCloud({}, clock);
    const errors: string[] = [];
    const tokens = installationTokens({ request: cloud.request, now: () => clock.now });
    expect(await tokens.token("acme/other")).toBeUndefined();
    expect(await tokens.token("acme/other")).toBeUndefined();
    expect(cloud.request).toHaveBeenCalledTimes(1);
    const broken = installationTokens({
      request: async () => {
        throw new Error("account_service_unavailable");
      },
      onError: (code) => errors.push(code),
    });
    expect(await broken.token("acme/shop")).toBeUndefined();
    // A failure is remembered for a minute, so writes don't wait on the cloud each time.
    expect(await broken.token("acme/shop")).toBeUndefined();
    expect(errors).toEqual(["github_bot_token_unavailable"]);
  });

  it("refuses anything but a live installation token from the cloud", () => {
    expect(() =>
      parseInstallationToken({
        installed: true,
        installationId: 1,
        token: "gho_user",
        expiresAt: "2999-01-01T00:00:00Z",
      }),
    ).toThrow("github_installation_token_invalid");
    expect(() =>
      parseInstallationToken({
        installed: true,
        installationId: 1,
        token: TOKEN,
        expiresAt: "2000-01-01T00:00:00Z",
      }),
    ).toThrow("github_installation_token_invalid");
    expect(() => installationTokenRequest("acme/shop/../x")).toThrow("github_repository_invalid");
    expect(() => installationTokenRequest("../..")).toThrow("github_repository_invalid");
  });

  it("uses the bot only for pull request writes, and only while turned on", async () => {
    const tokens = { token: vi.fn(async () => TOKEN) };
    let enabled = true;
    const seen: (string | undefined)[] = [];
    const transport = botTransport({ tokens, enabled: () => enabled }, async (...args) => {
      seen.push(args[4]);
      return {};
    });
    await transport("/repos/acme/shop/pulls", "POST", {});
    await transport("/repos/acme/shop/issues/7/comments", "POST", {});
    await transport("/repos/acme/shop/pulls/7/merge", "PUT", {});
    await transport("/repos/acme/shop/pulls", "GET");
    await transport("graphql", "POST", {});
    enabled = false;
    await transport("/repos/acme/shop/pulls", "POST", {});
    expect(seen).toEqual([TOKEN, undefined, undefined, undefined, undefined, undefined]);
  });

  it("opens the pull request as the owner when GitHub refuses the bot's token", async () => {
    const forget = vi.fn();
    const tokens = { token: vi.fn(async () => TOKEN), forget };
    const seen: (string | undefined)[] = [];
    let refuse: string | undefined = "github_access_denied";
    const transport = botTransport({ tokens, enabled: () => true }, async (...args) => {
      seen.push(args[4]);
      if (args[4] && refuse) throw new Error(refuse);
      return { number: 7 };
    });
    expect(await transport("/repos/acme/shop/pulls", "POST", {})).toEqual({ number: 7 });
    expect(seen).toEqual([TOKEN, undefined]);
    expect(forget).toHaveBeenCalledWith("acme/shop");
    // A timeout may have created it already, so it isn't sent twice.
    refuse = "github_request_limit";
    await expect(transport("/repos/acme/shop/pulls", "POST", {})).rejects.toThrow(
      "github_request_limit",
    );
  });

  it("hands the token to gh as GH_TOKEN and nowhere else", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zoltbot-gh-bot-"));
    await writeFile(
      path.join(directory, "gh"),
      `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({token:process.env.GH_TOKEN??null,args:process.argv.slice(2)})));`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv("GH_TOKEN", "");
    try {
      const bot = (await ghTransport("/repos/acme/shop/pulls", "POST", {}, undefined, TOKEN)) as {
        token: string;
        args: string[];
      };
      expect(bot.token).toBe(TOKEN);
      expect(bot.args.join(" ")).not.toContain(TOKEN);
      const owner = (await ghTransport("/repos/acme/shop/pulls", "POST", {})) as {
        token: string | null;
      };
      expect(owner.token).toBe("");
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
