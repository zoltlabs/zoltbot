// M5: add a skill from a GitHub link, against a local bare repository standing in for github.com.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { afterEach, describe, expect, it } from "vitest";
import { fetchGithubSkill, githubSkillLimits, parseGithubSkillLink } from "./skill-github.js";
import { skillsApi } from "./skills-api.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  })
    .toString()
    .trim();
const skill = (name: string, text: string) =>
  `---\nname: ${name}\ndescription: A test skill\n---\n${text}\n`;

/** A bare repository with skills/notes/SKILL.md on main; returns it and a clone URL mapper. */
function repository(files: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "zolt-skill-gh-")));
  roots.push(root);
  const work = path.join(root, "work");
  mkdirSync(work);
  run(work, "init", "-q", "-b", "main");
  const all = { "skills/notes/SKILL.md": skill("notes", "Write short notes."), ...files };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    writeFileSync(path.join(work, file), text);
  }
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "skills");
  const bare = path.join(root, "bare.git");
  run(root, "clone", "-q", "--bare", work, bare);
  return { root, work, bare, cloneUrl: () => `file://${bare}`, tempRoot: root };
}

describe("GitHub skill links", () => {
  it("reads owner, repository, branch and folder, and refuses anything else", () => {
    expect(parseGithubSkillLink("https://github.com/acme/tools/tree/main/skills/notes")).toEqual({
      owner: "acme",
      repo: "tools",
      ref: "main",
      folder: "skills/notes",
      rest: ["main", "skills", "notes"],
    });
    expect(parseGithubSkillLink("https://github.com/acme/tools.git")).toEqual({
      owner: "acme",
      repo: "tools",
      folder: "",
      rest: [],
    });
    expect(
      parseGithubSkillLink("https://github.com/acme/tools/blob/main/skills/notes/SKILL.md"),
    ).toMatchObject({ folder: "skills/notes" });
    for (const bad of [
      "http://github.com/acme/tools",
      "https://gitlab.com/acme/tools",
      "https://github.com/acme",
      "https://github.com/acme/tools/tree/a..b/skills",
      "https://github.com/acme/tools/tree/--upload-pack=x",
      "https://github.com/acme/tools/issues/1",
      "https://user@github.com/acme/tools",
      "https://github.com/acme/tools/tree/main/..%2F..%2Fx",
      "https://github.com/acme/tools/tree/main/%E0%A4%A",
      "not a link",
    ])
      expect(() => parseGithubSkillLink(bad), bad).toThrow("skill_link_invalid");
  });

  it("fetches the folder, pins the commit and leaves no files behind", async () => {
    const repo = repository();
    const head = run(repo.work, "rev-parse", "HEAD");
    const fetched = await fetchGithubSkill(
      "https://github.com/acme/tools/tree/main/skills/notes",
      repo,
    );
    expect(fetched.commit).toBe(head);
    expect(fetched.source).toBe("https://github.com/acme/tools/tree/main/skills/notes");
    expect(fetched.bundle.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(
      execFileSync("ls", [repo.root])
        .toString()
        .split("\n")
        .filter((name) => name.startsWith("zoltbot-skill-")),
    ).toEqual([]);
  });

  it("counts only the skill's folder, and refuses a folder that's too big or isn't a skill", async () => {
    const many = Object.fromEntries(
      Array.from({ length: githubSkillLimits.files + 1 }, (_, n) => [`data/${n}.txt`, "x"]),
    );
    const big = repository(many);
    // A small skill in a big repository is fine.
    await expect(
      fetchGithubSkill("https://github.com/acme/tools/tree/main/skills/notes", big),
    ).resolves.toMatchObject({ bundle: { files: [{ path: "SKILL.md" }] } });
    await expect(
      fetchGithubSkill("https://github.com/acme/tools/tree/main/data", big),
    ).rejects.toThrow("skill_folder_too_large");
    const repo = repository({ "docs/readme.md": "hello" });
    await expect(
      fetchGithubSkill("https://github.com/acme/tools/tree/main/docs", repo),
    ).rejects.toThrow("skill_folder_invalid");
    await expect(
      fetchGithubSkill("https://github.com/acme/tools/tree/nope/skills/notes", repo),
    ).rejects.toThrow("skill_link_unreachable");
    await expect(
      fetchGithubSkill("https://github.com/acme/tools/tree/main/skills/missing", repo),
    ).rejects.toThrow("skill_folder_invalid: this folder isn’t in the repository.");
  });

  it("reads branches with a slash in their name and commit links", async () => {
    const repo = repository();
    run(repo.work, "checkout", "-q", "-b", "feature/short");
    writeFileSync(path.join(repo.work, "skills/notes/SKILL.md"), skill("notes", "Short."));
    run(repo.work, "commit", "-q", "-am", "short");
    run(repo.work, "push", "-q", repo.bare, "feature/short");
    const branch = await fetchGithubSkill(
      "https://github.com/acme/tools/tree/feature/short/skills/notes",
      repo,
    );
    expect(branch.source).toBe("https://github.com/acme/tools/tree/feature/short/skills/notes");
    expect(branch.bundle.files[0]?.content).toContain("Short.");
    const head = run(repo.work, "rev-parse", "HEAD");
    const pinned = await fetchGithubSkill(
      `https://github.com/acme/tools/tree/${head}/skills/notes`,
      { ...repo, cloneUrl: () => `file://${repo.bare}` },
    );
    expect(pinned.commit).toBe(head);
  });

  it("previews and installs from a link, then previews an update after a new commit", async () => {
    const repo = repository();
    const store = await openStore(path.join(repo.root, "db.sqlite"));
    try {
      if (
        !store.database.prepare("SELECT name FROM sqlite_master WHERE name='skill_library'").get()
      )
        store.database.exec(
          readFileSync(new URL("../../skills/008-skills.sql", import.meta.url), "utf8"),
        );
      const api = skillsApi({ store, checkPublic: async () => {}, github: repo });
      const url = "https://github.com/acme/tools/tree/main/skills/notes";
      await expect(api("skill.import.link", { url: repo.work })).rejects.toThrow(
        "skill_link_invalid",
      );
      const preview = (await api("skill.import.link", { url })) as {
        previewId: string;
        commit: string;
        source: string;
        bundle: { hash: string };
      };
      expect(preview).toMatchObject({ source: url, commit: run(repo.work, "rev-parse", "HEAD") });
      // The phone's install refuses previews read from a folder on the Mac.
      const local = (await api("skill.import.preview", {
        folder: path.join(repo.work, "skills/notes"),
      })) as { previewId: string; bundle: { hash: string } };
      await expect(
        api(
          "skill.import.link.apply",
          { previewId: local.previewId, hash: local.bundle.hash },
          "phone-local",
        ),
      ).rejects.toThrow("skill_preview_expired");
      const added = (await api(
        "skill.import.link.apply",
        { previewId: preview.previewId, hash: preview.bundle.hash },
        "import-gh",
      )) as { id: string };
      writeFileSync(path.join(repo.work, "skills/notes/SKILL.md"), skill("notes", "Shorter."));
      run(repo.work, "commit", "-q", "-am", "update");
      run(repo.work, "push", "-q", repo.bare, "main");
      const update = (await api("skill.update.preview", { id: added.id })) as {
        commit: string;
        bundle: { files: { content: string }[] };
      };
      expect(update.commit).toBe(run(repo.work, "rev-parse", "HEAD"));
      expect(update.bundle.files[0]?.content).toContain("Shorter.");
    } finally {
      store.close();
    }
  });
});
