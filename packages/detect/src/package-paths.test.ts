import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { findPackageDirectories } from "./package-paths.js";

it("queries package prefixes with private caches and no install or update actions", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/package-paths-"));
  try {
    const calls: string[] = [];
    const directories = await findPackageDirectories({
      cwd: root,
      home: root,
      paths: [root],
      runner: async (command, args, options) => {
        calls.push(command);
        expect(options.timeoutMs).toBe(5000);
        expect(options.inherited).toEqual({});
        expect(options.env?.HOME).toBe(root);
        expect(args).not.toContain("install");
        expect(args).not.toContain("update");
        if (command === "npm") {
          expect(args.slice(0, 2)).toEqual(["root", "--global"]);
          expect(options.env?.npm_config_cache).toContain(root);
          return {
            code: 0,
            stdout: path.join(root, "npm/lib/node_modules"),
            stderr: "private-detail",
          };
        }
        expect(options.env?.HOMEBREW_NO_AUTO_UPDATE).toBe("1");
        return { code: 0, stdout: path.join(root, "brew"), stderr: "" };
      },
    });
    expect(calls.sort()).toEqual(["brew", "npm"]);
    expect(directories).toEqual([path.join(root, "npm/bin"), path.join(root, "brew/bin")]);
    expect(JSON.stringify(directories)).not.toContain("private-detail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("does not follow a stale cache symlink outside the data folder", async () => {
  const { readFileSync, symlinkSync, writeFileSync } = await import("node:fs");
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/package-cache-"));
  const home = path.join(root, "data"),
    external = path.join(root, "external");
  mkdirSync(home);
  mkdirSync(external);
  writeFileSync(path.join(external, "user.npmrc"), "private-preserved");
  symlinkSync(external, path.join(home, "package-manager"));
  try {
    await findPackageDirectories({
      cwd: home,
      home,
      paths: [],
      runner: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
    expect(readFileSync(path.join(external, "user.npmrc"), "utf8")).toBe("private-preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
