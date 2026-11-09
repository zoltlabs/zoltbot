import { outputModes } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import {
  attachmentBlockReason,
  composerImageMime,
  shouldHandleComposerPaste,
} from "./composer-attachments.js";
import { type ComposerDraft, decodeComposerDraft, encodeComposerDraft } from "./composer-draft.js";
import { composingKey, formatMarkdown } from "./composer-editing.js";

const attachment = {
  path: "/synthetic/image.png",
  name: "image.png",
  image: true,
  bytes: 123,
  mime: "image/png",
  preview: "blob:ephemeral",
  status: "ready" as const,
};
const draft: ComposerDraft = {
  text: "Keep **exact** Markdown\n日本語",
  outputMode: "auto",
  attachments: [attachment],
  attempt: { signature: "synthetic-payload", id: "retry-command" },
};
describe("composer recovery", () => {
  it.each(outputModes)("recovers the real $value output mode with exact text and retry identity", ({
    value,
  }) => {
    const recovered = decodeComposerDraft(encodeComposerDraft({ ...draft, outputMode: value }));
    expect(recovered.text).toBe(draft.text);
    expect(recovered.outputMode).toBe(value);
    expect(recovered.attempt).toEqual(draft.attempt);
    expect(recovered.attachments[0]?.preview).toBeUndefined();
    expect(recovered.attachments[0]?.path).toBe("/synthetic/image.png");
  });
  it("retains completed pasted image data and requires reattachment after interrupted preparation", () => {
    const image = {
      ...attachment,
      path: "image:pasted",
      base64: "aW1hZ2U=",
      status: "ready" as const,
    };
    expect(
      decodeComposerDraft(encodeComposerDraft({ ...draft, attachments: [image] })).attachments[0]
        ?.base64,
    ).toBe(image.base64);
    const interrupted = decodeComposerDraft(
      encodeComposerDraft({
        ...draft,
        attachments: [{ ...image, base64: "", status: "preparing" }],
      }),
    );
    expect(interrupted.attachments[0]?.status).toBe("error");
    expect(attachmentBlockReason(interrupted.attachments, true)).toContain("Retry or remove");
  });
  it.each([
    null,
    "{",
    "null",
    "{}",
    '{"text":12,"attachments":[]}',
    '{"text":"ok","attachments":[],"outputMode":"slides"}',
  ])("handles corrupt or obsolete storage: %s", (raw) => {
    expect(decodeComposerDraft(raw)).toEqual({ text: "", attachments: [], outputMode: "auto" });
  });
  it("drops malformed attachment metadata without losing the text", () => {
    expect(
      decodeComposerDraft(JSON.stringify({ ...draft, attachments: [null, { path: "bad" }] })).text,
    ).toBe(draft.text);
    expect(
      decodeComposerDraft(JSON.stringify({ ...draft, attachments: [null] })).attachments,
    ).toEqual([]);
  });
});
describe("attachment capability and editor boundaries", () => {
  it("classifies generic MIME image files from extensions without overriding an explicit type", () => {
    expect(composerImageMime({ name: "SCREEN.PNG", type: "application/octet-stream" })).toBe(
      "image/png",
    );
    expect(composerImageMime({ name: "data.png", type: "text/plain" })).toBe("text/plain");
    expect(composerImageMime({ name: "notes.md", type: "" })).toBe("");
  });
  it("handles pasted images but preserves text copied beside generic files", () => {
    expect(shouldHandleComposerPaste([{ name: "image.PNG", type: "" }], "caption")).toBe(true);
    expect(
      shouldHandleComposerPaste([{ name: "notes.txt", type: "text/plain" }], "copied text"),
    ).toBe(false);
    expect(shouldHandleComposerPaste([{ name: "notes.txt", type: "text/plain" }], "")).toBe(true);
    expect(shouldHandleComposerPaste([], "text")).toBe(false);
  });
  it("blocks pending images and capability loss even after recovery", () => {
    expect(attachmentBlockReason([{ ...attachment, status: "preparing" }], true)).toContain("Wait");
    expect(attachmentBlockReason(draft.attachments, false)).toContain("not available");
    expect(attachmentBlockReason(draft.attachments, true)).toBe("");
  });
  it("formats selected text without changing the surrounding Markdown", () => {
    expect(formatMarkdown("before hello after", 7, 12, "bold")).toEqual({
      text: "before **hello** after",
      start: 9,
      end: 14,
    });
    expect(formatMarkdown("first\nsecond\nthird", 7, 12, "quote").text).toBe(
      "first\n> second\nthird",
    );
  });
  it("toggles formatting around a selection and inserts a list before a leading newline", () => {
    expect(formatMarkdown("**hello**", 2, 7, "bold")).toEqual({ text: "hello", start: 0, end: 5 });
    expect(formatMarkdown("\nnext", 0, 0, "list").text).toBe("- \nnext");
  });
  it("protects both IME event shapes and active composition sessions", () => {
    expect(composingKey({ isComposing: true }, false)).toBe(true);
    expect(composingKey({ keyCode: 229 }, false)).toBe(true);
    expect(composingKey({}, true)).toBe(true);
    expect(composingKey({}, false)).toBe(false);
  });
});
