// O2: a voice call with the open chat's agent. The Mac's speech helper listens, a pause sends what
// was said, the reply is read aloud through O1, and talking over it stops it. One call at a time.
import { CallMachine, type CallState, speechText } from "@zoltbot/protocol";
import { createEffect, createRoot, createSignal, on, onCleanup } from "solid-js";
import type { DictationDesktopApi, DictationEvent } from "../../../../shared/dictation";
import { useShortcut } from "../../app-shortcuts";
import type { BotMessage } from "../../data";
import { t } from "../../i18n";
import { showToast } from "../../kit";
import { dictationErrorMessage } from "../Dictation";
import { readingMessageId, setCallChat, stopReading } from "./read-aloud";

export interface CallView {
  botId: string;
  state: CallState;
  muted: boolean;
  startedAt: number;
}

const [view, setView] = createRoot(() => createSignal<CallView | undefined>(undefined));
/** The call in progress, if any. */
export const currentCall = view;
// A call asked for from outside the chat, such as the agent menu; the chat starts it once open.
const [asked, setAsked] = createRoot(() => createSignal<string | undefined>(undefined));
export function requestCall(botId: string): void {
  setAsked(botId);
  // Only for the chat being opened now; a chat that doesn't open never starts a call later.
  setTimeout(() => asked() === botId && setAsked(undefined), 2000);
}
// The sheet saying audio goes to Apple, shown before the first call on a Mac without on-device
// recognition. It resolves true to go ahead.
const [notice, setNotice] = createRoot(() =>
  createSignal<((go: boolean) => void) | undefined>(undefined),
);
export const callNotice = notice;

const TICK_MS = 100;

interface Active {
  botId: string;
  machine: CallMachine;
  api: DictationDesktopApi;
  locale: string;
  startedAt: number;
  sessionId?: string;
  generation: number;
  timer: ReturnType<typeof setInterval>;
  unsubscribe: () => void;
}
let active: Active | undefined;
// A call waiting on permission or the Apple sheet; ending or leaving the chat drops it.
let pending: { botId: string } | undefined;

const dictation = () =>
  (window.openbot as { dictation?: DictationDesktopApi } | undefined)?.dictation;
const granted = (s: { microphone: string; speech: string }) =>
  s.microphone === "authorized" && s.speech === "authorized";

function update(call: Active) {
  if (active !== call) return;
  setView({
    botId: call.botId,
    state: call.machine.state,
    muted: call.machine.muted,
    startedAt: call.startedAt,
  });
}

/** Starts a fresh recognition session; words already sent or spoken aren't heard again. */
async function listen(call: Active) {
  if (active !== call || call.machine.muted || call.machine.state === "ended") return;
  const generation = ++call.generation;
  const old = call.sessionId;
  call.sessionId = undefined;
  if (old) void call.api.cancel(old).catch(() => undefined);
  try {
    const started = await call.api.start({ source: "microphone", locale: call.locale });
    if (active !== call || generation !== call.generation || call.machine.muted) {
      void call.api.cancel(started.sessionId).catch(() => undefined);
      return;
    }
    call.sessionId = started.sessionId;
  } catch {
    if (active !== call || generation !== call.generation) return;
    showToast({ message: t("call.failed") });
    endCall();
  }
}

function heard(call: Active, event: DictationEvent) {
  if (active !== call || event.sessionId !== call.sessionId) return;
  const now = Date.now();
  if (event.kind === "partial") call.machine.heard(event.text ?? "", now);
  else if (event.kind === "final") call.machine.final(event.text ?? "", now);
  else if (event.kind === "error") {
    showToast({ message: dictationErrorMessage(event) });
    endCall();
  } else if (event.reason === "superseded") {
    // Dictation into the composer took the microphone: the owner chose to type by voice instead.
    endCall();
  } else {
    // The session ended on its own, such as at its time limit: keep listening.
    call.sessionId = undefined;
    void listen(call);
  }
}

