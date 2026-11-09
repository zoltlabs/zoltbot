import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { acpFactory } from "./acp-conformance-factory.js";
import { claudeFactory } from "./claude-conformance-factory.js";
import { codexFactory } from "./codex-conformance-factory.js";
import { piFactory } from "./pi-conformance-factory.js";

const base64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=";
for (const [provider, factory] of [
  ["claude", claudeFactory],
  ["codex", codexFactory],
  ["pi", piFactory],
  ["acp", acpFactory()],
] as const)
  it(`delivers image paths and file references through the actual ${provider} wire without logging image bytes`, async () => {
    const fixture = await factory("stream");
    try {
      if (!fixture.cwd) throw new Error("fixture_workspace_missing");
      const file = path.join(fixture.cwd, "fixture.png");
      writeFileSync(file, Buffer.from(base64, "base64"));
      await fixture.session.send(
        [
          { type: "text", text: "  Exact text\n" },
          { type: "image", path: file, mimeType: "image/png" },
          { type: "file", path: file },
        ],
        "queue",
      );
      const receipt = path.join(fixture.cwd, "attachment-receipt.json");
      for (let i = 0; i < 200 && !existsSync(receipt); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
        images: 1,
        png: true,
        textPreserved: true,
        fileReference: true,
      });
      expect(await fixture.frameLog()).not.toContain(base64);
    } finally {
      await fixture.dispose();
    }
  });
