import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { skillsApi } from "./skills-api.js";

it("reviews exact folder bytes, fences writes and replays durable receipts", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "zolt-skill-api-")));
  const store = await openStore(path.join(root, "db.sqlite"));
  try {
    if (!store.database.prepare("SELECT name FROM sqlite_master WHERE name='skill_library'").get())
      store.database.exec(
        readFileSync(new URL("../../skills/008-skills.sql", import.meta.url), "utf8"),
      );
    const api = skillsApi({ store, checkPublic: async () => {} }),
      folder = path.join(root, "source/SKILL.md");
    mkdirSync(path.dirname(folder));
    const content =
      "---\nname: reviewed\ndescription: A reviewed skill\n---\nOriginal instructions\n";
    writeFileSync(folder, content);
    const preview = (await api("skill.import.preview", { folder: path.dirname(folder) })) as {
      previewId: string;
      bundle: { hash: string };
    };
    writeFileSync(folder, content.replace("Original", "Changed"));
    await expect(
      api(
        "skill.import.apply",
        { previewId: preview.previewId, hash: preview.bundle.hash },
        "import-1",
      ),
    ).rejects.toThrow("source_changed");
    writeFileSync(folder, content);
    const added = (await api(
      "skill.import.apply",
      { previewId: preview.previewId, hash: preview.bundle.hash },
      "import-1",
    )) as { id: string };
    expect(
      await api("skill.import.apply", { previewId: "expired", hash: "wrong" }, "import-1"),
    ).toEqual(added);
    await expect(
      api("skill.remove", { id: added.id, confirmed: false }, "remove-no"),
    ).rejects.toThrow("confirmation");
    expect(await api("skill.list", {})).toMatchObject({ skills: [{ id: added.id }] });
    await api("skill.remove", { id: added.id, confirmed: true }, "remove-1");
    expect(await api("skill.get", { id: added.id })).toMatchObject({ revision: { revision: 1 } });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("previews draft access, publishes once atomically and fences private writes at commit", async () => {
  const f = await runtimeFixture();
  try {
    f.store.dispatch("project-preview", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "project",
          value: {
            id: "p",
            name: "Project",
            goal: "",
            instructions: "",
            constraints: "",
            roots: [],
            hierarchyDepth: 0,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: at,
          },
        },
        { commandId: "project-preview", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    let changed = 0,
      published = 0;
    const api = skillsApi({
      store: f.store,
      checkPublic: async (value) => () => {
        if (JSON.stringify(value).includes("PRIVATE_SKILL_SENTINEL"))
          throw new Error("private_value_requires_secure_field");
      },
      publish: (events) => {
        published += events.length;
      },
      onChanged: () => {
        changed++;
      },
    });
    const files = [
      {
        path: "SKILL.md",
        content: "---\nname: draft-skill\ndescription: Test\n---\nInstructions\n",
      },
    ];
    const entry = (await api("skill.save", { files }, "save-preview")) as { id: string };
    await api(
      "skill.access",
      {
        profileId: "profile",
        scopeId: "p",
        skillId: entry.id,
        revision: 1,
        enabled: true,
        confirmed: true,
      },
      "enable-preview",
    );
    expect(
      await api("skill.context", {
        taskId: "draft",
        preview: true,
        profileId: "profile",
        scope: { type: "project", id: "p" },
      }),
    ).toMatchObject({
      snapshot: { manifestId: "preview", skills: [{ skillId: entry.id, revision: 1 }] },
    });
    expect(published).toBe(2);
    expect(changed).toBe(2);
    expect(await api("skill.save", { files }, "save-preview")).toEqual(entry);
    expect(published).toBe(2);
    await expect(
      api(
        "skill.save",
        {
          files: [
            {
              path: "SKILL.md",
              content: files[0]?.content
                .replace("draft-skill", "private-skill")
                .replace("Instructions", "PRIVATE_SKILL_SENTINEL"),
            },
          ],
        },
        "save-private",
      ),
    ).rejects.toThrow("private_value");
    const before = f.store.lastSeq(),
      dispatch = f.store.dispatch.bind(f.store);
    f.store.dispatch = ((id, produce) =>
      dispatch(id, produce, { killPoint: "after_projections" })) as Store["dispatch"];
    await expect(
      api(
        "skill.save",
        {
          files: [
            { path: "SKILL.md", content: files[0]?.content.replace("draft-skill", "rolled-back") },
          ],
        },
        "save-rollback",
      ),
    ).rejects.toThrow("kill point");
    f.store.dispatch = dispatch;
    expect(f.store.lastSeq()).toBe(before);
    expect(published).toBe(2);
    expect(changed).toBe(2);
    expect(await api("skill.list", {})).toMatchObject({ skills: [{ id: entry.id }] });
    expect(
      f.store.database.prepare("SELECT id FROM skill_library WHERE name='rolled-back'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});
