import { describe, expect, it, vi } from "vitest";
import {
  CallMachine,
  callDuration,
  isCallGuidance,
  MAX_CALLS,
  readCalls,
  UTTERANCE_SILENCE_MS,
  VOICE_CALL_GUIDANCE,
  withCall,
} from "./voice-call.js";

function call() {
  const events = {
    send: vi.fn(),
    stopSpeaking: vi.fn(),
    restart: vi.fn(),
    changed: vi.fn(),
  };
  return { machine: new CallMachine(events), events };
}

describe("CallMachine", () => {
  it("sends what was said after an 800 ms pause, not before", () => {
    const { machine, events } = call();
    machine.heard("What changed", 1000);
    machine.heard("What changed in the build", 1400);
    machine.tick(1400 + UTTERANCE_SILENCE_MS - 1);
    expect(events.send).not.toHaveBeenCalled();
    machine.tick(1400 + UTTERANCE_SILENCE_MS);
    expect(events.send).toHaveBeenCalledWith("What changed in the build", true);
    expect(events.restart).toHaveBeenCalledTimes(1);
    expect(machine.state).toBe("waiting");
    // Only the first message of the call carries the guidance.
    machine.heard("And the tests", 3000);
    machine.tick(4000);
    expect(events.send).toHaveBeenLastCalledWith("And the tests", false);
  });

  it("sends at once when the recognizer finishes", () => {
    const { machine, events } = call();
    machine.final("Ship it", 10);
    expect(events.send).toHaveBeenCalledWith("Ship it", true);
  });

  it("stops the reply when the owner talks over it, and ignores its own echo", () => {
    const { machine, events } = call();
    machine.final("Status?", 0);
    machine.speaking("The build passed and the release is ready to go.");
    expect(machine.state).toBe("speaking");
    // The microphone hears the speaker: the reply's own words aren't a barge-in.
    machine.heard("the build passed and", 100);
    machine.heard("release", 200);
    machine.tick(5000);
    expect(events.stopSpeaking).not.toHaveBeenCalled();
    expect(events.send).toHaveBeenCalledTimes(1);
    // New words are.
    machine.heard("wait stop that", 300);
    expect(events.stopSpeaking).toHaveBeenCalled();
    expect(machine.state).toBe("listening");
    machine.tick(300 + UTTERANCE_SILENCE_MS);
    expect(events.send).toHaveBeenLastCalledWith("wait stop that", false);
  });

  it("sends words still pending before the reply plays, so echo isn't sent as the owner's", () => {
    const { machine, events } = call();
    machine.heard("and the tests", 0);
    machine.speaking("All tests pass.");
    expect(events.send).toHaveBeenCalledWith("and the tests", true);
    expect(machine.state).toBe("speaking");
    machine.heard("all tests pass", 100);
    machine.tick(5000);
    expect(events.send).toHaveBeenCalledTimes(1);
  });

  it("judges talking over a long reply by its latest words and sends only the owner's", () => {
    const { machine, events } = call();
    const reply = "one two three four five six seven eight nine ten eleven twelve";
    machine.speaking(reply);
    machine.heard(reply, 100);
    machine.heard(`${reply} stop please now`, 150);
    expect(events.stopSpeaking).not.toHaveBeenCalled();
    machine.heard(`${reply} stop please now, wait`, 200);
    expect(events.stopSpeaking).toHaveBeenCalled();
    machine.tick(200 + UTTERANCE_SILENCE_MS);
    expect(events.send).toHaveBeenCalledWith("stop please now, wait", true);
  });

  it("listens again once the reply ends", () => {
    const { machine, events } = call();
    machine.final("Hi", 0);
    machine.speaking("Hello.");
    machine.replyDone();
    expect(machine.state).toBe("listening");
    expect(events.restart).toHaveBeenCalledTimes(2);
  });

  it("sends what was heard before muting, then hears nothing while muted or after the call ends", () => {
    const { machine, events } = call();
    machine.heard("one last thing", 0);
    machine.mute();
    expect(events.send).toHaveBeenCalledWith("one last thing", true);
    events.send.mockClear();
    machine.heard("secret plans", 0);
    machine.tick(5000);
    expect(events.send).not.toHaveBeenCalled();
    machine.unmute();
    expect(events.restart).toHaveBeenCalled();
    machine.end();
    machine.final("anything", 6000);
    expect(events.send).not.toHaveBeenCalled();
    expect(machine.state).toBe("ended");
  });
});

describe("call guidance and log", () => {
  it("keeps the guidance within a small budget and recognizes it", () => {
    // I9: about four characters a token.
    expect(Math.ceil(VOICE_CALL_GUIDANCE.length / 4)).toBeLessThanOrEqual(30);
    expect(isCallGuidance(` ${VOICE_CALL_GUIDANCE}\n`)).toBe(true);
    expect(isCallGuidance("This is a voice call.")).toBe(false);
  });

  it("keeps the newest calls and formats their length", () => {
    let value: unknown = [{ bad: true }];
    for (let i = 0; i < MAX_CALLS + 2; i++)
      value = withCall(value, {
        id: `c${i}`,
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:01:00Z",
      });
    const calls = readCalls(value);
    expect(calls).toHaveLength(MAX_CALLS);
    expect(calls[0]?.id).toBe("c2");
    expect(callDuration(42_000)).toBe("0:42");
    expect(callDuration(725_000)).toBe("12:05");
    expect(callDuration(3_725_000)).toBe("1:02:05");
  });
});
