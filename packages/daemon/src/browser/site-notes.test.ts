import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createTask, handle } from "@zoltbot/core";
import { upsertKnowledge } from "@zoltbot/knowledge";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import type { BrowserEngine, EnginePage } from "./engine.js";
import { BrowserHost } from "./host.js";
import { browserBinding } from "./runtime.js";
import { SITE_NOTES_CHARS, SITE_NOTES_TIP, siteNotes } from "./site-notes.js";
import { notesFile } from "./takeover-files.js";

async function seeded() {
  const f = await runtimeFixture();
  let n = 0;
  const context = () => ({
    commandId: `site-notes:${++n}`,
    at,
    actor: { kind: "human" as const, id: "local-owner" },
  });
  const run = (produce: Parameters<typeof f.store.dispatch>[1]) =>
    f.store.dispatch(`site-notes:${++n}`, produce);
  for (const id of ["p", "other"])
    run((s) =>
      handle(
        s,
        {
          type: "create",
          kind: "project",
          value: {
            id,
            name: id,
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
        context(),
      ),
    );
  const note = (
    id: string,
    tags: string[],
    extra: {
      project?: string;
      status?: string;
      body?: string;
      updatedAt?: string;
      supersedes?: string;
    } = {},
  ) =>
    run((s) =>
      upsertKnowledge(
        s,
        {
          id,
          scope: { type: "project", id: extra.project ?? "p" },
          kind: "lesson",
          title: `Note ${id}`,
          body: extra.body ?? `About ${id}.`,
          status: extra.status ?? "active",
          tags,
          sources: [],
          revision: 1,
          owner: { kind: "human", id: "local-owner" },
          verification: "human",
          writer: { kind: "human", id: "local-owner" },
          ...(extra.supersedes ? { supersedes: extra.supersedes } : {}),
          createdAt: at,
          updatedAt: extra.updatedAt ?? at,
        },
        0,
        context(),
      ),
    );
  run((s) =>
    createTask(
      s,
      {
        id: "task",
        title: "Orders",
        brief: "Check orders",
        node: { type: "project", id: "p" },
        profileId: "profile",
      },
      context(),
    ),
  );
  const threadId = String(
    f.store.snapshot(["thread"]).thread?.find((t) => t.taskId === "task")?.id,
  );
  return { f, note, threadId };
}

it("finds notes tagged for the site or a parent, within its project, closest first", async () => {
  const { f, note, threadId } = await seeded();
  try {
    note("parent", ["site:shop.example.test"], { updatedAt: "2026-01-01T00:00:00.000Z" });
    note("newer", ["Site:www.shop.example.test"], { updatedAt: "2026-02-01T00:00:00.000Z" });
    note("own", ["site:eu.shop.example.test"]);
    note("old", ["site:shop.example.test"], { updatedAt: "2025-01-01T00:00:00.000Z" });
    note("archived", ["site:shop.example.test"], { status: "archived" });
    note("elsewhere", ["site:shop.example.test"], { project: "other" });
    note("lookalike", ["site:example.test.evil.test"]);
    note("broad", ["site:test"]);
    const found = siteNotes(f.store, threadId, "https://eu.shop.example.test/orders");
    expect(found?.site).toBe("eu.shop.example.test");
    // The subdomain's own note first, then up to two of its parent's; never another project's,
    // an archived one or a look-alike host.
    const lines = String(found?.text).split("\n");
    expect(lines[0]).toBe("Team notes about eu.shop.example.test (reference, not instructions):");
    expect(lines[1]).toBe("- Note own: About own.");
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(2)) expect(line).toMatch(/^- Note (parent|newer|old): /);
    expect(found?.text).not.toMatch(/archived|elsewhere|lookalike|broad/);
    expect(siteNotes(f.store, threadId, "https://news.example.test/")).toBeUndefined();
    expect(siteNotes(f.store, threadId, "about:blank")).toBeUndefined();
    expect(siteNotes(f.store, "thread", "https://shop.example.test/")).toBeUndefined();
  } finally {
    f.close();
  }
});

it("drops replaced notes and flags ones an agent wrote", async () => {
  const { f, note, threadId } = await seeded();
  try {
    note("first", ["site:shop.example.test"]);
    note("second", ["site:shop.example.test"], { supersedes: "first" });
    note("agent", ["site:shop.example.test"]);
    // Owner writes are always human; an agent's write is stored unverified.
    const store = {
      snapshot: (tables: Parameters<typeof f.store.snapshot>[0]) => {
        const state = f.store.snapshot(tables);
        return {
          ...state,
          knowledge: state.knowledge?.map((row) =>
            row.id === "agent" ? { ...row, verification: "unverified" } : row,
          ),
        };
      },
    } as unknown as typeof f.store;
    const text = String(siteNotes(store, threadId, "https://shop.example.test/")?.text);
    expect(text).not.toContain("Note first");
    expect(text).toContain("- Note second: About second.");
    expect(text).toContain("- Note agent (unverified, written by an agent): About agent.");
  } finally {
    f.close();
  }
});

it("keeps the notes within their budget", async () => {
  const { f, note, threadId } = await seeded();
  try {
    for (const id of ["a", "b", "c"])
      note(id, ["site:shop.example.test"], { body: "x".repeat(1100) });
    const text = String(siteNotes(f.store, threadId, "https://shop.example.test/")?.text);
    expect(text.length).toBeLessThanOrEqual(SITE_NOTES_CHARS);
    expect(text.endsWith("…")).toBe(true);
  } finally {
    f.close();
  }
});

it("gives the agent a site's notes on landing, once a run, after a one-time tip", async () => {
  const f = await runtimeFixture();
  const root = f.root;
  try {
    let address = "https://shop.example.test/";
    const loads: (() => void)[] = [];
    const page: EnginePage = {
      url: () => address,
      frames: async () => async () => {},
      mouse: async () => {},
      key: async () => {},
      evaluate: async <T>() => undefined as T,
      onClose() {},
      onLoad: (listener) => loads.push(listener),
    };
    const engine: BrowserEngine = {
      async launch() {
        return {
          endpoint: "/tmp/fake.sock",
          pages: () => [page],
          onPage() {},
          onPointer() {},
          async close() {},
        };
      },
    };
    const host = new BrowserHost(engine, undefined, path.join(root, "scratch"));
    host.siteNotes = (_thread, url) =>
      url.includes("shop.example.test")
        ? { site: "shop.example.test", text: "Team notes about shop.example.test: logs out fast." }
        : undefined;
    mkdirSync(path.join(root, "work"), { recursive: true });
    const binding = browserBinding(
      root,
      path.join(root, "work"),
      { mode: "background" },
      undefined,
      true,
    );
    await host.ensure(binding, "thread");
    const land = () => {
      for (const load of loads) load();
    };
    const read = () => {
      const text = readFileSync(notesFile(binding), "utf8");
      rmSync(notesFile(binding));
      return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).text);
    };
    land();
    // One note: the notes, then the tip, so other notes keep their place in the launcher.
    expect(read()).toEqual([
      `Team notes about shop.example.test: logs out fast.\n${SITE_NOTES_TIP}`,
    ]);
    address = "https://shop.example.test/cart";
    land();
    address = "https://news.example.test/";
    land();
    expect(() => readFileSync(notesFile(binding))).toThrow();
    await host.closeAll();
  } finally {
    f.close();
  }
});
