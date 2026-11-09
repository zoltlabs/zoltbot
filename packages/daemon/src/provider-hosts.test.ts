import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeDefinitions } from "@zoltbot/adapters-claude/definitions";
import { codexDefinitions } from "@zoltbot/adapters-codex/definitions";
import { expect, it } from "vitest";
import { Redactor } from "./logging.js";
import { providerHosts } from "./provider-hosts.js";

it("resolves installed binaries into the existing CLI homes and keeps secret values out of discovery", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "zoltbot-hosts-"));
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const hosts = providerHosts({
    directory: root,
    home: path.join(root, "existing-home"),
    inherited: { SYNTHETIC_KEY: "synthetic-inherited-secret" },
    paths: async () => ["/synthetic/bin"],
    resolve: async (definition) => `/synthetic/bin/${definition.adapter}`,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: "codex-cli 0.164.0", stderr: "" };
    },
  });
  try {
    const claudeInput = claudeDefinitions[0],
      codexInput = codexDefinitions[0];
    if (!claudeInput || !codexInput) throw new Error("missing_builtin");
    const claude = await hosts.definition(claudeInput);
    const codex = await hosts.definition(codexInput);
    expect(claude.launch.command).toBe("/synthetic/bin/claude");
    expect(claude.launch.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(codex.launch.env.CODEX_HOME).toBeUndefined();
    expect(claude.launch.env.HOME).toBe(path.join(root, "existing-home"));
    expect((await hosts.probe(codex)).version).toBe("0.164.0");
    expect(calls[0]?.args).toEqual(["--version"]);
    const secretDefinition = structuredClone(codex);
    secretDefinition.launch.env.SYNTHETIC_KEY = "synthetic-private-key";
    await hosts.probe(secretDefinition);
    expect(JSON.stringify(calls)).not.toContain("synthetic-private-key");
    expect(JSON.stringify(codex)).not.toContain("synthetic-inherited-secret");
    const custom = await hosts.definition({
      ...claudeInput,
      launch: {
        ...claudeInput.launch,
        env: {
          HOME: path.join(root, "custom"),
          CLAUDE_CONFIG_DIR: path.join(root, "chosen-claude"),
        },
      },
    });
    expect(custom.launch.env.CLAUDE_CONFIG_DIR).toBe(path.join(root, "chosen-claude"));
    expect(custom.launch.env.HOME).toBe(path.join(root, "custom"));
    expect(hosts.adapters(new Redactor()).has("acp")).toBe(true);
    expect([...hosts.adapters(new Redactor()).keys()]).toEqual(["acp", "claude", "codex"]);
  } finally {
    await hosts.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("respects existing CLI configuration directory overrides without creating or copying their contents", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "zoltbot-auth-paths-"));
  const hosts = providerHosts({
    directory: root,
    inherited: {
      HOME: path.join(root, "user"),
      CLAUDE_CONFIG_DIR: path.join(root, "existing-claude"),
      CODEX_HOME: path.join(root, "existing-codex"),
    },
    paths: async () => ["/synthetic/bin"],
    resolve: async (definition) => `/synthetic/bin/${definition.adapter}`,
  });
  try {
    const claude = claudeDefinitions[0],
      codex = codexDefinitions[0];
    if (!claude || !codex) throw new Error("missing_builtin");
    expect((await hosts.definition(claude)).launch.env.CLAUDE_CONFIG_DIR).toBe(
      path.join(root, "existing-claude"),
    );
    expect((await hosts.definition(codex)).launch.env.CODEX_HOME).toBe(
      path.join(root, "existing-codex"),
    );
    expect(
      (
        await hosts.definition({
          ...codex,
          launch: { ...codex.launch, env: { HOME: path.join(root, "explicit-home") } },
        })
      ).launch.env.CODEX_HOME,
    ).toBeUndefined();
    expect(existsSync(path.join(root, "existing-claude"))).toBe(false);
    expect(existsSync(path.join(root, "existing-codex"))).toBe(false);
  } finally {
    await hosts.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("resolves ACP definitions and preserves selected native homes without inheriting API secrets", async () => {
  const { acpDefinitions } = await import("@zoltbot/adapters-acp");
  const root = mkdtempSync(path.join(tmpdir(), "zoltbot-acp-homes-"));
  const hosts = providerHosts({
    directory: root,
    inherited: {
      HOME: path.join(root, "user"),
      GEMINI_HOME: path.join(root, "gemini"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      GEMINI_API_KEY: "synthetic-private-key",
    },
    paths: async () => ["/synthetic/bin"],
    resolve: async (definition) => `/synthetic/bin/${definition.id}`,
  });
  try {
    for (const input of acpDefinitions) {
      if (!input) throw new Error("missing_definition");
      const definition = await hosts.definition(input);
      expect(definition.launch.command).toBe(`/synthetic/bin/${input.id}`);
      expect(definition.launch.env.GEMINI_HOME).toBe(path.join(root, "gemini"));
      expect(definition.launch.env.XDG_CONFIG_HOME).toBe(path.join(root, "config"));
      expect(JSON.stringify(definition)).not.toContain("synthetic-private-key");
    }
  } finally {
    await hosts.close();
    rmSync(root, { recursive: true, force: true });
  }
});
