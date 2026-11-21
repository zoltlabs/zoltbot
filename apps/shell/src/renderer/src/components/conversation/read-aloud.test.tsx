import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotMessage } from "../../data";
import { createMessageActionsState, MessageActions } from "./MessageActions";
import {
  followNewReplies,
  readingMessageId,
  setVoicePreferences,
  stopReading,
  systemEngine,
} from "./read-aloud";

class Utterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  onend?: () => void;
  onerror?: (event: { error: string }) => void;
  constructor(public text: string) {}
}

function stubSpeech() {
  const spoken: Utterance[] = [];
  const synth = {
    speak: vi.fn((utterance: Utterance) => spoken.push(utterance)),
    cancel: vi.fn(() => {
      for (const utterance of spoken.splice(0)) utterance.onerror?.({ error: "interrupted" });
    }),
    getVoices: () => [{ voiceURI: "ava", name: "Ava", lang: "en-US" }],
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  return { synth, spoken, finish: () => spoken.shift()?.onend?.() };
}

const reply: BotMessage = {
  id: "m1",
  turnId: "t1",
  author: "bot",
  body: "The tests pass.\n\n```sh\nnpm test\n```",
  time: "10:00",
};

beforeEach(() => setVoicePreferences({ readAloud: false, speechEngine: "system", speechRate: 1 }));
afterEach(() => {
  stopReading();
  vi.unstubAllGlobals();
});

describe("Read aloud", () => {
  it("reads a reply from the message menu and stops from its toolbar", async () => {
    const speech = stubSpeech();
    const actions = createMessageActionsState({
      botId: () => "chief",
      onReply: vi.fn(),
      onBranch: vi.fn(),
      onError: vi.fn(),
    });
    render(() => <MessageActions message={reply} actions={actions} />);
    await fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Read aloud" }));
    await waitFor(() => expect(speech.spoken.map((u) => u.text)).toEqual(["The tests pass."]));
    expect(readingMessageId()).toBe("m1");
    await fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    expect(await screen.findByRole("menuitem", { name: "Stop reading" })).toBeTruthy();
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await fireEvent.click(screen.getByRole("button", { name: "Stop reading" }));
    expect(speech.synth.cancel).toHaveBeenCalled();
    await waitFor(() => expect(readingMessageId()).toBeUndefined());
  });

  it("speaks each piece with the chosen voice and speed", async () => {
    const speech = stubSpeech();
    setVoicePreferences({ speechVoice: "ava", speechRate: 1.5 });
    const engine = systemEngine();
    const done = engine.speak("Hello.", new AbortController().signal);
    const utterance = speech.spoken[0];
    expect(utterance?.rate).toBe(1.5);
    expect(utterance?.lang).toBe("en-US");
    speech.finish();
    await done;
  });
});

describe("Read new replies aloud", () => {
  it("reads replies that finish after the chat opens, not its history", async () => {
    const speech = stubSpeech();
    setVoicePreferences({ readAloud: true });
    const old: BotMessage = { ...reply, id: "old", turnId: "t0", body: "Earlier reply." };
    const [messages, setMessages] = createSignal<BotMessage[]>([old]);
    const dispose = createRoot((dispose) => {
      followNewReplies(messages, () => "chat");
      return dispose;
    });
    await Promise.resolve();
    expect(speech.spoken).toEqual([]);
    setMessages([old, { ...reply, id: "new", turnId: "t2", body: "Work", streaming: true }]);
    setMessages([old, { ...reply, id: "new", turnId: "t2", body: "Working on it now." }]);
    await waitFor(() => expect(speech.spoken.map((u) => u.text)).toEqual(["Working on it now."]));
    // A second reply waits for the first.
    setMessages((list) => [
      ...list,
      {
        ...reply,
        id: "next",
        turnId: "t3",
        body: "Done.",
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    expect(speech.spoken).toHaveLength(1);
    speech.finish();
    await waitFor(() => expect(speech.spoken.map((u) => u.text)).toEqual(["Done."]));
    dispose();
  });

  it("stays quiet while the setting is off", async () => {
    const speech = stubSpeech();
    const [messages, setMessages] = createSignal<BotMessage[]>([]);
    const dispose = createRoot((dispose) => {
      followNewReplies(messages, () => "chat");
      return dispose;
    });
    setMessages([{ ...reply, streaming: true }]);
    setMessages([reply]);
    await Promise.resolve();
    expect(speech.spoken).toEqual([]);
    dispose();
  });
});