async function permitted(api: DictationDesktopApi) {
  let status = await api.status();
  if (!status.available) throw new Error(dictationErrorMessage({ code: "recognizer_unavailable" }));
  if (!granted(status)) status = await api.requestPermission();
  if (!granted(status)) throw new Error(dictationErrorMessage({ code: "permission_denied" }));
  if (!status.onDevice) {
    const preferences = window.openbot?.preferences;
    const seen = await preferences
      ?.get()
      .then((p) => p.callNoticeSeen)
      .catch(() => false);
    if (!seen) {
      const go = await new Promise<boolean>((resolve) => setNotice(() => resolve));
      setNotice(undefined);
      if (!go) return undefined;
      void preferences?.set({ callNoticeSeen: true }).catch(() => undefined);
    }
  }
  return status;
}

export async function startCall(botId: string): Promise<void> {
  if (active?.botId === botId || pending?.botId === botId) return;
  endCall();
  const api = dictation();
  if (!api) return;
  const mine = { botId };
  pending = mine;
  let status: Awaited<ReturnType<typeof permitted>>;
  try {
    status = await permitted(api);
  } catch (error) {
    if (pending === mine)
      showToast({ message: error instanceof Error ? error.message : t("call.failed") });
    return;
  } finally {
    // Not the start still wanted: ended, or another chat opened meanwhile.
    if (pending !== mine) status = undefined;
    else pending = undefined;
  }
  if (!status || active) return;
  const call: Active = {
    botId,
    api,
    locale: status.locale,
    startedAt: Date.now(),
    generation: 0,
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    unsubscribe: () => undefined,
    machine: new CallMachine({
      send: (text, first) => {
        void window.openbot.agent
          .sendMessage({ botId, text, attachmentDraftIds: [], call: { first } })
          .catch((error: unknown) =>
            showToast({ message: error instanceof Error ? error.message : t("call.sendFailed") }),
          );
      },
      stopSpeaking: stopReading,
      restart: () => void listen(call),
      changed: () => update(call),
    }),
  };
  active = call;
  call.unsubscribe = api.onEvent((event) => heard(call, event));
  call.timer = setInterval(() => call.machine.tick(Date.now()), TICK_MS);
  setCallChat(botId);
  update(call);
  await listen(call);
}

export function toggleMute(): void {
  const call = active;
  if (!call) return;
  if (call.machine.muted) {
    call.machine.unmute();
    return;
  }
  call.machine.mute();
  call.generation++;
  const id = call.sessionId;
  call.sessionId = undefined;
  if (id) void call.api.cancel(id).catch(() => undefined);
}

/** Drops a call still waiting to start, closing the Apple sheet if it's up. */
function cancelPending(): void {
  if (!pending) return;
  pending = undefined;
  notice()?.(false);
}

export function endCall(): void {
  cancelPending();
  const call = active;
  if (!call) return;
  active = undefined;
  call.machine.end();
  clearInterval(call.timer);
  call.unsubscribe();
  if (call.sessionId) void call.api.cancel(call.sessionId).catch(() => undefined);
  setCallChat(undefined);
  stopReading();
  setView(undefined);
  const endedAt = Date.now();
  if (endedAt - call.startedAt >= 1000)
    void window.openbot.voice
      .logCall({
        botId: call.botId,
        startedAt: new Date(call.startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
      })
      .catch(() => undefined);
}

/**
 * Runs calls for the open chat: starts one asked for from the agent menu, tells the call when a
 * reply is read and ends it when the chat changes or closes.
 */
export function followCalls(messages: () => BotMessage[], chat: () => string | undefined): void {
  useShortcut({
    id: "conversation.call",
    keys: "Mod+Shift+V",
    when: "global",
    label: t("call.start"),
    run: () => {
      const id = chat();
      if (!id) return false;
      if (active?.botId === id || pending?.botId === id) endCall();
      else void startCall(id);
      return undefined;
    },
  });
  createEffect(
    on(chat, (id) => {
      if ((active && active.botId !== id) || (pending && pending.botId !== id)) endCall();
    }),
  );
  createEffect(() => {
    const id = asked();
    if (!id || id !== chat()) return;
    setAsked(undefined);
    void startCall(id);
  });
  createEffect(
    on(readingMessageId, (id) => {
      const call = active;
      if (!call) return;
      const message = id ? messages().find((m) => m.id === id) : undefined;
      if (message) call.machine.speaking(speechText(message.body ?? "", navigator.language));
      else call.machine.replyDone();
    }),
  );
  onCleanup(endCall);
}
