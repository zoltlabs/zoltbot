import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { builtinSkill, installBuiltinSkills, viewSkillSource } from "./builtins.js";
import { SkillsLibrary } from "./library.js";
import { parseSkill } from "./parser.js";

it("registers the shipped skill once without assignments, overwrites or resurrecting removals", () => {
  const db = new Database(":memory:");
  try {
    const library = new SkillsLibrary(db);
    installBuiltinSkills(library);
    db.exec(readFileSync(new URL("../008-skills.sql", import.meta.url), "utf8"));
    installBuiltinSkills(library);
    const entry = library.list()[0];
    expect(entry).toMatchObject({ name: "building-zoltbot-views", source: viewSkillSource });
    if (!entry) throw Error("missing_builtin");
    expect(library.resolve("profile", ["scope"])).toEqual([]);
    const original = library.revision(entry.id, 1).bundle;
    expect(builtinSkill(viewSkillSource)?.hash).toBe(original.hash);
    expect(builtinSkill("builtin:unknown")).toBeUndefined();
    library.save(
      entry.id,
      1,
      parseSkill(
        original.files.map((file) => ({ ...file, content: `${file.content}\nOwner notes.\n` })),
      ),
    );
    installBuiltinSkills(library);
    expect(library.list()).toHaveLength(1);
    expect(library.get(entry.id).current_revision).toBe(2);
    expect(library.revision(entry.id, 2).bundle.body).toContain("Owner notes.");
    expect(builtinSkill(viewSkillSource)?.body).not.toContain("Owner notes.");
    library.remove(entry.id, true);
    installBuiltinSkills(library);
    expect(library.list()).toEqual([]);
  } finally {
    db.close();
  }
});
it("preserves an owner skill with the shipped name", () => {
  const db = new Database(":memory:");
  try {
    db.exec(readFileSync(new URL("../008-skills.sql", import.meta.url), "utf8"));
    const library = new SkillsLibrary(db),
      shipped = builtinSkill(viewSkillSource);
    if (!shipped) throw Error("missing_builtin");
    const owner = library.add(shipped);
    installBuiltinSkills(library);
    expect(library.list()).toEqual([owner]);
  } finally {
    db.close();
  }
});
