import { describe, expect, it } from "vitest";
import { parseVoicePrefs } from "./voice-prefs";

describe("parseVoicePrefs", () => {
  it("starts with the phone's voice at normal speed, not reading new replies", () => {
    expect(parseVoicePrefs(null)).toEqual({
      readNew: false,
      engine: "phone",
      voiceId: "",
      rate: 1,
    });
  });

  it("keeps what was saved", () => {
    const saved = { readNew: true, engine: "elevenlabs", voiceId: "abc123", rate: 1.5 };
    expect(parseVoicePrefs(JSON.stringify(saved))).toEqual(saved);
  });

  it("drops values that aren't settings", () => {
    expect(
      parseVoicePrefs(JSON.stringify({ readNew: "yes", engine: "x", voiceId: "../a", rate: 9 })),
    ).toEqual({ readNew: false, engine: "phone", voiceId: "", rate: 1 });
    expect(parseVoicePrefs("{not json")).toEqual(parseVoicePrefs(null));
  });
});
