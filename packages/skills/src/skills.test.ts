import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SkillsLibrary } from "./library.js";
import { materializeSkills } from "./materialize.js";
import { parseSkill, readSkillFolder } from "./parser.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zolt-skills-"));
  roots.push(root);
  return realpathSync(root);
};
const source = (body = "Write concise notes.", name = "release-notes") =>
  `---\nname: ${name}\ndescription: Release notes guidance\n---\n${body}\n`;
const bundle = (body?: string, name?: string) =>
  parseSkill([{ path: "SKILL.md", content: source(body, name) }]);
const library = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(readFileSync(new URL("../008-skills.sql", import.meta.url), "utf8"));
  return new SkillsLibrary(db);
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("safe skill imports", () => {
  it("parses safe YAML, stable hashes, flags scripts and never executes them", () => {
    const root = temp(),
      sentinel = path.join(root, "executed");
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "SKILL.md"), source("Read [check](scripts/check.sh)."));
    writeFileSync(path.join(root, "scripts/check.sh"), `touch ${sentinel}\n`, { mode: 0o755 });
    const imported = readSkillFolder(root);
    expect(imported.warnings).toContain("scripts/check.sh: script; never executed during import");
    expect(existsSync(sentinel)).toBe(false);
    expect(parseSkill([...imported.files].reverse()).hash).toBe(imported.hash);
  });
  it.each([
    ["traversal", [{ path: "../SKILL.md", content: source() }]],
    ["binary", [{ path: "SKILL.md", content: `${source()}\0` }]],
    ["secret", [{ path: "SKILL.md", content: `${source()}\napi_key=abcdefghijklmnopqrstuv` }]],
    [
      "duplicate",
      [
        { path: "SKILL.md", content: source() },
        { path: "skill.md", content: source() },
      ],
    ],
    ["large", [{ path: "SKILL.md", content: source("a".repeat(65000)) }]],
    ["reference escape", [{ path: "SKILL.md", content: source("[bad](../private)") }]],
    [
      "install hook",
      [
        { path: "SKILL.md", content: source() },
        { path: "package.json", content: '{"scripts":{"postinstall":"evil"}}' },
      ],
    ],
    [
      "permission widening",
      [
        {
          path: "SKILL.md",
          content: source().replace("description:", "allowed-tools: Bash\ndescription:"),
        },
      ],
    ],
    ["dynamic shell", [{ path: "SKILL.md", content: source("Run !`echo secret`") }]],
    [
      "YAML tag",
      [
        {
          path: "SKILL.md",
          content: source().replace("name: release-notes", "name: !evil release-notes"),
        },
      ],
    ],
    [
      "YAML alias",
      [{ path: "SKILL.md", content: "---\nname: &n release-notes\ndescription: *n\n---\nText" }],
    ],
  ])("rejects %s", (_name, files) => {
    expect(() => parseSkill(files)).toThrow();
  });
  it("rejects symlinked file and source folders", () => {
    const root = temp(),
      other = temp();
    writeFileSync(path.join(other, "SKILL.md"), source());
    symlinkSync(path.join(other, "SKILL.md"), path.join(root, "SKILL.md"));
    expect(() => readSkillFolder(root)).toThrow("symlinks");
    symlinkSync(other, path.join(root, "linked"));
    expect(() => readSkillFolder(path.join(root, "linked"))).toThrow("symlinks");
  });
});
describe("versioned skills", () => {
  it("requires confirmed scoped access and freezes versions across edits and removal", () => {
    const lib = library(),
      skill = lib.add(bundle());
    const input = {
      profileId: "a",
      scopeId: "project-a",
      skillId: skill.id,
      revision: 1,
      enabled: true,
      confirmed: false,
      reservedNames: [],
    };
    expect(() => lib.assign(input)).toThrow("confirmation");
    lib.assign({ ...input, confirmed: true });
    expect(lib.resolve("b", ["project-a"])).toEqual([]);
    expect(lib.resolve("a", ["project-b"])).toEqual([]);
    const frozen = lib.freeze("launch-1", "a", "project-a", ["project-a"]);
    lib.save(skill.id, 1, bundle("Updated notes"));
    expect(() => lib.save(skill.id, 1, bundle())).toThrow("revision_conflict");
    expect(lib.freeze("launch-1", "a", "project-a", ["project-a"])).toEqual(frozen);
    lib.remove(skill.id, true);
    expect(lib.list()).toEqual([]);
    expect(lib.snapshot("launch-1")).toEqual(frozen);
    expect(lib.revision(skill.id, 1).bundle.body).toContain("concise");
    expect(lib.resolve("a", ["project-a"])).toEqual([]);
    expect(lib.add(bundle()).id).not.toBe(skill.id);
    lib.db.close();
  });
  it("allows a narrower scope to disable an inherited skill without widening another profile", () => {
    const lib = library(),
      skill = lib.add(bundle());
    const base = {
      profileId: "a",
      scopeId: "parent",
      skillId: skill.id,
      revision: 1,
      enabled: true,
      confirmed: true,
      reservedNames: [],
    };
    lib.assign(base);
    lib.assign({ ...base, scopeId: "child", enabled: false, confirmed: false });
    expect(lib.resolve("a", ["parent", "child"])).toEqual([]);
    expect(lib.resolve("a", ["parent"])).toHaveLength(1);
    expect(lib.resolve("b", ["parent", "child"])).toEqual([]);
    lib.db.close();
  });
  it("retains both sides of an update, detects names and native commands", () => {
    const lib = library(),
      skill = lib.add(bundle(), "/source");
    expect(() => lib.add(bundle())).toThrow("name_conflict");
    expect(() =>
      lib.assign({
        profileId: "a",
        scopeId: "p",
        skillId: skill.id,
        revision: 1,
        enabled: true,
        confirmed: true,
        reservedNames: ["release-notes"],
      }),
    ).toThrow("name_conflict");
    lib.save(skill.id, 1, bundle("Mine"));
    lib.updateSource(skill.id, 2, bundle("Source"), "keep");
    expect(lib.get(skill.id).current_revision).toBe(2);
    lib.updateSource(skill.id, 2, bundle("Source"), "replace");
    expect(lib.history(skill.id).map((r) => r.bundle.body.trim())).toEqual([
      "Source",
      "Mine",
      "Write concise notes.",
    ]);
    lib.db.close();
  });
  it("materializes app-owned immutable snapshots deterministically and detects tampering", () => {
    const lib = library(),
      skill = lib.add(bundle()),
      root = temp();
    lib.assign({
      profileId: "a",
      scopeId: "p",
      skillId: skill.id,
      revision: 1,
      enabled: true,
      confirmed: true,
      reservedNames: [],
    });
    const frozen = lib.freeze("launch", "a", "p", ["p"]),
      paths = materializeSkills(lib, frozen, root);
    expect(materializeSkills(lib, frozen, root)).toEqual(paths);
    const file = path.join(paths[0] ?? "", "SKILL.md");
    rmSync(file);
    writeFileSync(file, "tampered");
    expect(() => materializeSkills(lib, frozen, root)).toThrow("tampered");
    lib.db.close();
  });
});
