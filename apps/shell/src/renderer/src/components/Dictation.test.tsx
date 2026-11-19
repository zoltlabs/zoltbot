import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationDesktopApi, DictationEvent, DictationStatus } from "../../../shared/ipc";
import {
  applyDictationTranscript,
  captureDictationAnchor,
  createDictation,
  DictationButton,
} from "./Dictation";

const ready: DictationStatus = {
  available: true,
  onDevice: true,
  locale: "en-US",
  microphone: "authorized",
  speech: "authorized",
};

function installBridge(status: DictationStatus = ready) {
  let emit: (event: DictationEvent) => void = () => undefined;
  const api = {
    status: vi.fn(async () => status),
    requestPermission: vi.fn(async () => status),
    start: vi.fn(async () => ({ sessionId: "s1" })),
    sendAudio: vi.fn(),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: DictationEvent) => void) => {
      emit = listener;
      return () => undefined;
    }),
  } satisfies DictationDesktopApi;
  (window as unknown as { openbot: unknown }).openbot = { dictation: api };
  return { api, emit: (event: DictationEvent) => emit(event) };
}

function renderComposer(initial = "") {
  const [draft, setDraft] = createSignal(initial);
  render(() => {
    const dictation = createDictation({
      scope: () => "chief",
      draft,
      onDraft: setDraft,
      onError: () => undefined,
    });
    return (
      <Show when={dictation.available()}>
        <DictationButton dictation={dictation} disabled={false} />
      </Show>
    );
  });
  return draft;
}

afterEach(() => {
  (window as unknown as { openbot?: unknown }).openbot = undefined;
});

describe("dictation text", () => {
  it("inserts the transcript at the caret with spacing", () => {
    const anchor = captureDictationAnchor("Hello world", 5);
    expect(applyDictationTranscript(anchor, "there")).toBe("Hello there world");
    expect(applyDictationTranscript(captureDictationAnchor("Hi"), ", friend")).toBe("Hi, friend");
  });
});

describe("DictationButton", () => {
  it("stays hidden when the helper reports dictation unavailable", async () => {
    const { api } = installBridge({ ...ready, available: false });
    renderComposer();
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("streams partial transcripts into the draft and stops on a second click", async () => {
    const { api, emit } = installBridge();
    const draft = renderComposer("Note:");
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(api.start).toHaveBeenCalled());
    const stop = await screen.findByRole("button", { name: "Stop dictation" });
    emit({ sessionId: "s1", kind: "partial", text: "buy milk" });
    expect(draft()).toBe("Note: buy milk");
    fireEvent.click(stop);
    expect(api.stop).toHaveBeenCalledWith("s1");
    emit({ sessionId: "s1", kind: "final", text: "buy milk." });
    emit({ sessionId: "s1", kind: "stopped" });
    expect(draft()).toBe("Note: buy milk.");
    expect(await screen.findByRole("button", { name: "Dictate" })).toBeInTheDocument();
  });

  it("cancels on Escape and restores the draft", async () => {
    const { api, emit } = installBridge();
    const draft = renderComposer("Keep this");
    fireEvent.click(await screen.findByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictation" });
    emit({ sessionId: "s1", kind: "partial", text: "oops" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(draft()).toBe("Keep this");
    expect(api.cancel).toHaveBeenCalledWith("s1");
  });
});
