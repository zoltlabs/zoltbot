// M4: importing memory from another assistant's export, with a fake model.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { macOnlyMethods } from "@zoltbot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { knowledgeWriteFixture } from "./knowledge-write-fixture.js";
import { memoryImportApi, readExport } from "./memory-import.js";
import type { InferenceAdapter } from "./quick-chat/providers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function folder() {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/import-"));
  roots.push(dir);
  return dir;
}

const claudeExport = {
  "conversations.json": JSON.stringify([
    {
      name: "Release notes",
      updated_at: "2026-10-01T10:00:00Z",
      chat_messages: [
        { sender: "human", text: "I write release notes in British English." },
        { sender: "assistant", text: "Got it." },
      ],
    },
  ]),
  "memories.json": JSON.stringify(["Works on a Mac app."]),
};
function fakeModel(reply: string) {
  const prompts: string[] = [];
  const adapter = {
    async stream(request: { turns: { text: string }[]; onText(delta: string): void }) {
      prompts.push(request.turns[0]?.text ?? "");
      request.onText(reply);
      return {};
    },
  } as unknown as InferenceAdapter;
  return { adapter, prompts };
}
const facts = JSON.stringify({
  facts: [
    { kind: "preference", title: "Spelling", body: "Writes release notes in British English." },
    { kind: "nonsense", title: "", body: "Uses the token sk-live-123." },
  ],
});

async function setup(reply = facts) {
  const k = await knowledgeWriteFixture();
  const model = fakeModel(reply);
  const api = memoryImportApi({
    store: k.f.store,
    publish: () => {},
    router: async () => ({ adapter: model.adapter, model: "small" }),
    containsSecret: async (text) => text.includes("sk-live"),
    read: async () => new Map(Object.entries(claudeExport)),
  });
  const pending = () =>
    (k.f.store.snapshot(["knowledgeProposal"]).knowledgeProposal ?? []).filter(
      (row) => row.state === "pending",
    );
  return { k, model, api, pending };
}
async function finished(api: Awaited<ReturnType<typeof setup>>["api"], id: string) {
  for (let n = 0; n < 50; n++) {
    const status = (await api.api("memory.import.status", { id })) as { state: string };
    if (status.state !== "reading") return status;
    await delay(10);
  }
  throw new Error("import still reading");
}

describe("memory import", () => {
  it("previews, then proposes saved memories and facts from conversations for review", async () => {
    const { k, model, api, pending } = await setup();
    try {
      expect(await api.api("memory.import.preview", { source: "claude", path: "/x.zip" })).toEqual({
        memories: 1,
        conversations: 1,
      });
      expect(pending()).toHaveLength(0);
      const started = (await api.api(
        "memory.import.start",
        { source: "claude", path: "/x.zip" },
        "import-1",
      )) as { id: string; proposed: number; conversations: number };
      expect(started).toMatchObject({ proposed: 1, conversations: 1 });
      expect(await finished(api, started.id)).toMatchObject({
        state: "done",
        read: 1,
        proposed: 2,
      });
      expect(model.prompts[0]).toContain("Owner: I write release notes in British English.");
      const rows = pending();
      expect(rows.map((row) => row.body).sort()).toEqual([
        "Works on a Mac app.",
        "Writes release notes in British English.",
      ]);
      expect(rows[0]).toMatchObject({
        why: "imported",
        scope: { type: "user" },
        reason: "From your Claude export.",
        writer: { kind: "system", id: "memory-import" },
      });
      // Importing the same export again adds nothing new.
      const again = (await api.api(
        "memory.import.start",
        { source: "claude", path: "/x.zip" },
        "import-2",
      )) as { id: string };
      expect(await finished(api, again.id)).toMatchObject({ proposed: 0 });
      expect(pending()).toHaveLength(2);
    } finally {
      api.close();
      k.f.close();
    }
  });

  it("refuses an unknown source and a file it can't use", async () => {
    const { k, api } = await setup();
    try {
      await expect(
        api.api("memory.import.preview", { source: "other", path: "/x.zip" }),
      ).rejects.toThrow("invalid_import_source");
      await expect(readExport(path.join(folder(), "missing.zip"), "claude")).rejects.toThrow(
        "import_file_missing",
      );
      const text = path.join(folder(), "notes.txt");
      writeFileSync(text, "hello");
      await expect(readExport(text, "claude")).rejects.toThrow("import_file_type");
    } finally {
      api.close();
      k.f.close();
    }
  });

  it("reads only the export's JSON files from a ZIP", async () => {
    const dir = folder();
    mkdirSync(path.join(dir, "export"));
    for (const [name, text] of Object.entries(claudeExport))
      writeFileSync(path.join(dir, "export", name), text);
    writeFileSync(path.join(dir, "export", "photo.jpg"), "not read");
    execFileSync("zip", ["-qr", "export.zip", "export"], { cwd: dir });
    const files = await readExport(path.join(dir, "export.zip"), "claude");
    expect([...files.keys()].sort()).toEqual(["export/conversations.json", "export/memories.json"]);
  });

  it("fails with a sentence when the model never answers, and only the Mac can import", async () => {
    const k = await knowledgeWriteFixture();
    const api = memoryImportApi({
      store: k.f.store,
      publish: () => {},
      router: async () => ({
        adapter: {
          async stream() {
            throw new Error("signed out");
          },
        } as unknown as InferenceAdapter,
        model: "small",
      }),
      containsSecret: async () => false,
      read: async () => new Map(Object.entries(claudeExport)),
    });
    try {
      const started = (await api.api(
        "memory.import.start",
        { source: "claude", path: "/x.zip" },
        "import-fail",
      )) as { id: string };
      expect(await finished(api, started.id)).toMatchObject({
        state: "failed",
        error: expect.stringContaining("didn’t answer"),
        proposed: 1,
      });
      for (const method of ["memory.import.preview", "memory.import.start", "memory.import.status"])
        expect(macOnlyMethods).toContain(method);
    } finally {
      api.close();
      k.f.close();
    }
  });
});
