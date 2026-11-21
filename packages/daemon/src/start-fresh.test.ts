import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FRESH_START_MARK,
  finishFreshStart,
  isDataFolder,
  prepareFreshStart,
  repositoryFolders,
  secretReferences,
} from "./start-fresh.js";

function folders() {
  const root = mkdtempSync(path.join(tmpdir(), "zoltbot-fresh-"));
  const dataDir = path.join(root, "data");
  const repo = path.join(root, "repo");
  mkdirSync(path.join(dataDir, "views", "one"), { recursive: true });
  writeFileSync(path.join(dataDir, "zoltbot.db"), "store");
  writeFileSync(path.join(dataDir, "daemon-owner.sqlite"), "lock");
  mkdirSync(path.join(dataDir, "desktop"), { recursive: true });
  writeFileSync(
    path.join(dataDir, "desktop", "account-keychain-reference"),
    "keychain:zoltbot:acct-9\n",
  );
  mkdirSync(path.join(dataDir, "managed-worktrees", "task-1"), { recursive: true });
  writeFileSync(path.join(dataDir, "managed-worktrees", "task-1", "work.ts"), "work");
  writeFileSync(path.join(dataDir, "views", "one", "index.html"), "view");
  mkdirSync(path.join(repo, ".zoltbot", "artifacts"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "project");
  writeFileSync(path.join(repo, ".zoltbot", "artifacts", "a.md"), "artifact");
  return { dataDir, repo };
}

describe("start fresh", () => {
  it("finds each keychain reference once, wherever it is stored", () => {
    expect(
      secretReferences({
        bridge: [{ credentialRef: "keychain:zoltbot:abc-1" }],
        account: { reference: "keychain:zoltbot:def-2", again: "keychain:zoltbot:abc-1" },
        text: "mentions keychain:zoltbot:xyz in a sentence",
      }).sort(),
    ).toEqual(["keychain:zoltbot:abc-1", "keychain:zoltbot:def-2"]);
  });

  it("stops work, removes saved logins and marks the folder, leaving repositories alone", async () => {
    const { dataDir, repo } = folders();
    const interruptAll = vi.fn(async () => undefined);
    const removeSecret = vi.fn(async () => undefined);
    const result = await prepareFreshStart({
      dataDir,
      snapshot: () => ({ bridge: [{ credentialRef: "keychain:zoltbot:abc-1" }] }),
      interruptAll,
      removeSecret,
      repositoryRoots: () => [repo, null, "relative/path"],
    });
    expect(interruptAll).toHaveBeenCalledOnce();
    expect(removeSecret).toHaveBeenCalledWith("keychain:zoltbot:abc-1");
    // The account's login, kept in a file rather than the store.
    expect(removeSecret).toHaveBeenCalledWith("keychain:zoltbot:acct-9");
    expect(result.kept).toEqual([
      path.join(repo, ".zoltbot"),
      path.join(dataDir, "managed-worktrees"),
    ]);
    expect(existsSync(path.join(dataDir, FRESH_START_MARK))).toBe(true);
    // Nothing is deleted until the next start.
    expect(existsSync(path.join(dataDir, "zoltbot.db"))).toBe(true);
  });

  it("empties the marked data folder on the next start and touches no repository file", async () => {
    const { dataDir, repo } = folders();
    expect(await finishFreshStart(dataDir)).toBe(false);
    expect(existsSync(path.join(dataDir, "zoltbot.db"))).toBe(true);

    await prepareFreshStart({
      dataDir,
      snapshot: () => ({}),
      interruptAll: async () => undefined,
      repositoryRoots: () => [repo],
    });
    expect(await finishFreshStart(dataDir)).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(path.join(dataDir, "zoltbot.db"))).toBe(false);
    expect(existsSync(path.join(dataDir, "views"))).toBe(false);
    expect(existsSync(path.join(dataDir, FRESH_START_MARK))).toBe(false);
    expect(existsSync(path.join(dataDir, "daemon-owner.sqlite"))).toBe(true);
    expect(readFileSync(path.join(dataDir, "managed-worktrees", "task-1", "work.ts"), "utf8")).toBe(
      "work",
    );
    expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("project");
    expect(readFileSync(path.join(repo, ".zoltbot", "artifacts", "a.md"), "utf8")).toBe("artifact");
  });

  it("refuses a folder that isn't Zoltbot's and stops before marking if a login can't go", async () => {
    const { dataDir, repo } = folders();
    const host = {
      dataDir: repo,
      snapshot: () => ({}),
      interruptAll: async () => undefined,
      repositoryRoots: () => [],
    };
    await expect(prepareFreshStart(host)).rejects.toThrow("unsafe_folder");
    writeFileSync(path.join(repo, FRESH_START_MARK), "");
    await expect(finishFreshStart(repo)).rejects.toThrow("unsafe_folder");
    expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("project");
    expect(isDataFolder(homedir())).toBe(false);
    expect(isDataFolder("/")).toBe(false);

    await expect(
      prepareFreshStart({
        ...host,
        dataDir,
        removeSecret: async () => {
          throw new Error("keychain_unavailable");
        },
      }),
    ).rejects.toThrow("keychain_unavailable");
    expect(existsSync(path.join(dataDir, FRESH_START_MARK))).toBe(false);
  });

  it("doesn't list a project inside the data folder as kept", () => {
    const { dataDir } = folders();
    mkdirSync(path.join(dataDir, "inner", ".zoltbot"), { recursive: true });
    expect(repositoryFolders([path.join(dataDir, "inner")], dataDir)).toEqual([]);
  });

  it("lists only repository folders that exist", () => {
    const { repo } = folders();
    expect(repositoryFolders([repo, path.join(repo, "missing")])).toEqual([
      path.join(repo, ".zoltbot"),
    ]);
  });
});
