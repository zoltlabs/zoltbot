import { describe, expect, it } from "vitest";
import { type CliFiles, cliInstaller, cliScript, shellQuote } from "./cli-install";

function files(initial: Record<string, string> = {}, locked = false) {
  const disk = new Map(Object.entries(initial));
  const admin: string[] = [];
  const links = new Set<string>();
  const store: CliFiles = {
    kind: async (path) => (links.has(path) ? "link" : disk.has(path) ? "file" : "missing"),
    async read(path) {
      const value = disk.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    },
    exists: async (path) => disk.has(path),
    async write(path, content) {
      if (locked) throw Object.assign(new Error("locked"), { code: "EACCES" });
      if (disk.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      disk.set(path, content);
    },
    async remove(path) {
      if (locked) throw Object.assign(new Error("locked"), { code: "EACCES" });
      disk.delete(path);
    },
    async writeAsAdmin(source, target) {
      admin.push(target);
      disk.set(target, disk.get(source) ?? "");
    },
    async temporary(content) {
      disk.set("/tmp/zolt", content);
      return "/tmp/zolt";
    },
  };
  return { disk, admin, store, links };
}

const source = {
  node: "/Applications/Zoltbot.app/bin/node",
  script: "/Applications/Zoltbot.app/zolt.mjs",
};

describe("R5 install command-line tool", () => {
  it("quotes paths for sh", () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(cliScript("/n", "/s")).toContain(`exec '/n' '/s' "$@"`);
  });

  it("installs, then reports installed", async () => {
    const { disk, store } = files({ [source.script]: "" });
    const installer = cliInstaller({ files: store, source: () => source, target: "/bin/zolt" });
    expect(await installer.status()).toBe("missing");
    expect(await installer.install()).toBe("installed");
    expect(disk.get("/bin/zolt")).toBe(cliScript(source.node, source.script));
  });

  it("asks macOS for an admin password when the folder is locked", async () => {
    const { admin, store } = files({ [source.script]: "" }, true);
    const installer = cliInstaller({ files: store, source: () => source, target: "/bin/zolt" });
    expect(await installer.install()).toBe("installed");
    expect(admin).toEqual(["/bin/zolt"]);
  });

  it("leaves another zolt alone and updates its own", async () => {
    const other = files({ [source.script]: "", "/bin/zolt": "#!/bin/sh\necho other\n" });
    const installer = cliInstaller({
      files: other.store,
      source: () => source,
      target: "/bin/zolt",
    });
    expect(await installer.install()).toBe("other");
    expect(other.disk.get("/bin/zolt")).toContain("echo other");
    const old = files({
      [source.script]: "",
      "/bin/zolt": cliScript("/old/node", "/old/zolt.mjs"),
    });
    const ours = cliInstaller({ files: old.store, source: () => source, target: "/bin/zolt" });
    expect(await ours.status()).toBe("outdated");
    expect(await ours.install()).toBe("installed");
  });

  it("has nothing to install when the app ships no command", async () => {
    const { store } = files();
    expect(await cliInstaller({ files: store, source: () => source }).install()).toBe(
      "unavailable",
    );
    expect(await cliInstaller({ files: store, source: () => undefined }).status()).toBe(
      "unavailable",
    );
  });

  it("never writes through a symlink at the target", async () => {
    const { admin, store, links } = files({ [source.script]: "" }, true);
    links.add("/bin/zolt");
    const installer = cliInstaller({ files: store, source: () => source, target: "/bin/zolt" });
    expect(await installer.install()).toBe("other");
    expect(admin).toEqual([]);
  });
});
