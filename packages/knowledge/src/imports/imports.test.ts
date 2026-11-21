// M4: parsers for exports from other assistants, against small synthetic exports.
import { describe, expect, it } from "vitest";
import {
  conversationsText,
  importBatches,
  importLimits,
  parseExport,
  savedMemories,
} from "./index.js";

const files = (entries: Record<string, unknown>) =>
  new Map(Object.entries(entries).map(([path, value]) => [path, JSON.stringify(value)]));

describe("ChatGPT export", () => {
  const conversation = {
    title: "Trip planning",
    update_time: 1_763_000_000,
    current_node: "c",
    mapping: {
      root: { message: null, parent: null },
      a: {
        parent: "root",
        message: { author: { role: "user" }, content: { parts: ["I live in Lisbon."] } },
      },
      old: {
        parent: "a",
        message: { author: { role: "assistant" }, content: { parts: ["An edited-away reply."] } },
      },
      b: {
        parent: "a",
        message: { author: { role: "assistant" }, content: { parts: ["Noted."] } },
      },
      tool: {
        parent: "b",
        message: { author: { role: "tool" }, content: { parts: ["search results"] } },
      },
      c: {
        parent: "tool",
        message: { author: { role: "user" }, content: { parts: ["Plan a weekend."] } },
      },
    },
  };

  it("follows the branch the owner last saw and skips tool output", () => {
    const parsed = parseExport(
      "chatgpt",
      files({ "export/conversations.json": [conversation], "memories.json": ["Prefers metric."] }),
    );
    expect(parsed.conversations).toEqual([
      {
        title: "Trip planning",
        at: new Date(1_763_000_000_000).toISOString(),
        turns: [
          { role: "user", text: "I live in Lisbon." },
          { role: "assistant", text: "Noted." },
          { role: "user", text: "Plan a weekend." },
        ],
      },
    ]);
    expect(parsed.memories).toEqual([{ title: "Prefers metric", body: "Prefers metric." }]);
  });

  it("gives nothing for a file it can't read", () => {
    const parsed = parseExport("chatgpt", new Map([["conversations.json", "not json"]]));
    expect(parsed).toEqual({ source: "chatgpt", memories: [], conversations: [] });
  });

  it("keeps the newest conversations up to the limit", () => {
    const many = Array.from({ length: importLimits.conversations + 20 }, (_, n) => ({
      ...conversation,
      title: `Chat ${n}`,
      update_time: 1_700_000_000 + n,
    }));
    const parsed = parseExport("chatgpt", files({ "conversations.json": many }));
    expect(parsed.conversations).toHaveLength(importLimits.conversations);
    expect(parsed.conversations[0]?.title).toBe(`Chat ${importLimits.conversations + 19}`);
  });
});

describe("Claude export", () => {
  it("reads conversations, saved memories and project knowledge", () => {
    const parsed = parseExport(
      "claude",
      files({
        "conversations.json": [
          {
            name: "Release notes",
            updated_at: "2026-10-01T10:00:00Z",
            chat_messages: [
              { sender: "human", text: "Write them in British English." },
              { sender: "assistant", content: [{ type: "text", text: "Will do." }] },
            ],
          },
          { name: "Empty", chat_messages: [{ sender: "assistant", text: "Hello" }] },
        ],
        "memories.json": [
          {
            uuid: "4f1c-not-a-memory",
            created_at: "2026-10-01T10:00:00Z",
            conversations_memory: "Works on a Mac app called Zoltbot.",
          },
        ],
        "projects.json": [
          {
            name: "Website",
            description: "The marketing site.",
            prompt_template: "Use short sentences.",
            docs: [{ filename: "voice.md", content: "Friendly, plain words." }],
          },
        ],
      }),
    );
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]?.turns).toEqual([
      { role: "user", text: "Write them in British English." },
      { role: "assistant", text: "Will do." },
    ]);
    expect(parsed.memories.map((memory) => memory.title)).toEqual([
      "Works on a Mac app called Zoltbot",
      "Website",
    ]);
    expect(parsed.memories[1]?.body).toBe("The marketing site.\n\nUse short sentences.");
  });
});

describe("Gemini export", () => {
  it("reads each prompt from Takeout activity as a short conversation", () => {
    const parsed = parseExport(
      "gemini",
      files({
        "Takeout/My Activity/Gemini Apps/MyActivity.json": [
          {
            header: "Gemini Apps",
            title: "Prompted How do I keep sourdough starter alive?",
            time: "2026-09-02T08:00:00.000Z",
            safeHtmlItem: [{ html: "<p>Feed it daily &amp; keep it warm.</p>" }],
          },
          { header: "Gemini Apps", title: "Opened Gemini", time: "2026-09-02T07:00:00.000Z" },
        ],
      }),
    );
    expect(parsed.memories).toEqual([]);
    expect(parsed.conversations).toEqual([
      {
        title: "How do I keep sourdough starter alive?",
        at: "2026-09-02T08:00:00.000Z",
        turns: [
          { role: "user", text: "How do I keep sourdough starter alive?" },
          { role: "assistant", text: "Feed it daily & keep it warm." },
        ],
      },
    ]);
    expect(conversationsText(parsed)).toContain("Owner: How do I keep sourdough starter alive?");
  });
});

describe("batches and saved memories", () => {
  it("packs conversations into batches and counts what each covers", () => {
    const conversations = Array.from({ length: 10 }, (_, n) => ({
      title: `Chat ${n}`,
      at: "",
      turns: [{ role: "user" as const, text: "x".repeat(3000) }],
    }));
    const batches = importBatches(conversations, {
      chars: 7000,
      conversationChars: 4000,
      batches: 3,
    });
    expect(batches.map((batch) => batch.conversations)).toEqual([2, 2, 2]);
  });

  it("splits a long list of memories and never reads ids or dates", () => {
    const list = Array.from({ length: 80 }, (_, n) => `- Fact number ${n} about the owner.`).join(
      "\n",
    );
    const memories = savedMemories({ account_uuid: "abc", memories: [list] });
    expect(memories).toHaveLength(80);
    expect(memories[0]?.body).toBe("Fact number 0 about the owner.");
    expect(savedMemories({ account_uuid: "abc", created_at: "2026" })).toEqual([]);
  });
});
