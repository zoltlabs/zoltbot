import { describe, expect, it } from "vitest";
import {
  createDictationController,
  type DictationEvent,
  sanitizeContextualStrings,
  sanitizeLocale,
} from "./dictation.js";

const fakeHelperScript = `
const readline = require("node:readline");
let header = null;
let bytes = 0;
process.stdin.on("data", (chunk) => {
  if (!header) {
    const idx = chunk.indexOf(10);
    const line = idx >= 0 ? chunk.subarray(0, idx).toString("utf8") : chunk.toString("utf8");
    header = JSON.parse(line);
    if (header.op === "status" || header.op === "request_permission") {
      process.stdout.write(JSON.stringify({
        ok: true,
        microphone: "authorized",
        speech: "authorized",
        available: true,
        onDevice: header.onDevice !== false,
        locale: header.locale || "en-US",
      }) + "\\n");
      process.exit(0);
    }
    const hints = (header.contextualStrings || []).join(",");
    process.stdout.write(JSON.stringify({
      kind: "partial",
      text: hints ? "Drafting for " + hints : "Drafting message",
    }) + "\\n");
    const rest = idx >= 0 ? chunk.subarray(idx + 1) : Buffer.alloc(0);
    bytes += rest.byteLength;
    return;
  }
  bytes += chunk.byteLength;
  process.stdout.write(JSON.stringify({
    kind: "partial",
    text: "Captured " + bytes + " bytes",
  }) + "\\n");
});
process.stdin.on("end", () => {
  if (header && header.op === "stream") {
    process.stdout.write(JSON.stringify({
      kind: "final",
      text: "Final transcript (" + bytes + " bytes)",
    }) + "\\n");
    process.stdout.write(JSON.stringify({ kind: "stopped" }) + "\\n");
  }
  process.exit(0);
});
`;

describe("dictation controller", () => {
  it("validates locales and strips secret-like or invalid contextual strings", () => {
    expect(sanitizeLocale(undefined)).toBe("");
    expect(sanitizeLocale("en_US")).toBe("en-US");
    expect(sanitizeLocale("fr-CA")).toBe("fr-CA");
    expect(() => sanitizeLocale("en-US; rm -rf /")).toThrow("invalid_dictation_locale");

    expect(
      sanitizeContextualStrings([
        "Composer.tsx",
        "Composer.tsx",
        "x",
        "sk-secret123456789",
        "API_KEY=secret",
        "https://example.com",
        "LaunchManifest",
      ]),
    ).toEqual(["Composer.tsx", "LaunchManifest"]);
  });

  it("queries status, streams partial and final hypotheses, and stops cleanly", async () => {
    const events: DictationEvent[] = [];
    const controller = createDictationController({
      command: process.execPath,
      args: ["-e", fakeHelperScript],
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
    });

    const status = await controller.status({ locale: "en-US" });
    expect(status).toEqual({
      available: true,
      onDevice: true,
      locale: "en-US",
      microphone: "authorized",
      speech: "authorized",
    });

    const { sessionId } = await controller.start({
      locale: "en-US",
      contextualStrings: ["Composer.tsx"],
    });
    await expect
      .poll(() =>
        events.some((e) => e.kind === "partial" && e.text === "Drafting for Composer.tsx"),
      )
      .toBe(true);

    controller.writeAudio(sessionId, new Uint8Array(320));
    await expect
      .poll(() => events.some((e) => e.kind === "partial" && e.text === "Captured 320 bytes"))
      .toBe(true);

    await controller.stop(sessionId);
    expect(
      events.some((e) => e.kind === "final" && e.text === "Final transcript (320 bytes)"),
    ).toBe(true);
    expect(events.at(-1)?.kind).toBe("stopped");
  });

  it("cancels an active session without emitting late final transcripts and fences concurrent starts", async () => {
    const events: DictationEvent[] = [];
    const controller = createDictationController({
      command: process.execPath,
      args: ["-e", fakeHelperScript],
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
    });

    const first = await controller.start({ locale: "en-US" });
    await expect.poll(() => events.some((e) => e.sessionId === first.sessionId)).toBe(true);

    const second = await controller.start({ locale: "en-US" });
    expect(
      events.some(
        (e) => e.sessionId === first.sessionId && e.kind === "stopped" && e.reason === "superseded",
      ),
    ).toBe(true);

    controller.cancel(second.sessionId);
    expect(
      events.some(
        (e) => e.sessionId === second.sessionId && e.kind === "stopped" && e.reason === "cancelled",
      ),
    ).toBe(true);
    expect(events.some((e) => e.sessionId === second.sessionId && e.kind === "final")).toBe(false);
  });
});
